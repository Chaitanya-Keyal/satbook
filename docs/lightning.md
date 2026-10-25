# Lightning (optional)

satbook can act as the dashboard for a self-custodial Lightning node running
[phoenixd](https://phoenix.acinq.co/server). [LNbits](https://lnbits.com) in
front of the node can serve a Lightning Address. satbook **reads** the node and
creates invoices on it, but **never pays from it**. Sends and sweeps stay with
phoenixd's own command line; satbook records them once they happen.

The module is off unless `PHOENIXD_URL` is set. Nothing changes for a satbook
without a node.

## What you get

`/lightning` shows:

- **The node:** balance (with its INR value), any fee credit, and on-chain
  deposits still being swapped in.
- **Receivable:** how much the channel can still take in before phoenixd has to
  buy more inbound liquidity.
- **Next top-up:** what the next liquidity purchase would cost for the
  2,000,000-sat block alone, as quoted by the node. The payment that sets it
  off is bought too, so it adds 1% of itself; the receive card quotes the whole
  thing for a given amount.
- **Ledger check:** the satbook wallet that stands for the node, checked against
  the node's balance plus fee credit. Lightning moves millisatoshis while both
  sides count whole sats, so a 1-sat gap is shown as rounding, not as a
  mismatch.
- **Activity:** every payment in and out. Each one shows the Lightning Address
  comment or the zap sender and message, any liquidity fee, and whether it is
  already in the ledger.
- **Receive:** create an invoice (an amount, or any amount, and what it is
  for). It shows as a QR code and flips to _paid_ when it is; the payment then
  waits in the review inbox like any other. Invoices come straight from
  phoenixd, so LNbits never sees them. As you type an amount, the card says
  what receiving it would cost:
  - nothing, if it fits in what the channel can still take in;
  - otherwise, the liquidity purchase it sets off (the 2M block plus the
    payment), its fee and what you'd keep;
  - or a warning, if the payment is small enough to end up as fee credit.
- **Your Lightning Address,** with a QR code.

Settings → Lightning lets you choose or create the node's wallet. _Test
connection_ checks the node and LNbits, and reports which phoenixd password
satbook holds.

## Configuration

| Variable                        | Required    | What                                                                                                                                          |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHOENIXD_URL`                  | yes         | phoenixd's HTTP API, e.g. `https://pay.<your-tailnet>.ts.net:9740`                                                                            |
| `PHOENIXD_PASSWORD` or `_FILE`  | yes         | phoenixd's **`http-password-limited-access`** from `phoenix.conf`. It can read and create invoices but cannot pay, send or close channels.    |
| `LNBITS_URL`                    | no          | LNbits, if it fronts the node; it adds payer comments and zaps                                                                                |
| `LNBITS_INVOICE_KEY` or `_FILE` | with LNbits | the **invoice/read** key of the LNbits wallet behind your Lightning Address, never the admin key                                              |
| `LIGHTNING_PROXY`               | no          | an HTTP proxy used for these calls only (see [Reaching the node from a tailnet-only satbook](#reaching-the-node-from-a-tailnet-only-satbook)) |
| `LIGHTNING_ADDRESS`             | no          | `name@domain`, shown with a QR code                                                                                                           |

The `_FILE` forms read the secret from a file, such as a Docker secret. Use
_Test connection_ to confirm satbook holds the limited password. With the full
password it would still never pay, but a leak would be far worse.

## The reference setup

This is the setup the module was built for. Any phoenixd that satbook can reach
over HTTP works too.

```
internet ──Funnel──▶ pay node :443  /.well-known/lnurlp/…, LNURLp callback  (LNbits)
tailnet  ──────────▶ pay node :8443 LNbits admin            (your devices)
tailnet  ──────────▶ pay node :9740 phoenixd API            (satbook only)
pay node ──────────▶ ACINQ (the channel peer), an Electrum server
```

- **phoenixd** has a single channel to ACINQ and buys inbound liquidity
  automatically, 2,000,000 sat at a time.
- **LNbits** gets the same limited-access password as satbook, and its LNURLp
  extension serves the Lightning Address, with comments and NIP-57 zaps.
- **Only two paths are public**, through Tailscale Funnel: the Lightning Address
  lookup and the LNURLp callback that creates invoices. The phoenixd API, the
  LNbits admin and satbook itself stay on the tailnet.
- **The full-access password never leaves phoenixd's host.** Sweeps and the odd
  payment go through `phoenix-cli` over SSH.

## Reaching the node from a tailnet-only satbook

The [tailnet deployment](self-hosting.md#tailnet-only) runs Tailscale in
userspace mode. That leaves the app container with no route into the tailnet,
and MagicDNS is off. Tailscale's container can run a small outbound proxy for
it:

```yaml
# compose.yml, on the ts service
environment:
  TS_OUTBOUND_HTTP_PROXY_LISTEN: 127.0.0.1:1055
```

```sh
# satbook's .env
LIGHTNING_PROXY=http://127.0.0.1:1055
PHOENIXD_URL=https://pay.<your-tailnet>.ts.net:9740
```

satbook sends only its phoenixd and LNbits requests through the proxy. The
proxy resolves tailnet names itself. Price and explorer lookups go out as
before.

Your tailnet policy decides who reaches the node. With the node tagged
`tag:pay` and satbook tagged `tag:satbook` (see the sample in
`deploy/tailscale/acl.example.hujson`), merge in:

```hujson
"tagOwners": { "tag:pay": ["autogroup:admin"] },
"grants": [
  // the LNbits admin, for your own devices
  {"src": ["autogroup:member"], "dst": ["tag:pay"], "ip": ["tcp:8443"]},
  // phoenixd's API and LNbits, for satbook
  {"src": ["tag:satbook"], "dst": ["tag:pay"], "ip": ["tcp:9740", "tcp:8443"]},
],
"nodeAttrs": [{"target": ["tag:pay"], "attr": ["funnel"]}],
```

Nothing else should reach `tag:pay` except your own devices on the LNbits admin
port. The node's Tailscale container is also in userspace mode, so every port
inside it is reachable unless the policy says otherwise.

## Bootstrapping liquidity

A new phoenixd has no channel. The first payment that arrives makes it buy
liquidity. It buys **the payment plus 2,000,000 sat**, and pays for it out of
that payment: 1% of the amount bought, plus a channel-creation fee and the
mining fee.

- **A payment smaller than that fee** goes entirely into a non-refundable _fee
  credit_ (capped at 50,000 sat by default). You receive nothing spendable
  until the credit plus a later payment can cover a purchase.
- **So fund the node yourself before the address goes public.** Pay it from
  another wallet you own. Type the amount on `/lightning`'s receive card to see
  what you'd keep, then make the invoice there. Or ask the node directly what a
  purchase costs right now, for your amount plus the 2M:

  ```sh
  # on the node's host, for a 30 000 sat bootstrap
  phoenix-cli estimateliquidityfees --amountSat 2030000
  # {"miningFeeSat": 411, "serviceFeeSat": 21300}
  ```

  Then send that total plus a margin (about 10,000 sat). The quote is at
  today's feerate, but phoenixd pays more than that:
  - **Opening the channel** pays a raised feerate, 1.6–2.5× the quoted mining
    fee.
  - **The fee-credit check** goes further. A payment, plus any credit so far,
    becomes fee credit while it is at most the service fee plus up to 3.8× the
    quoted mining fee. So a payment that only just covers the quote can still
    land in fee credit.

  The receive card accounts for both.

- **In the ledger, that bootstrap is a TRANSFER** from the paying wallet to the
  node's wallet. The amount credited is what arrived. The fee is the node's
  liquidity fee plus the sending wallet's own fee.
- **Later top-ups.** Every sat received uses up a sat of inbound. Sweeping to
  cold storage does not give it back; only sending over Lightning does. After
  roughly 2M sat received, the next payment that doesn't fit buys another 2M,
  and the fee comes out of that payment. In the ledger that payment is an
  INCOME with a _fee taken on arrival_: the amount is what the payer sent, and
  the fee is consumed untaxed. _Receivable_ on the dashboard shows how far off
  that is.

## How satbook reads the node

- **Pull only.** When you open `/lightning`, at most once a minute, or when you
  press _Sync now_, satbook asks phoenixd for new payments. phoenixd never
  connects to satbook, and there is no webhook to secure.
- **What it keeps.** Payments are copied into satbook's own database, per node.
  A testnet node and a mainnet node never mix, and a testnet node gets a
  banner.
- **Liquidity purchases.** phoenixd reports each purchase twice: the incoming
  payment that triggered it, net of the fee, and a separate `auto_liquidity`
  record for the same fee. satbook pairs them and shows the purchase on the
  payment, so the fee is never counted twice.
- **Zaps.** LNbits stores a zap request without checking its signature, so
  anyone can claim any sender. satbook verifies the nostr event id and its
  BIP-340 signature. Only then does a zap sender show as verified. Anything else
  is marked unverified.
- **Ledger status.** A payment counts as recorded when a ledger row was imported
  for it, or when a row you entered by hand carries its payment hash.

## Recording payments in the ledger

`/lightning/review` lists every payment that isn't in the ledger yet, oldest
first. Work down the list, so each payment out finds the sats that came in
before it. The amounts always come from the node; you only say what each
payment was.

- **Income** — a donation, a grant, or pay.
  - **Amount:** what the payer sent (the invoice amount). It is valued in INR at
    the BTC price at the payment's time.
  - **Fee:** if the payment set off a liquidity purchase, the fee the node kept
    goes in as a _fee taken on arrival_: consumed untaxed, so the wallet ends up
    with what the node has.
  - **Suggestions:** a Lightning Address payment is suggested as a donation
    (these count toward the ₹50,000 gift total on `/tax`). Its comment becomes
    the note, and a verified zap fills in the sender's npub.
- **Transfer** — sats moving between your own wallets.
  - Examples: the bootstrap from another of your wallets, or a sweep to cold
    storage (with its on-chain txid).
  - For a transfer in, add what the sending wallet charged on top. That fee is
    known only to that wallet.
- **Spend** — a payment out. It is a disposal, taxed like a sale.
- **Link** — a payment you already entered by hand. Rows with a matching amount
  within a day are offered.
- **Ignore** — leaves a payment out of the ledger. You can restore it later.
  _Ignore everything before_ skips history you already recorded elsewhere.

Recorded rows carry the source `import:phoenixd` and the payment's import key,
so the same payment can never be recorded twice. Deleting the row puts the
payment back up for review. A test-network node's payments are never recorded,
except on a development server.

## Limitations

- **On-chain deposits into phoenixd** (swap-ins) don't appear in phoenixd's
  payment list. The balance shows them; record them by hand.
- **Fee bumps, channel closes, and a liquidity purchase with no matching
  payment** show up in the review list, but are yours to record by hand.
- **phoenixd's default top-up size is assumed** for the "next top-up" tile and
  the receive card's quote (2M). If you run `--auto-liquidity 5m` or `10m`, the
  real fee is proportionally larger.

## Developing without a node

`scripts/mock-phoenixd.ts` serves phoenixd's and LNbits' APIs with a made-up
history:

- a bootstrap that bought liquidity;
- a comment;
- a verified zap and a forged one;
- a CLI invoice;
- a sweep;
- a payment out;
- a second top-up.

```sh
bun scripts/mock-phoenixd.ts
PHOENIXD_URL=http://127.0.0.1:9740 PHOENIXD_PASSWORD=mock-limited \
LNBITS_URL=http://127.0.0.1:5000 LNBITS_INVOICE_KEY=mock-invoice-key \
LIGHTNING_ADDRESS=you@example.com bun run dev
```

`MOCK_NODE=fresh` starts it as a node that has received nothing yet. An invoice
paid there opens the channel and takes the fee the way phoenixd does, or
becomes fee credit if it is too small. `MOCK_CHAIN=testnet3` makes it a test
node. `MOCK_SCOPE=full` makes it accept
`mock-full`, so you can see the full-access-password warning. phoenixd also runs
on testnet (`--chain testnet`), with ACINQ's testnet node as its peer.
