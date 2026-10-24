# Lightning (optional)

satbook can act as the dashboard for a self-custodial Lightning node running
[phoenixd](https://phoenix.acinq.co/server). [LNbits](https://lnbits.com) in
front of the node can serve a Lightning Address. satbook **reads** the node and
**never pays from it**. Sends and sweeps stay with phoenixd's own command line.

The module is off unless `PHOENIXD_URL` is set. Nothing changes for a satbook
without a node.

## What you get

`/lightning` shows:

- **The node:** balance (with its INR value), any fee credit, and on-chain
  deposits still being swapped in.
- **Receivable:** how much the channel can still take in before phoenixd has to
  buy more inbound liquidity.
- **Next top-up:** what the next liquidity purchase would cost, as quoted by the
  node.
- **Ledger check:** the satbook wallet that stands for the node, checked against
  the node's balance plus fee credit.
- **Activity:** every payment in and out. Each one shows the Lightning Address
  comment or the zap sender and message, any liquidity fee, and whether it is
  already in the ledger.
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
`tag:pay` and satbook tagged `tag:satbook`, satbook needs:

```hujson
{"action": "accept", "src": ["tag:satbook"], "dst": ["tag:pay:9740", "tag:pay:8443"]},
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
  another wallet you own. First ask the node what a purchase costs right now,
  for your amount plus the 2M:

  ```sh
  # on the node's host, for a 30 000 sat bootstrap
  phoenix-cli estimateliquidityfees --amountSat 2030000
  # {"miningFeeSat": 411, "serviceFeeSat": 21300}
  ```

  Then send that total plus a margin (about 10,000 sat). The fee-credit check
  uses a raised, worst-case feerate, so a payment that only just covers the
  quote can still land in fee credit.

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

## Limitations

- **On-chain deposits into phoenixd** (swap-ins) don't appear in phoenixd's
  payment list. The balance shows them; record them by hand.
- **Fee bumps and channel closes** are listed, but are yours to record.
- **phoenixd's default top-up size is assumed** for the "next top-up" quote
  (2M). If you run `--auto-liquidity 5m` or `10m`, the real fee is
  proportionally larger.

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

`MOCK_CHAIN=testnet3` makes it a test node. `MOCK_SCOPE=full` makes it accept
`mock-full`, so you can see the full-access-password warning. phoenixd also runs
on testnet (`--chain testnet`), with ACINQ's testnet node as its peer.
