#!/usr/bin/env bash
# Back up satbook's database out of the running app container.
#
# The database is in WAL mode, so copying the file while the app runs can catch
# it mid-write; this takes a consistent copy with VACUUM INTO instead, checks
# it, files it as btc-YYYY-MM-DD.db (one per day, a re-run replaces it) and
# prunes copies older than KEEP_DAYS. With AGE_RECIPIENT set it also leaves an
# age-encrypted copy of the newest backup at btc-latest.db.age, ready to ship
# offsite.
#
# Run it from the folder that holds your compose file:
#   cd ~/satbook-deploy && ~/satbook/deploy/backup.sh
# Nightly, from cron:
#   30 2 * * * cd ~/satbook-deploy && ~/satbook/deploy/backup.sh >> ~/satbook-backups/backup.log 2>&1
#
# Environment (all optional):
#   BACKUP_DIR     where copies go                  (default ~/satbook-backups)
#   KEEP_DAYS      delete copies older than this    (default 30)
#   AGE_RECIPIENT  age public key for the encrypted copy
#   DOCKER         the docker command               (default docker, e.g. "sudo docker")
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-$HOME/satbook-backups}
KEEP_DAYS=${KEEP_DAYS:-30}
DOCKER=${DOCKER:-docker}
SERVICE=app

compose() { $DOCKER compose "$@"; }
log() { echo "$(date -Is) $*"; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# A scratch file inside the container's data volume, removed again below.
inside="/data/.backup-$$.db"

# VACUUM INTO, then integrity-check the copy before it leaves the container.
compose exec -T -e OUT="$inside" "$SERVICE" bun -e '
	const { Database } = require("bun:sqlite");
	const out = process.env.OUT;
	new Database(process.env.DATABASE_PATH ?? "/data/btc.db").query("VACUUM INTO ?").run(out);
	const copy = new Database(out, { readonly: true });
	const check = Object.values(copy.query("PRAGMA integrity_check").get())[0];
	if (check !== "ok") {
		console.error(`integrity_check: ${check}`);
		process.exit(1);
	}
	const { n } = copy.query("SELECT count(*) AS n FROM transactions").get();
	console.log(n);
' >"$tmp/rows" || {
	compose exec -T "$SERVICE" rm -f "$inside" || true
	log "FAIL: could not take a consistent copy (see above)"
	exit 1
}

# Stream the copy out (owned by whoever runs this script, even under sudo docker).
compose exec -T "$SERVICE" cat "$inside" >"$tmp/btc.db"
compose exec -T "$SERVICE" rm -f "$inside"

day=$(date +%F)
install -m 600 "$tmp/btc.db" "$BACKUP_DIR/btc-$day.db"
find "$BACKUP_DIR" -maxdepth 1 -name 'btc-*.db' -mtime +"$KEEP_DAYS" -delete

note=""
if [ -n "${AGE_RECIPIENT:-}" ]; then
	age -r "$AGE_RECIPIENT" -o "$tmp/btc.db.age" "$tmp/btc.db"
	install -m 600 "$tmp/btc.db.age" "$BACKUP_DIR/btc-latest.db.age"
	note="; encrypted copy updated"
fi

copies=$(find "$BACKUP_DIR" -maxdepth 1 -name 'btc-*.db' | wc -l)
log "OK: btc-$day.db ($(wc -c <"$tmp/btc.db") bytes, $(cat "$tmp/rows") transactions, integrity ok); $copies daily copies$note"
