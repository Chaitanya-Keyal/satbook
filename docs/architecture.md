# Architecture

Self-hosted, single-user Bitcoin portfolio and India VDA tax tracker.
SvelteKit (Svelte 5 runes) served by the Bun runtime, SQLite via `bun:sqlite`
with Drizzle ORM, Tailwind CSS v4. Deployed as one container with the SQLite
file on a volume.

## Core idea: the ledger is the only source of truth

Every fact lives in one `transactions` table (types: INCOME, BUY, SELL, SPEND,
TRANSFER). Wallet balances, FIFO lots, taxable gains, and the dashboard are all
**derived** — recomputed from the full ledger on every read by a pure function
(`src/lib/server/engine/fifo.ts`). At personal-ledger scale (hundreds of rows)
a full recompute is sub-millisecond, and it means editing or backfilling
history is always safe: there is no stored derived state to corrupt.

Precision rules: BTC amounts are integer satoshis, fiat amounts are integer
minor units (paise/cents), timestamps are unix seconds UTC displayed in IST
(fixed +5:30 arithmetic — never the runtime timezone). Any `a×b/c` on money
goes through a BigInt `mulDivRound` (paise×sats products overflow
`Number.MAX_SAFE_INTEGER` near whole-coin lots).

## Tax engine (India VDA, s.115BBH)

- Flat 30% + 4% cess on gains from every disposal (SELL and SPEND); only cost
  of acquisition is deductible.
- **Global FIFO** cost basis across all wallets. Self-transfers move sats
  between wallets without touching the lot queue or basis (moving your own
  coins is not a transfer under s.2(47)).
- Losses are ring-fenced per s.115BBH(2)(b): each (disposal, lot) row's income
  is `max(0, consideration − cost)`; no set-off, no carry-forward. The net
  figure including losses is shown for reference only.
- Network fees (on transfers and disposals) consume sats from the FIFO queue —
  reducing holdings and silently absorbing their pro-rata cost basis — but are
  never taxable events and never deductible.
- One disposal consuming N lots emits N Schedule-VDA-shaped rows (date of
  acquisition, date of transfer, cost, pro-rated consideration, income),
  exportable per financial year (Apr 1 – Mar 31, IST) as CSV.

## External data

| Need                                               | Primary                                     | Fallbacks                               |
| -------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| Live BTC price (USD, 5-min TTL, fetched on demand) | CoinGecko                                   | Binance, Coinbase, Kraken               |
| Historical BTC price at a timestamp                | Binance 1h klines                           | Coinbase daily spot, CoinGecko (≤365 d) |
| Daily series for the portfolio chart               | Binance 1d klines, backfilled incrementally | —                                       |
| USD/INR and EUR/INR (current + historical)         | Frankfurter (ECB, back to 2009)             | fawazahmed0 currency-api                |
| Txid lookup (Esplora API dialect)                  | blockstream.info                            | mempool.emzy.de, mempool.space          |

**One market convention.** Every BTC price is a global (US-market) quote, and
every INR figure is that USD price × the ECB reference rate for the same date —
including the chart, backdated rate lookups, and the USD equivalents on the
dashboard. Indian-exchange quotes carry a premium (≈3%); mixing them with
global quotes silently distorted the implied USD/INR rate, so they are not used
anywhere. ECB publishes business days only: weekend and holiday dates resolve to
the previous business day.

Historical candles and FX rates are immutable — cached permanently in SQLite,
never refetched. Only fully-elapsed candle periods are stored. All calls are
server-side with short timeouts and provider failover.

## Auth

Single password: argon2id via `Bun.password`, opaque session tokens stored
only as SHA-256 hashes, sliding 30-day expiry with an absolute 90-day cap.
The login limiter charges an attempt slot atomically _before_ verification
(burst-proof) and persists across restarts. First boot reads `ADMIN_PASSWORD`
from the environment, stores the hash, and ignores the variable afterwards —
remove it from your env file once you've logged in.

## Writes

Every create/update/delete parses and validates the draft, then dry-runs the
FIFO engine over the proposed ledger and rejects anything that would make a
wallet balance go negative or consume sats that don't exist — with the error
naming the wallet and date. The same dry-run powers the entry form's live gain
preview (`POST /api/preview`).

## Import

`scripts/import-xlsx.ts` maps a simple Excel sheet (columns: Time (UTC),
Time (IST), Type, Wallet, BTC Amount, INR Value, BTC/INR Rate, BTC/USD Rate,
Transaction ID, Notes) into the ledger: paired transfer rows merge by txid,
fiat amounts embedded in notes ("… - USD 1200") become original-currency
records, wallets are created from the sheet's Wallet column, and re-runs are
idempotent via content-keyed hashes. A dry run prints a full reconciliation
report; `--commit` refuses if the engine reports any issue.
