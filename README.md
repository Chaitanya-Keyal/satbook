# satbook

*a self-hosted passbook for your sats.*

Single-user Bitcoin portfolio tracker and India VDA tax engine. Log every
income, buy, sell, spend, and self-transfer across your wallets; see holdings,
break-even, and unrealized P/L against live prices; and get FIFO
Schedule-VDA-ready tax figures computed the conservative way (s.115BBH: flat
30% + cess, only cost of acquisition deductible, losses ring-fenced, network
fees untaxed and undeducted).

Built with SvelteKit (Svelte 5) on the Bun runtime, SQLite (`bun:sqlite`) +
Drizzle, Tailwind v4. One process, one database file. The transaction ledger is
the single source of truth — balances, FIFO lots, and tax figures are recomputed
from it on every read, so editing or backfilling history always just works.
See [docs/architecture.md](docs/architecture.md).

## Features

- **Fast entry** — enter any two of amount / rate / fiat value and the third
  derives; paste an on-chain txid to autofill timestamp, amounts, and fee from
  a block explorer; backdated entries auto-fetch the historical BTC/INR (and
  USD/EUR→INR) rate; a live FIFO preview shows the taxable gain before you save
  a disposal.
- **Exchange buys** — one entry records a purchase on an exchange *and* the
  delayed withdrawal to self-custody (with its txid), matching how Indian
  exchanges actually pay out.
- **Wallets** — per-wallet balances, transfer history with network fees, saved
  addresses that auto-match your outputs during txid autofill.
- **Tax center** — per-FY conservative filing number with per-lot Schedule VDA
  rows, the informational net-including-losses figure, a FIFO lot queue
  visualization, and CSV export.
- **Multi-currency** — non-INR amounts convert once at entry with an editable
  fetched rate; the original currency is preserved.

## Development

```sh
bun install
cp .env.example .env         # set ADMIN_PASSWORD (first boot only)
bun run dev                  # vite under the Bun runtime (bun:sqlite needs it)
bun run test                 # bun:test under TZ=America/New_York (proves IST math is TZ-independent)
bun run check                # svelte-check
```

SQLite lives at `data/btc.db` (gitignored); migrations run on boot. A free
CoinGecko demo key in `COINGECKO_DEMO_KEY` raises price-poll limits (optional —
keyless fallbacks work).

## Importing an existing spreadsheet

If you've been tracking in Excel, `scripts/import-xlsx.ts` maps a sheet named
`Transactions` with columns `Time (UTC)`, `Time (IST)`, `Type`
(INCOME/BUY/SELL/SPEND/TRANSFER), `Wallet`, `BTC Amount` (signed), `INR Value`,
`BTC/INR Rate`, `BTC/USD Rate`, `Transaction ID`, `Notes`. Transfers may be
paired +/- rows sharing a txid (they merge, fee rows included); fiat amounts in
notes like `… - USD 1200` become original-currency records; wallets are created
from the sheet.

```sh
bun scripts/import-xlsx.ts your-sheet.xlsx            # dry-run + reconciliation report
bun scripts/import-xlsx.ts your-sheet.xlsx --commit   # write (refuses on any engine issue)
```

## Tax model (read before filing)

- Global FIFO cost basis across wallets — the prevailing practice for VDAs,
  not a statutory mandate.
- Each disposal is taxed independently at 30% + 4% cess; losses are floored to
  zero per disposal (s.115BBH(2)(b): no set-off, no carry-forward). The app
  also shows the net figure for reference.
- Only cost of acquisition is deductible; exchange and network fees are not.
- Self-transfers are not disposals; network fees reduce holdings via the FIFO
  queue but create no taxable event.
- No TDS (s.194S) tracking — reconcile TDS credits via 26AS/AIS.
- Not tax advice; confirm with a CA before filing.

## Deploying

Designed for a small VPS (prefer Singapore/EU regions — some price providers
are geo-blocked from US IPs and intermittently blocked by Indian ISPs).
`Dockerfile` and `docker-compose.yml` are provided as reference:

1. Create `.env`: `ADMIN_PASSWORD` (first boot only), `ORIGIN`
   (e.g. `https://satbook.example.com`, required for form CSRF),
   optional `COINGECKO_DEMO_KEY`.
2. `docker compose up -d --build` — SQLite on the `btcdata` volume, migrations
   on boot.
3. TLS via Caddy/nginx in front (`reverse_proxy 127.0.0.1:3000`).
4. **After first login, remove `ADMIN_PASSWORD` from `.env`** — the hash lives
   in the DB; the variable is ignored afterwards but stays readable via
   `docker inspect` until removed. Change the password later in Settings.
5. Back up the DB file nightly (`VACUUM INTO` a copy, rsync it offsite) — the
   DB is the product.
6. Optional hardening: bind the port to a WireGuard/Tailscale interface instead
   of exposing it publicly.
