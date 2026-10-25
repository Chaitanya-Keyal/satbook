# Self-hosting satbook

satbook is one Bun process and one SQLite file. Running it means building the
image, giving it a volume for the database, and deciding who can reach it.

| Setup                                     | Reachable from                       | Files                                     |
| ----------------------------------------- | ------------------------------------ | ----------------------------------------- |
| [Tailnet-only](#tailnet-only) (preferred) | your devices on your Tailscale net   | `deploy/tailscale/`                       |
| [Public](#public-behind-a-reverse-proxy)  | anywhere, through your reverse proxy | `docker-compose.yml` + Caddy, nginx, etc. |
| [Local](#local-only)                      | this machine                         | `docker-compose.yml`, or `bun run dev`    |

Tailnet-only is the default recommendation. satbook holds your whole financial
history behind a single password, and there is one login limiter for that
single account: five wrong passwords lock the login for everyone for fifteen
minutes. On a public URL a stranger can keep you locked out; on a tailnet
nobody else ever sees the login page, and Tailscale supplies the HTTPS
certificate.

## What you need

- Docker Engine with Compose v2.24 or newer, on x86-64 or ARM64.
- Outbound HTTPS from the server (see [What satbook sends out](#what-satbook-sends-out)).
  The build also downloads SheetJS from `cdn.sheetjs.com`.
- For tailnet-only: a Tailscale account with **MagicDNS** and **HTTPS
  certificates** enabled (admin console → DNS).

## Tailnet-only

Two containers. `ts` runs Tailscale; `app` runs satbook inside `ts`'s network
namespace (`network_mode: service:ts`), so nothing is published on the host.
`tailscale serve` answers on port 443 with a `*.ts.net` certificate and passes
requests to the app on `127.0.0.1:3000`. The app listens on loopback only
(`HOST=127.0.0.1`), so other users of the host can't reach it through the
container's Docker bridge address either.

1. **Prepare the tailnet.** Merge
   [`deploy/tailscale/acl.example.hujson`](../deploy/tailscale/acl.example.hujson)
   into your policy (admin console → Access controls). It is required, not
   optional hardening — see [The tailnet policy](#the-tailnet-policy). Then
   create an auth key (Settings → Keys): one-off, not reusable, with the tag
   `tag:satbook`.

2. **Get the code and a deploy folder.** The deploy folder holds your
   instance's config and secrets, so keep it outside the checkout:

   ```sh
   git clone https://github.com/Chaitanya-Keyal/satbook.git ~/satbook
   cp -r ~/satbook/deploy/tailscale ~/satbook-deploy
   cd ~/satbook-deploy
   cp .env.example .env && cp ts.env.example ts.env && chmod 600 .env ts.env
   ```

   In `compose.yml`, point `build:` at the checkout (`../satbook` for the
   layout above). In `.env`, set `ADMIN_PASSWORD` and
   `ORIGIN=https://satbook.<your-tailnet>.ts.net`. Your tailnet's DNS name is
   on the DNS page. In `ts.env`, set `TS_AUTHKEY`.

3. **Start it.**

   ```sh
   docker compose up -d --build
   docker compose logs ts    # the device logs in and the serve config is applied
   docker compose logs app   # "admin password hash stored from ADMIN_PASSWORD"
   ```

4. **Log in** at `https://satbook.<your-tailnet>.ts.net`. The first request
   fetches the certificate and can take a few seconds.

5. **Remove the first-boot secrets.** Delete the `ADMIN_PASSWORD` line from
   `.env`, delete `ts.env`, then run `docker compose up -d` so the containers
   are recreated without them. The password hash and the Tailscale login are
   already saved in their volumes.

A tagged device never has its key expire. If you use an untagged device, it
has to log in again every 180 days unless you turn off key expiry for it in the
admin console.

**Logging in without an auth key.** Leave out `ts.env`. Tailscale's container
then prints a login URL (`docker compose logs -f ts`), but it gives up after a
minute and prints a new one. If that's too quick, do the first login in a
one-off container that waits for as long as you need:

```sh
docker compose run --rm --entrypoint sh ts -c \
  'tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale & sleep 3; tailscale up --hostname=satbook'
docker compose up -d --build
```

### The tailnet policy

In userspace mode, the sidecar's default, Tailscale accepts connections for
**every port** the app container listens on, not only the 443 that `serve`
puts HTTPS on. Under the default "allow everything" policy, any device on your
tailnet can reach satbook over plain HTTP at
`http://satbook.<your-tailnet>.ts.net:3000`. The example policy narrows that to
HTTPS only:

- it tags the device `tag:satbook` and allows your devices `tag:satbook:443`;
- it keeps `autogroup:self` for your own untagged devices, a group that never
  includes tagged ones.

The tag is what makes the policy bind. An untagged device that you own falls
under `autogroup:self` and stays open on every port. If you did not use a
tagged auth key, tag the device later from its menu in the admin console.

To check it, from another device:

```sh
curl -m 5 https://satbook.<your-tailnet>.ts.net/healthz       # ok
curl -m 5 http://satbook.<your-tailnet>.ts.net:3000/healthz   # should time out
```

The device name ends up in the public Certificate Transparency logs when its
certificate is issued. People can learn the name, but they still can't reach
the device.

### Restarting

`app` shares the network of `ts` as it was when the app started. If `ts`
restarts on its own (a crash, or a `docker restart` of it), it comes back with
a new network and the app stays on the old, dead one. The site then answers
502, while `docker compose ps` still shows the app up and healthy, because its
health check runs inside that dead network too. Restart the app to put it back:

```sh
docker compose restart app
```

Don't restart the whole stack with a bare `docker compose restart`. It restarts
every container at once, so the app can start before `ts` is back and end up
stopped or cut off. Recreate it in order instead:

```sh
docker compose up -d --force-recreate
```

A plain `docker compose up -d` recreates the app whenever it recreates `ts`,
for example after you change the Tailscale image, so upgrades are safe. It
doesn't repair a stack that is already cut off, because nothing in it changed.
To recover from a `ts` crash automatically, run a job on the host that restarts
`app` whenever `ts` has started after it.

## Public, behind a reverse proxy

The repo's `docker-compose.yml` publishes the app on `127.0.0.1:3000` only. Put
a TLS reverse proxy in front of it, for example with Caddy:

```caddyfile
satbook.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Create `.env` in the checkout with `ADMIN_PASSWORD` and
`ORIGIN=https://satbook.example.com`, run `docker compose up -d --build`, log
in, then do step 5 above (`ts.env` doesn't apply here). Remember the lockout
caveat at the top. If you can, also restrict the proxy to the IPs you use.

## Local only

For development, run `bun run dev` and open `http://localhost:5173`; see the
README. To try the production image, run `docker compose up -d --build` with
`ORIGIN=http://localhost:3000` and open that URL. Browsers accept the secure
session cookie on `localhost`.

## Password

- `ADMIN_PASSWORD` is read only while the database has no password. It is
  hashed with argon2id into the database and ignored after that.
- Change it under Settings (8 characters minimum). Changing it signs out every
  session.
- Five failed logins within fifteen minutes lock the login for fifteen minutes.
- If you forget the password, delete the stored hash and every session, then
  boot with `ADMIN_PASSWORD` again:

  ```sh
  docker compose exec -T app bun -e "$(cat <<'EOF'
  const db = new (require('bun:sqlite').Database)(process.env.DATABASE_PATH);
  db.exec("DELETE FROM settings WHERE key = 'password_hash'; DELETE FROM sessions; DELETE FROM login_attempts;");
  EOF
  )"
  # add ADMIN_PASSWORD to .env, then:
  docker compose up -d --force-recreate app
  # log in, remove ADMIN_PASSWORD again, and run docker compose up -d
  ```

## Backups

The database is the product. It runs in WAL mode, so copying the file while the
app is running can capture it half-written. Use
[`deploy/backup.sh`](../deploy/backup.sh) instead. It:

- takes a consistent copy with `VACUUM INTO` inside the container;
- runs `PRAGMA integrity_check` on the copy;
- saves it as `btc-YYYY-MM-DD.db` in `BACKUP_DIR` (default `~/satbook-backups`);
- deletes copies older than `KEEP_DAYS` (default 30).

Run it from the deploy folder, by hand or nightly from cron:

```sh
cd ~/satbook-deploy && ~/satbook/deploy/backup.sh
# crontab -e
30 2 * * * cd ~/satbook-deploy && ~/satbook/deploy/backup.sh >> ~/satbook-backups/backup.log 2>&1
```

To keep a copy off the server, set `AGE_RECIPIENT` to an
[age](https://age-encryption.org) public key. Each run then also writes
`btc-latest.db.age`, which is safe to sync anywhere, for example with rclone.
Keep the matching identity off the server. If your user needs `sudo` for
Docker, set `DOCKER="sudo docker"`.

## Restore

```sh
cd ~/satbook-deploy && ~/satbook/deploy/restore.sh ~/satbook-backups/btc-2026-01-31.db
```

[`deploy/restore.sh`](../deploy/restore.sh) does the following, in order:

1. Stops the app.
2. Checks the backup (integrity, and that it is a satbook database).
3. Folds the current database's write-ahead log into it and sets it aside in
   the volume as `btc.db.before-restore-<time>`.
4. Swaps the backup in and deletes any leftover `-wal`/`-shm` files, so the old
   log can't be replayed into the new database.
5. Starts the app and waits until it is healthy.

If the backup fails the check, nothing is swapped and the app starts again on
the database it had. When you're happy with the result, delete the set-aside
copies:

```sh
docker compose exec app sh -c 'rm /data/btc.db.before-restore-*'
```

The same script **moves data between machines**: back up on the old server and
restore on the new one. It also handles a database built locally with the
[spreadsheet import](../README.md#importing-an-existing-spreadsheet): copy
`data/btc.db` to the server and restore it.

## Upgrades

```sh
cd ~/satbook-deploy
~/satbook/deploy/backup.sh       # migrations only move forward
git -C ~/satbook pull
docker compose up -d --build     # migrations run on boot
docker compose ps                # app should turn "healthy"
docker compose logs --tail 50 app
```

To roll back, check out the previous version, rebuild, and restore the backup
you took before upgrading. Older code can't open a database after a newer
version has migrated it.

**Nothing runs as root.** The app runs as the image's `bun` user (uid 1000).
In `deploy/tailscale/` the Tailscale container runs as `TS_UID` (default
10000), and a one-off `owners` job hands it its state on every start. Both
containers there also get a read-only root, no Linux capabilities, and CPU and
memory caps. For the app, that needs two things:

- **The data volume must be writable by it.** A new volume already is. One
  created by an older image (which ran as root) is not, so give it to that user
  once, before starting the new image. Use a plain `docker run`: a hardened
  service has no capability to change owners, even as root.

  ```sh
  docker run --rm --user root -v satbook_btcdata:/data --entrypoint chown satbook-app -R 1000:1000 /data
  ```

  (`docker volume ls` shows the volume's name.) A `chown` on an empty volume
  doesn't stick, because Docker copies the image's ownership back in while it's
  empty, but an empty volume doesn't need one.

- **Secret files must be readable by it.** These are what the `*_FILE`
  settings mount. Either give them to uid 1000 (keep them mode 600), or set
  `user: "<uid>:<gid>"` on the `app` service to run as the account that owns
  them, and use that uid in the `chown` above.

## Operations

- `docker compose ps` shows health from `GET /healthz`, which answers `ok`
  without a login. In the tailnet setup a healthy app can still be unreachable
  after `ts` restarts; see [Restarting](#restarting).
- `docker compose logs -f app` follows the logs.
- The database is `/data/btc.db` in the `btcdata` volume (named
  `satbook_btcdata` on the host). While the app runs it has `-wal` and `-shm`
  files next to it.

## Configuration

| Variable             | Default                                     | Notes                                                                                                             |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`     | —                                           | First boot only; remove it afterwards.                                                                            |
| `ORIGIN`             | —                                           | Required in production: the exact URL you open, with scheme. Form submissions from any other origin are rejected. |
| `COINGECKO_DEMO_KEY` | —                                           | Optional free CoinGecko key; raises live-price rate limits.                                                       |
| `DATABASE_PATH`      | `data/btc.db` (`/data/btc.db` in the image) |                                                                                                                   |
| `MIGRATIONS_PATH`    | `./drizzle` (`/app/drizzle` in the image)   |                                                                                                                   |
| `PORT`               | `3000`                                      | Leave it at 3000 in Docker: `serve.json` and the compose port mapping assume it.                                  |
| `NODE_ENV`           | `production` in the image                   | Marks the session cookie `Secure`, so logins need HTTPS or `localhost`.                                           |

## What satbook sends out

There is no telemetry and no update check. The server makes these requests,
and nothing else. The browser loads nothing from third parties; fonts are
bundled.

- **BTC prices:**
  - Binance, Coinbase, Kraken and CoinGecko, each a fallback for the others.
  - Historical lookups request the price candle around each transaction's time,
    so a provider can see when you transacted, but never how much.
- **INR exchange rates:** Frankfurter (ECB reference rates), with the
  fawazahmed0 currency API on jsDelivr and Cloudflare Pages as fallbacks.
- **Block explorers:**
  - A txid you paste into the entry form is looked up on blockstream.info, then
    mempool.emzy.de, then mempool.space. So is every on-chain txid that
    `scripts/reconcile-chain.ts` checks.
  - Each lookup tells that explorer you're interested in that transaction.

Where you host matters a little:

- Binance refuses US IPs, and satbook falls back to other providers.
- Some Indian ISPs block mempool.space, which is why it is tried last.
