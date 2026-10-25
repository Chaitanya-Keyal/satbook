# satbook

_a self-hosted passbook for your sats._

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
- **Exchange buys** — one entry records a purchase on an exchange _and_ the
  delayed withdrawal to self-custody (with its txid), matching how Indian
  exchanges actually pay out.
- **Wallets** — per-wallet balances, transfer history with network fees, saved
  addresses that auto-match your outputs during txid autofill.
- **Tax center** — per-FY conservative filing number with per-lot Schedule VDA
  rows, the informational net-including-losses figure, a FIFO lot queue
  visualization, and CSV export.
- **Multi-currency** — non-INR amounts convert once at entry with an editable
  fetched rate; the original currency is preserved.
- **Lightning (optional)** — a receive-only dashboard for your own phoenixd
  node: balance, inbound liquidity and the next top-up's cost, invoices with a
  QR code, every payment with its Lightning Address comment or verified zap
  sender, a review inbox that turns payments into ledger rows (income, transfer
  or spend, liquidity fees included), and a check of the node against the
  ledger. See [docs/lightning.md](docs/lightning.md).

## Development

```sh
bun install
cp .env.example .env         # set ADMIN_PASSWORD (first boot only)
bun run dev                  # vite under the Bun runtime (bun:sqlite needs it)
bun run test                 # bun:test under TZ=America/New_York (proves IST math is TZ-independent)
bun run check                # svelte-check
```

The dev server runs at `http://localhost:5173`. SQLite lives at `data/btc.db`
(gitignored), and migrations run on boot. `ORIGIN` and `PORT` in `.env` only
matter for a production build (`bun run build && bun ./build/index.js`). A free
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

After importing, set each wallet's kind (hot / cold / exchange), layer and
custody from its menu on the Wallets screen (the importer makes every wallet a
hot, on-chain, self-custodied one), then reconcile against the chain — it verifies every row that carries a
txid, splits network fees out of disposal amounts, checks transfer fees, and
corrects timestamps to on-chain block time (spreadsheet time columns often
carry a uniform timezone error that no internal check can catch):

```sh
bun scripts/reconcile-chain.ts            # dry-run report
bun scripts/reconcile-chain.ts --commit   # apply; re-run until it reports 0 fixes
```

The whole seed is reproducible: wipe `data/btc.db`, re-import, reconcile.

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

Docker images, two ways to reach the app, and backup, restore and upgrade
scripts. See [docs/self-hosting.md](docs/self-hosting.md). In short:

- **Tailnet-only (recommended):** `deploy/tailscale/` runs the app inside a
  Tailscale sidecar. Nothing is published on the host, and HTTPS comes from
  `tailscale serve`.
- **Public:** the root `docker-compose.yml` binds `127.0.0.1:3000` for a TLS
  reverse proxy you run.
- **Backups:** `deploy/backup.sh` takes a consistent copy of the live database
  nightly; `deploy/restore.sh` swaps one back in.
