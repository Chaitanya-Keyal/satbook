#!/usr/bin/env bash
# Restore satbook's database from a backup file (one written by backup.sh, or a
# database built locally, e.g. by the spreadsheet import).
#
# Stops the app, checks the file, sets the current database aside as
# btc.db.before-restore-<time> (its write-ahead log folded in first), swaps the
# backup in, drops any leftover -wal/-shm so the old log can never be replayed
# into the new file, and starts the app again. The app is restarted even when
# the restore is refused.
#
# Run it from the folder that holds your compose file:
#   cd ~/satbook-deploy && ~/satbook/deploy/restore.sh ~/satbook-backups/btc-2026-01-31.db
#
# Environment (optional):
#   DOCKER  the docker command (default docker, e.g. "sudo docker")
set -euo pipefail

file=${1:?usage: restore.sh <backup.db>}
[ -r "$file" ] || {
	echo "restore.sh: cannot read $file" >&2
	exit 1
}
DOCKER=${DOCKER:-docker}
SERVICE=app

compose() { $DOCKER compose "$@"; }
# A one-off container on the app's image and data volume, for while the app is stopped.
oneoff() { compose run --rm --no-deps -T "$@"; }

compose stop "$SERVICE"
trap 'compose start "$SERVICE" >/dev/null' EXIT

# Copy the file into the data volume next to the live database.
oneoff --entrypoint sh "$SERVICE" -c 'cat > /data/.restore-incoming.db' <"$file"

oneoff -e STAMP="$(date +%Y%m%d-%H%M%S)" --entrypoint bun "$SERVICE" -e '
	const { Database } = require("bun:sqlite");
	const fs = require("node:fs");
	const db = process.env.DATABASE_PATH ?? "/data/btc.db";
	const incoming = "/data/.restore-incoming.db";
	try {
		const c = new Database(incoming, { readonly: true });
		const check = Object.values(c.query("PRAGMA integrity_check").get())[0];
		if (check !== "ok") throw new Error(`the backup fails integrity_check: ${check}`);
		const { n } = c.query("SELECT count(*) AS n FROM transactions").get();
		c.close();
		for (const suffix of ["-wal", "-shm"]) fs.rmSync(incoming + suffix, { force: true });
		if (fs.existsSync(db)) {
			const current = new Database(db);
			current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			current.close();
			fs.renameSync(db, `${db}.before-restore-${process.env.STAMP}`);
		}
		for (const suffix of ["-wal", "-shm"]) fs.rmSync(db + suffix, { force: true });
		fs.renameSync(incoming, db);
		console.log(`restored ${n} transactions; the previous database is ${db}.before-restore-${process.env.STAMP}`);
	} catch (e) {
		fs.rmSync(incoming, { force: true });
		console.error(`restore refused: ${e.message ?? e}`);
		process.exit(1);
	}
'

compose start "$SERVICE"
trap - EXIT
for _ in $(seq 1 30); do
	if compose exec -T "$SERVICE" bun -e 'fetch(`http://localhost:${process.env.PORT ?? 3000}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
		echo "app is up"
		exit 0
	fi
	sleep 2
done
echo "restore.sh: the app did not come back healthy; check: $DOCKER compose logs $SERVICE" >&2
exit 1
