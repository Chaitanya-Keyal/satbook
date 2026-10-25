// A stand-in phoenixd (and LNbits) for developing and testing the Lightning
// module without a node or real money. It serves one made-up history, in the
// exact JSON shapes the real APIs use: a bootstrap that bought liquidity, a
// Lightning Address payment with a comment, a verified zap, a zap with a
// forged signature, a payment to a CLI invoice, a sweep on-chain, a payment out
// and a donation that set off a second liquidity purchase.
//
//   bun scripts/mock-phoenixd.ts
//   PHOENIXD_URL=http://127.0.0.1:9740 PHOENIXD_PASSWORD=mock-limited \
//   LNBITS_URL=http://127.0.0.1:5000 LNBITS_INVOICE_KEY=mock-invoice-key \
//   NOSTR_PUBKEY=$(bun -e "console.log((await import('./scripts/mock-phoenixd.ts')).MOCK_NOSTR_PUBKEY)") \
//   bun run dev
//
// Environment: MOCK_PHOENIXD_PORT (9740), MOCK_LNBITS_PORT (5000),
// MOCK_CHAIN (mainnet), MOCK_SCOPE (limited | full: the password satbook is
// pretending to hold), MOCK_INVOICE_PAID_AFTER (8: seconds until an invoice
// made through the mock pays itself), MOCK_NODE (history | fresh: a node that
// has received nothing yet, as before the bootstrap).

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

const sha256Hex = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const hash = (label: string) => sha256Hex(`satbook mock: ${label}`);
/** Stable across restarts, so a dev database never sees the same payment twice. */
const uuid = (label: string) => {
  const h = hash(label);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export const MOCK_PASSWORD = { limited: 'mock-limited', full: 'mock-full' } as const;
export const MOCK_INVOICE_KEY = 'mock-invoice-key';
export const MOCK_ADDRESS = 'you@example.com';
/** The mock's mining fee for a liquidity purchase, at the "current" feerate. */
export const MOCK_MINING_FEE_SAT = 411;
const AUTO_LIQUIDITY_SAT = 2_000_000;
/** Stands in for the address owner's nostr key: zaps are addressed to it. */
export const MOCK_NOSTR_PUBKEY = hash('recipient pubkey');
const RECIPIENT = MOCK_NOSTR_PUBKEY;

/** A zap request (NIP-57, kind 9734) signed by a throwaway key, or forged. */
function zapRequest(amountMsat: number, content: string, createdAt: number, forged = false) {
  const sk = hexToBytes(hash('zapper secret key'));
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const tags = [
    ['relays', 'wss://relay.example.com'],
    ['amount', String(amountMsat)],
    ['p', RECIPIENT]
  ];
  const id = sha256Hex(JSON.stringify([0, pubkey, createdAt, 9734, tags, content]));
  const sig = forged ? '0'.repeat(128) : bytesToHex(schnorr.sign(hexToBytes(id), sk));
  return JSON.stringify({ pubkey, created_at: createdAt, kind: 9734, tags, content, id, sig });
}

export interface Scenario {
  info: Record<string, unknown>;
  balance: Record<string, unknown>;
  incoming: Record<string, unknown>[];
  outgoing: Record<string, unknown>[];
  lnbits: Record<string, unknown>[];
  /** Invoices made through POST /createinvoice, by payment hash. */
  invoices: Map<string, { createdAt: number; record: Record<string, unknown> }>;
}

/** The history, relative to `nowSec`, with phoenixd's ms timestamps and msat fees. */
export function scenario(nowSec: number, chain = 'mainnet'): Scenario {
  const DAY = 86400;
  const ms = (sec: number) => sec * 1000;
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const incoming: Record<string, unknown>[] = [];
  const outgoing: Record<string, unknown>[] = [];
  const lnbits: Record<string, unknown>[] = [];

  const received = (
    label: string,
    at: number,
    requestedSat: number,
    feeSat: number,
    description?: string
  ) => {
    const paymentHash = hash(label);
    incoming.push({
      type: 'incoming_payment',
      subType: 'lightning',
      paymentHash,
      preimage: hash(`${label} preimage`),
      externalId: '',
      ...(description ? { description } : {}),
      invoice: `lnbc${requestedSat}n1mock${label.replace(/\W/g, '')}`,
      isPaid: true,
      isExpired: false,
      requestedSat,
      receivedSat: requestedSat - feeSat,
      fees: feeSat * 1000,
      expiresAt: ms(at + 3600),
      completedAt: ms(at),
      createdAt: ms(at - 30)
    });
    return paymentHash;
  };
  const liquidity = (label: string, at: number, feeSat: number) =>
    outgoing.push({
      type: 'outgoing_payment',
      subType: 'auto_liquidity',
      paymentId: uuid(`${label} purchase`),
      txId: hash(`${label} funding tx`),
      isPaid: true,
      sent: feeSat,
      fees: feeSat * 1000,
      completedAt: ms(at + 2),
      createdAt: ms(at)
    });
  const viaAddress = (
    paymentHash: string,
    at: number,
    amountSat: number,
    extra: Record<string, unknown>
  ) =>
    lnbits.push({
      checking_id: paymentHash,
      payment_hash: paymentHash,
      wallet_id: 'mockwallet',
      amount: amountSat * 1000,
      fee: 0,
      status: 'success',
      memo: `Payment to ${MOCK_ADDRESS}`,
      tag: 'lnurlp',
      time: iso(at),
      extra: { tag: 'lnurlp', link: 'mock01', lnaddress: MOCK_ADDRESS, ...extra }
    });

  // 1. the bootstrap: your own 30k from another wallet buys the first 2M of inbound
  const t1 = nowSec - 10 * DAY;
  received('bootstrap', t1, 30_000, 21_711, 'bootstrap');
  liquidity('bootstrap', t1, 21_711);

  // 2. a Lightning Address payment with a comment
  const t2 = nowSec - 8 * DAY;
  viaAddress(received('comment', t2, 21_000, 0), t2, 21_000, {
    comment: 'Thanks for the open-source work'
  });

  // 3. a zap with a valid signature, and 4. one whose signature is forged
  const t3 = nowSec - 6 * DAY;
  viaAddress(received('zap', t3, 2_100, 0), t3, 2_100, {
    nostr: zapRequest(2_100_000, 'great post', t3 - 5)
  });
  const t4 = nowSec - 5 * DAY;
  viaAddress(received('forged zap', t4, 500, 0), t4, 500, {
    nostr: zapRequest(500_000, 'trust me', t4 - 5, true)
  });

  // 5. a payment to an invoice made with the CLI (LNbits never saw it)
  received('cli invoice', nowSec - 3 * DAY, 50_000, 0, 'invoice from the CLI');

  // 6. a sweep to cold storage: 60 000 out on-chain plus a 1 200 mining fee
  const t6 = nowSec - 2 * DAY;
  outgoing.push({
    type: 'outgoing_payment',
    subType: 'splice_out',
    paymentId: uuid('sweep'),
    txId: hash('sweep tx'),
    isPaid: true,
    sent: 61_200,
    fees: 1_200_000,
    completedAt: ms(t6 + 600),
    createdAt: ms(t6)
  });

  // 7. a Lightning payment out: 1 000 plus a 4 sat routing fee
  const t7 = nowSec - DAY;
  outgoing.push({
    type: 'outgoing_payment',
    subType: 'lightning',
    paymentId: uuid('payment out'),
    paymentHash: hash('payment out'),
    preimage: hash('payment out preimage'),
    isPaid: true,
    sent: 1_004,
    fees: 4_000,
    invoice: 'lnbc10u1mockpaymentout',
    completedAt: ms(t7 + 3),
    createdAt: ms(t7)
  });

  // 8. a donation that arrives once inbound is used up: a second purchase
  const t8 = nowSec - 12 * 3600;
  viaAddress(received('donation with top-up', t8, 40_000, 22_100), t8, 40_000, {
    comment: 'keep building'
  });
  liquidity('second top-up', t8, 22_100);

  const balanceSat = 8_289 + 21_000 + 2_100 + 500 + 50_000 - 61_200 - 1_004 + 17_900;
  const capacitySat = 4_068_800;
  return {
    info: {
      nodeId: `02${hash('node id')}`,
      channels: [
        {
          state: 'Normal',
          channelId: hash('channel'),
          balanceSat,
          inboundLiquiditySat: capacitySat - balanceSat - 40_000,
          capacitySat,
          fundingTxId: hash('second top-up funding tx')
        },
        {
          state: 'Closed',
          channelId: hash('old channel'),
          balanceSat: 999,
          inboundLiquiditySat: 0,
          capacitySat: 100_000,
          fundingTxId: hash('old funding tx')
        }
      ],
      chain,
      blockHeight: 900_000,
      version: '0.9.3-mock'
    },
    balance: {
      balanceSat,
      feeCreditSat: 0,
      swapIn: {
        unconfirmedBalanceSat: 0,
        weaklyConfirmedBalanceSat: 0,
        deeplyConfirmedBalanceSat: 0
      }
    },
    incoming,
    outgoing,
    lnbits,
    invoices: new Map()
  };
}

/** A node that has received nothing yet: no channel, no balance, no history. */
export function freshScenario(chain = 'mainnet'): Scenario {
  const s = scenario(0, chain);
  return {
    ...s,
    info: { ...s.info, nodeId: `02${hash('fresh node id')}`, channels: [] },
    balance: { ...s.balance, balanceSat: 0 },
    incoming: [],
    outgoing: [],
    lnbits: []
  };
}

/**
 * Pays an invoice the way phoenixd would: into the channel when it fits,
 * otherwise through a liquidity purchase of the block plus the payment (its
 * fee taken out of the payment, at the raised feerate phoenixd pays), or into
 * fee credit when the payment is too small to cover that.
 */
function settle(s: Scenario, r: Record<string, unknown>) {
  const amount = (r.requestedSat as number | undefined) ?? 1_000;
  const balance = s.balance as { balanceSat: number; feeCreditSat: number };
  const channels = s.info.channels as Record<string, unknown>[];
  const channel = channels.find((c) => c.state === 'Normal') as
    { balanceSat: number; inboundLiquiditySat: number; capacitySat: number } | undefined;
  r.isPaid = true;
  r.completedAt = Date.now();
  r.receivedSat = amount;
  s.incoming.push(r);
  if (channel && amount <= channel.inboundLiquiditySat) {
    channel.balanceSat += amount;
    channel.inboundLiquiditySat -= amount;
    balance.balanceSat += amount;
    return;
  }
  const opens = !channel;
  const service = Math.round((AUTO_LIQUIDITY_SAT + amount) / 100) + (opens ? 1_000 : 0);
  const threshold = service + (opens ? 0 : 1_000) + Math.ceil(MOCK_MINING_FEE_SAT * 3.8);
  if (amount + balance.feeCreditSat <= threshold) {
    balance.feeCreditSat += amount;
    return;
  }
  // Like lightning-kmp: both records carry the purchase's full fee (mining +
  // service); fee credit pays part of it first, so the LSP takes only the rest
  // out of the payment, and that shows in what was received.
  const total = service + Math.ceil(MOCK_MINING_FEE_SAT * (opens ? 2.5 : 1));
  const creditUsed = Math.min(balance.feeCreditSat, total);
  balance.feeCreditSat -= creditUsed;
  const kept = amount - (total - creditUsed);
  r.receivedSat = kept;
  r.fees = total * 1000;
  const at = r.completedAt as number;
  s.outgoing.push({
    type: 'outgoing_payment',
    subType: 'auto_liquidity',
    paymentId: uuid(`${String(r.paymentHash)} purchase`),
    txId: hash(`${String(r.paymentHash)} funding tx`),
    isPaid: true,
    sent: total,
    fees: total * 1000,
    completedAt: at + 2_000,
    createdAt: at
  });
  if (channel) {
    channel.capacitySat += AUTO_LIQUIDITY_SAT + amount;
    channel.balanceSat += kept;
    channel.inboundLiquiditySat += AUTO_LIQUIDITY_SAT + amount - kept;
  } else {
    channels.push({
      state: 'Normal',
      channelId: hash(`${String(r.paymentHash)} channel`),
      balanceSat: kept,
      inboundLiquiditySat: AUTO_LIQUIDITY_SAT + amount - kept,
      capacitySat: AUTO_LIQUIDITY_SAT + amount,
      fundingTxId: hash(`${String(r.paymentHash)} funding tx`)
    });
  }
  balance.balanceSat += kept;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 4), {
    status,
    headers: { 'content-type': 'application/json' }
  });

/**
 * phoenixd's API over `s`. Pure: (Request) → Response, so tests can call it
 * directly. An invoice made here is paid by itself `paidAfterMs` after its
 * creation, the first time it is looked up from then on.
 */
export function phoenixdHandler(
  s: Scenario,
  scope: 'limited' | 'full' = 'limited',
  opts: { paidAfterMs?: number } = {}
) {
  const paidAfterMs = opts.paidAfterMs ?? 8_000;
  return async (req: Request): Promise<Response> => {
    const auth = req.headers.get('authorization') ?? '';
    const password = Buffer.from(auth.replace(/^Basic /, ''), 'base64')
      .toString()
      .replace(/^[^:]*:/, '');
    if (password !== MOCK_PASSWORD[scope]) return new Response('Unauthorized', { status: 401 });
    const url = new URL(req.url);
    const q = url.searchParams;
    const page = <T>(rows: T[]) => {
      const offset = Number(q.get('offset') ?? 0);
      return rows.slice(offset, offset + Number(q.get('limit') ?? 20));
    };
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /getinfo':
        return json(s.info);
      case 'GET /getbalance':
        return json(s.balance);
      case 'GET /estimateliquidityfees': {
        // 1%, plus the channel creation fee while there is no channel yet.
        const amount = Number(q.get('amountSat') ?? 0);
        const opens = (s.info.channels as unknown[]).length === 0;
        return json({
          miningFeeSat: MOCK_MINING_FEE_SAT,
          serviceFeeSat: Math.round(amount / 100) + (opens ? 1_000 : 0)
        });
      }
      case 'GET /payments/incoming': {
        const from = Number(q.get('from') ?? 0);
        const rows = s.incoming
          .filter((p) => (p.completedAt as number) >= from)
          .sort((a, b) => (b.completedAt as number) - (a.completedAt as number));
        return json(page(rows));
      }
      case 'GET /payments/outgoing':
        return json(page(s.outgoing));
      case 'POST /createinvoice': {
        const form = new URLSearchParams(await req.text());
        const amountSat = form.has('amountSat') ? Number(form.get('amountSat')) : null;
        const paymentHash = hash(`invoice ${s.invoices.size} ${form.get('description')}`);
        const serialized = `lnbc${amountSat ?? ''}n1mock${paymentHash.slice(0, 40)}`;
        const now = Date.now();
        s.invoices.set(paymentHash, {
          createdAt: now,
          record: {
            type: 'incoming_payment',
            subType: 'lightning',
            paymentHash,
            preimage: hash(`${paymentHash} preimage`),
            externalId: '',
            description: form.get('description') ?? '',
            invoice: serialized,
            isPaid: false,
            isExpired: false,
            ...(amountSat != null ? { requestedSat: amountSat } : {}),
            receivedSat: 0,
            fees: 0,
            expiresAt: now + Number(form.get('expirySeconds') ?? 3600) * 1000,
            createdAt: now
          }
        });
        return json({ ...(amountSat != null ? { amountSat } : {}), paymentHash, serialized });
      }
      case 'POST /payinvoice':
        // The limited password is refused before the invoice is read; only
        // the full one gets far enough to reject it. Nothing is ever paid.
        return scope === 'full'
          ? new Response('invalid invoice', { status: 400 })
          : new Response('Unauthorized', { status: 401 });
      default: {
        const m = /^\/payments\/incoming\/([0-9a-f]{64})$/.exec(url.pathname);
        if (req.method === 'GET' && m) {
          const inv = s.invoices.get(m[1]);
          if (inv) {
            const r = inv.record;
            if (!r.isPaid && Date.now() - inv.createdAt >= paidAfterMs) settle(s, r);
            return json(r);
          }
          const known = s.incoming.find((p) => p.paymentHash === m[1]);
          return known ? json(known) : new Response('Not Found', { status: 404 });
        }
        return new Response('Not Found', { status: 404 });
      }
    }
  };
}

/** LNbits' API over `s`, for an invoice key. */
export function lnbitsHandler(s: Scenario) {
  return async (req: Request): Promise<Response> => {
    if (req.headers.get('x-api-key') !== MOCK_INVOICE_KEY)
      return json({ detail: 'Invalid key' }, 401);
    const url = new URL(req.url);
    if (url.pathname === '/api/v1/wallet') return json({ name: 'donations', balance: 0 });
    if (url.pathname === '/api/v1/payments/paginated') {
      const q = url.searchParams;
      const offset = Number(q.get('offset') ?? 0);
      const rows = [...s.lnbits].sort((a, b) => String(b.time).localeCompare(String(a.time)));
      return json({
        data: rows.slice(offset, offset + Number(q.get('limit') ?? 20)),
        total: rows.length
      });
    }
    return json({ detail: 'Not Found' }, 404);
  };
}

if (import.meta.main) {
  const chain = process.env.MOCK_CHAIN ?? 'mainnet';
  const s =
    process.env.MOCK_NODE === 'fresh'
      ? freshScenario(chain)
      : scenario(Math.floor(Date.now() / 1000), chain);
  const scope = process.env.MOCK_SCOPE === 'full' ? 'full' : 'limited';
  const phoenixdPort = Number(process.env.MOCK_PHOENIXD_PORT ?? 9740);
  const lnbitsPort = Number(process.env.MOCK_LNBITS_PORT ?? 5000);
  Bun.serve({
    hostname: '127.0.0.1',
    port: phoenixdPort,
    fetch: phoenixdHandler(s, scope, {
      paidAfterMs: Number(process.env.MOCK_INVOICE_PAID_AFTER ?? 8) * 1000
    })
  });
  Bun.serve({ hostname: '127.0.0.1', port: lnbitsPort, fetch: lnbitsHandler(s) });
  console.log(
    `mock phoenixd on http://127.0.0.1:${phoenixdPort} (password ${MOCK_PASSWORD[scope]})`
  );
  console.log(`mock LNbits on http://127.0.0.1:${lnbitsPort} (invoice key ${MOCK_INVOICE_KEY})`);
}
