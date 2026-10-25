// Lightning module suite: config, the phoenixd/LNbits parsers and error
// mapping, zap verification, receive quotes, and sync against the mock node in
// scripts/mock-phoenixd.ts (called in-process through a fetch stub — no
// network, no ports). DATABASE_PATH must be set before the db module loads,
// so server modules are imported dynamically.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { ledgerCheck, purchaseQuote } from '../src/lib/utils/lightning';

process.env.DATABASE_PATH = ':memory:';
delete process.env.ADMIN_PASSWORD;

const { lightningConfigState } = await import('../src/lib/server/lightning/config');
const { lightningState } = await import('../src/lib/server/lightning/credentials');
const { parseCreatedInvoice, parseIncoming, parseOutgoing, parseNodeInfo, parseBalance, phoenixd } =
  await import('../src/lib/server/lightning/phoenixd');
const { parseLnbitsPayment } = await import('../src/lib/server/lightning/lnbits');
const { eventId, npub, parseNostrPubkey, parseZapRequest, verifyZapRequest } =
  await import('../src/lib/server/lightning/zap');
const { syncLightning, lastSync } = await import('../src/lib/server/lightning/sync');
const { figures } = await import('../src/lib/server/lightning/classify');
const { listPayments, importKeyFor } = await import('../src/lib/server/lightning/node');
const { db, schema } = await import('../src/lib/server/db');
const mock = await import('../scripts/mock-phoenixd');
const { eq, like } = await import('drizzle-orm');

const LN_ENV = [
  'PHOENIXD_URL',
  'PHOENIXD_PASSWORD',
  'PHOENIXD_PASSWORD_FILE',
  'LNBITS_URL',
  'LNBITS_INVOICE_KEY',
  'LNBITS_INVOICE_KEY_FILE',
  'LIGHTNING_PROXY',
  'LIGHTNING_ADDRESS',
  'NOSTR_PUBKEY'
];
const clearEnv = () => LN_ENV.forEach((k) => delete process.env[k]);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  clearEnv();
});

// --- config -------------------------------------------------------------------

describe('config', () => {
  beforeEach(clearEnv);

  test('off without PHOENIXD_URL', () => {
    expect(lightningConfigState()).toEqual({ state: 'off' });
  });

  test('a URL without a password is a problem, not silence', () => {
    process.env.PHOENIXD_URL = 'http://127.0.0.1:9740';
    const s = lightningConfigState();
    expect(s.state).toBe('invalid');
  });

  test('on: trailing slashes dropped, LNbits needs its key, bad address rejected', () => {
    process.env.PHOENIXD_URL = 'https://pay.example.ts.net:9740/';
    process.env.PHOENIXD_PASSWORD = 'pw';
    let s = lightningConfigState();
    expect(s.state === 'on' && s.config.phoenixdUrl).toBe('https://pay.example.ts.net:9740');
    process.env.LNBITS_URL = 'https://pay.example.ts.net:8443';
    expect(lightningConfigState().state).toBe('invalid');
    process.env.LNBITS_INVOICE_KEY = 'k';
    expect(lightningConfigState().state).toBe('on');
    process.env.LIGHTNING_ADDRESS = 'not an address';
    expect(lightningConfigState().state).toBe('invalid');
    process.env.LIGHTNING_ADDRESS = 'you@example.com';
    s = lightningConfigState();
    expect(s.state === 'on' && s.config.lightningAddress).toBe('you@example.com');
  });

  test('a *_FILE secret wins over the plain variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'satbook-ln-'));
    writeFileSync(join(dir, 'pw'), 'from-file\n');
    process.env.PHOENIXD_URL = 'http://127.0.0.1:9740';
    process.env.PHOENIXD_PASSWORD = 'from-env';
    process.env.PHOENIXD_PASSWORD_FILE = join(dir, 'pw');
    try {
      const s = lightningConfigState();
      expect(s.state === 'on' && s.config.phoenixdPassword).toBe('from-file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- parsers --------------------------------------------------------------------

describe('phoenixd parsers', () => {
  test('incoming: ms → s, fees stay msat, empty externalId and missing fields → null', () => {
    const p = parseIncoming({
      type: 'incoming_payment',
      subType: 'lightning',
      paymentHash: 'ab'.repeat(32),
      externalId: '',
      isPaid: true,
      requestedSat: 30_000,
      receivedSat: 8_289,
      fees: 21_711_000,
      completedAt: 1_700_000_000_123,
      createdAt: 1_699_999_999_000
    })!;
    expect(p.completedAt).toBe(1_700_000_000);
    expect(p.createdAt).toBe(1_699_999_999);
    expect(p.feesMsat).toBe(21_711_000);
    expect(p.externalId).toBeNull();
    expect(p.description).toBeNull();
    expect(p.payerNote).toBeNull();
  });

  test('incoming: a negative receivedSat survives (a small payment, a big purchase)', () => {
    const p = parseIncoming({
      paymentHash: 'cd'.repeat(32),
      isPaid: true,
      receivedSat: -21_000,
      fees: 22_000_000,
      createdAt: 1
    })!;
    expect(p.receivedSat).toBe(-21_000);
    expect(p.completedAt).toBeNull();
  });

  test('outgoing and malformed rows', () => {
    const o = parseOutgoing({
      subType: 'splice_out',
      paymentId: 'id-1',
      txId: 'ef'.repeat(32),
      isPaid: true,
      sent: 61_200,
      fees: 1_200_000,
      completedAt: 2_000,
      createdAt: 1_000
    })!;
    expect(o).toMatchObject({ subType: 'splice_out', sentSat: 61_200, paymentHash: null });
    expect(parseOutgoing({ subType: 'lightning' })).toBeNull();
    expect(parseIncoming('nope')).toBeNull();
  });

  test('node info and balance', () => {
    const s = mock.scenario(1_700_000_000);
    const info = parseNodeInfo(s.info)!;
    expect(info.channels).toHaveLength(2);
    expect(info.chain).toBe('mainnet');
    expect(parseBalance({ balanceSat: 5, feeCreditSat: 2 })).toEqual({
      balanceSat: 5,
      feeCreditSat: 2,
      swapInSat: 0
    });
    expect(
      parseBalance({
        balanceSat: 0,
        feeCreditSat: 0,
        swapIn: {
          unconfirmedBalanceSat: 1,
          weaklyConfirmedBalanceSat: 2,
          deeplyConfirmedBalanceSat: 3
        }
      })!.swapInSat
    ).toBe(6);
    expect(parseBalance({ balanceSat: 'x' })).toBeNull();
  });
});

describe('LNbits parser', () => {
  test('comment, Lightning Address and a zap request stored as a JSON string', () => {
    const s = mock.scenario(1_700_000_000);
    const parsed = s.lnbits.map(parseLnbitsPayment);
    expect(parsed.every((p) => p != null)).toBe(true);
    const withComment = parsed.find((p) => p!.comment)!;
    expect(withComment.comment).toBe('Thanks for the open-source work');
    expect(withComment.lnAddress).toBe(mock.MOCK_ADDRESS);
    const zapped = parsed.find((p) => p!.zap)!;
    expect(zapped.zap!.kind).toBe(9734);
    expect(zapped.amountMsat).toBe(2_100_000);
  });

  test('payer text is capped', () => {
    const p = parseLnbitsPayment({
      payment_hash: 'ab'.repeat(32),
      amount: 1000,
      time: '2026-01-01T00:00:00+00:00',
      extra: { comment: 'x'.repeat(5000) }
    })!;
    expect(p.comment!.length).toBe(500);
  });
});

// --- zaps -------------------------------------------------------------------------

describe('zap requests', () => {
  const sk = hexToBytes('11'.repeat(32));
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const ME = 'aa'.repeat(32);
  const PAID_AT = 1_700_000_060;
  const ctx = { recipient: ME, paidMsat: 21_000, completedAt: PAID_AT };
  const sign = (
    over: Partial<{ content: string; kind: number; tags: string[][]; createdAt: number }> = {}
  ) => {
    const e = {
      pubkey,
      createdAt: over.createdAt ?? 1_700_000_000,
      kind: over.kind ?? 9734,
      tags: over.tags ?? [
        ['amount', '21000'],
        ['p', ME]
      ],
      content: over.content ?? 'hi'
    };
    const id = eventId(e);
    return { ...e, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
  };

  test('signed, for us, for the amount paid, made just before the payment: verified', () => {
    expect(verifyZapRequest(sign(), ctx)).toBe(true);
  });

  test('the amount must be stated and match what was paid', () => {
    expect(verifyZapRequest(sign(), { ...ctx, paidMsat: 22_000 })).toBe(false);
    expect(verifyZapRequest(sign({ tags: [['p', ME]] }), ctx)).toBe(false);
  });

  test('it must be addressed to us, and only to us', () => {
    const other = 'bb'.repeat(32);
    const to = (...p: string[]) => sign({ tags: [['amount', '21000'], ...p.map((k) => ['p', k])] });
    expect(verifyZapRequest(to(other), ctx)).toBe(false);
    expect(verifyZapRequest(to(ME, other), ctx)).toBe(false);
    expect(verifyZapRequest(to(), ctx)).toBe(false);
    // without NOSTR_PUBKEY there is nothing to bind to
    expect(verifyZapRequest(sign(), { ...ctx, recipient: null })).toBe(false);
  });

  test('a request made long before the payment, or ahead of it, is a replay', () => {
    expect(verifyZapRequest(sign({ createdAt: PAID_AT - 3601 }), ctx)).toBe(false);
    expect(verifyZapRequest(sign({ createdAt: PAID_AT + 601 }), ctx)).toBe(false);
    expect(verifyZapRequest(sign({ createdAt: PAID_AT + 300 }), ctx)).toBe(true);
  });

  test('tampering, a zero signature or the wrong kind all fail', () => {
    expect(verifyZapRequest({ ...sign(), content: 'changed' }, ctx)).toBe(false);
    expect(verifyZapRequest({ ...sign(), sig: '0'.repeat(128) }, ctx)).toBe(false);
    expect(verifyZapRequest(sign({ kind: 1 }), ctx)).toBe(false);
  });

  test('NOSTR_PUBKEY takes an npub or a hex key', () => {
    expect(parseNostrPubkey(npub(ME))).toBe(ME);
    expect(parseNostrPubkey(ME.toUpperCase())).toBe(ME);
    expect(parseNostrPubkey('npub1notakey')).toBeNull();
    expect(parseNostrPubkey('aa')).toBeNull();
  });

  test('parses the stored JSON string, rejects junk', () => {
    const z = sign();
    const raw = JSON.stringify({ ...z, created_at: z.createdAt });
    expect(parseZapRequest(raw)?.pubkey).toBe(pubkey);
    expect(parseZapRequest('{nope')).toBeNull();
    expect(parseZapRequest({ kind: 9734 })).toBeNull();
  });

  test('npub encoding (NIP-19 test vector)', () => {
    expect(npub('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d')).toBe(
      'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'
    );
  });
});

// --- the client against the mock --------------------------------------------------

const NOW = Math.floor(Date.now() / 1000);
const SCENARIO = mock.scenario(NOW);
let phoenixdDown = false;
let lnbitsDown = false;
let scope: 'limited' | 'full' = 'limited';

function routeFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const host = new URL(req.url).host;
    if (host === 'phoenixd.test') {
      if (phoenixdDown) throw new TypeError('connection refused');
      return mock.phoenixdHandler(SCENARIO, scope, { paidAfterMs: 0 })(req);
    }
    if (host === 'lnbits.test') {
      if (lnbitsDown) return new Response('bad gateway', { status: 502 });
      return mock.lnbitsHandler(SCENARIO)(req);
    }
    throw new Error(`unmocked fetch: ${req.url}`);
  }) as typeof fetch;
}

function useMockEnv(password: string = mock.MOCK_PASSWORD.limited) {
  clearEnv();
  process.env.PHOENIXD_URL = 'http://phoenixd.test';
  process.env.PHOENIXD_PASSWORD = password;
  process.env.LNBITS_URL = 'http://lnbits.test';
  process.env.LNBITS_INVOICE_KEY = mock.MOCK_INVOICE_KEY;
  process.env.NOSTR_PUBKEY = npub(mock.MOCK_NOSTR_PUBKEY);
}

describe('phoenixd client', () => {
  beforeEach(() => {
    routeFetch();
    phoenixdDown = false;
    scope = 'limited';
  });

  const client = (password: string = mock.MOCK_PASSWORD.limited) => {
    useMockEnv(password);
    const s = lightningConfigState();
    if (s.state !== 'on') throw new Error('config');
    return phoenixd(s.config);
  };

  test('a wrong password reads as unauthorized; an unreachable node as unreachable', async () => {
    const bad = await client('wrong').getInfo();
    expect(bad.ok === false && bad.error).toBe('unauthorized');
    phoenixdDown = true;
    const down = await client().getInfo();
    expect(down.ok === false && down.error).toBe('unreachable');
  });

  test('password scope: limited, full', async () => {
    expect(await client().passwordScope()).toBe('limited');
    scope = 'full';
    expect(await client(mock.MOCK_PASSWORD.full).passwordScope()).toBe('full');
  });
});

describe('credentials that could spend', () => {
  beforeEach(() => {
    routeFetch();
    phoenixdDown = false;
    scope = 'limited';
  });

  test('the limited password and an invoice key run', async () => {
    useMockEnv();
    expect((await lightningState()).state).toBe('on');
  });

  test('a full-access password is refused, and the sync with it', async () => {
    scope = 'full';
    useMockEnv(mock.MOCK_PASSWORD.full);
    const st = await lightningState();
    expect(st.state === 'invalid' && st.problem).toMatch(/full-access password/);
    const s = await syncLightning({ force: true });
    expect(s.ok === false && s.error).toMatch(/full-access password/);
  });

  test('an LNbits admin key is refused', async () => {
    useMockEnv();
    process.env.LNBITS_INVOICE_KEY = mock.MOCK_ADMIN_KEY;
    const st = await lightningState();
    expect(st.state === 'invalid' && st.problem).toMatch(/admin key/);
  });

  test('a node that cannot answer does not lock satbook out', async () => {
    useMockEnv();
    process.env.PHOENIXD_PASSWORD = 'not-checked-yet';
    phoenixdDown = true;
    expect((await lightningState()).state).toBe('on');
  });
});

// --- sync ---------------------------------------------------------------------------

describe('invoices', () => {
  beforeEach(() => {
    routeFetch();
    phoenixdDown = false;
    scope = 'limited';
    useMockEnv();
  });

  const client = () => {
    const s = lightningConfigState();
    if (s.state !== 'on') throw new Error('config');
    return phoenixd(s.config);
  };

  test('the limited password creates an invoice; a lookup shows it paid; a sync picks it up', async () => {
    const made = await client().createInvoice({
      amountSat: 5_000,
      description: 'coffee money',
      expirySeconds: 3600
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.data.serialized).toMatch(/^lnbc/);
    expect(made.data.amountSat).toBe(5_000);

    const looked = await client().getIncoming(made.data.paymentHash);
    expect(looked.ok && looked.data.isPaid).toBe(true);
    expect(looked.ok && looked.data.receivedSat).toBe(5_000);

    await syncLightning({ force: true });
    const row = db
      .select()
      .from(schema.lightningPayments)
      .all()
      .find((r) => r.paymentHash === made.data.paymentHash)!;
    expect(row.description).toBe('coffee money');
    expect(row.requestedSat).toBe(5_000);
  });

  test('an amountless invoice leaves the amount to the payer', async () => {
    const made = await client().createInvoice({
      amountSat: null,
      description: 'tip jar',
      expirySeconds: 600
    });
    expect(made.ok && made.data.amountSat).toBeNull();
  });

  test('a malformed reply is not an invoice', () => {
    expect(parseCreatedInvoice({ paymentHash: 'ab', serialized: 'not-a-bolt11' })).toBeNull();
    expect(parseCreatedInvoice({ paymentHash: 'ab', serialized: 'lnbc1xyz' })).toMatchObject({
      amountSat: null
    });
  });
});

describe('ledger check', () => {
  test('the ledger may trail the node by rounding, never lead it', () => {
    expect(ledgerCheck(12_623, 12_623)).toBe('match');
    expect(ledgerCheck(12_622, 12_623)).toBe('rounding');
    expect(ledgerCheck(12_624, 12_623)).toBe('gap');
    expect(ledgerCheck(12_621, 12_623)).toBe('gap');
    // less than a sat per payment that carried a fraction
    expect(ledgerCheck(12_620, 12_623, 3)).toBe('rounding');
    expect(ledgerCheck(12_619, 12_623, 3)).toBe('gap');
    expect(ledgerCheck(0, 5_000)).toBe('gap');
  });
});

describe('receive quotes', () => {
  const fresh = { inboundSat: 0, feeCreditSat: 0, hasChannel: false };
  // phoenixd's quote for 2,000,000 + 40,000 on a node with no channel yet.
  const bootstrapFee = { miningFeeSat: 500, serviceFeeSat: 21_400 };

  test('a bootstrap buys the block plus the payment, at a raised feerate', () => {
    expect(purchaseQuote(40_000, fresh, 2_000_000, bootstrapFee)).toEqual({
      kind: 'purchase',
      inboundSat: 0,
      purchaseSat: 2_040_000,
      opensChannel: true,
      quotedFeeSat: 21_900,
      serviceSat: 21_400,
      // 1.6× and 2.5× the quoted 500: opening a channel always raises it
      miningSat: [800, 1_250],
      feeCreditSat: 0,
      keepSat: [17_350, 17_800]
    });
  });

  test('a payment that cannot cover a worst-case fee may all become fee credit', () => {
    // 21,050 service + 3.8 × 500 mining
    const fee = { miningFeeSat: 500, serviceFeeSat: 21_050 };
    expect(purchaseQuote(5_000, fresh, 2_000_000, fee)).toEqual({
      kind: 'fee-credit',
      inboundSat: 0,
      thresholdSat: 22_950
    });
    expect(purchaseQuote(22_950, fresh, 2_000_000, fee).kind).toBe('fee-credit');
    expect(purchaseQuote(22_951, fresh, 2_000_000, fee).kind).toBe('purchase');
  });

  test('fee credit counts toward the threshold and pays the fee first', () => {
    const fee = { miningFeeSat: 500, serviceFeeSat: 21_050 };
    const q = purchaseQuote(5_000, { ...fresh, feeCreditSat: 20_000 }, 2_000_000, fee);
    expect(q.kind === 'purchase' && q.keepSat).toEqual([5_000 - 2_300, 5_000 - 1_850]);
    const covered = purchaseQuote(5_000, { ...fresh, feeCreditSat: 30_000 }, 2_000_000, fee);
    expect(covered.kind === 'purchase' && covered.keepSat).toEqual([5_000, 5_000]);
  });

  test('a splice has no creation fee in its quote, but the fee-credit test still counts one', () => {
    const node = { inboundSat: 1_500, feeCreditSat: 0, hasChannel: true };
    const fee = { miningFeeSat: 300, serviceFeeSat: 20_300 };
    // 20,300 + 1,000 + 3.8 × 300: above phoenixd's own quote of 20,600
    expect(purchaseQuote(22_000, node, 2_000_000, fee)).toMatchObject({
      kind: 'fee-credit',
      thresholdSat: 22_440
    });
    expect(purchaseQuote(30_000, node, 2_000_000, fee)).toMatchObject({
      kind: 'purchase',
      opensChannel: false,
      miningSat: [300, 1_140],
      keepSat: [8_560, 9_400]
    });
  });

  test('the mock node settles a bootstrap and a too-small payment the way the quote says', async () => {
    const call = (
      s: ReturnType<typeof mock.freshScenario>,
      method: string,
      path: string,
      body?: string
    ) =>
      mock
        .phoenixdHandler(s, 'limited', { paidAfterMs: 0 })(
          new Request(`http://phoenixd.test${path}`, {
            method,
            body,
            headers: {
              authorization: `Basic ${btoa(`:${mock.MOCK_PASSWORD.limited}`)}`,
              ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
            }
          })
        )
        .then((r) => r.json() as Promise<Record<string, any>>);
    const receive = async (s: ReturnType<typeof mock.freshScenario>, amountSat: number) => {
      const made = await call(s, 'POST', '/createinvoice', `amountSat=${amountSat}&description=x`);
      return call(s, 'GET', `/payments/incoming/${made.paymentHash}`);
    };

    const node = mock.freshScenario();
    const fee = await call(node, 'GET', '/estimateliquidityfees?amountSat=2040000');
    expect(fee).toEqual({ miningFeeSat: mock.MOCK_MINING_FEE_SAT, serviceFeeSat: 21_400 });
    const quote = purchaseQuote(
      40_000,
      { inboundSat: 0, feeCreditSat: 0, hasChannel: false },
      2_000_000,
      {
        miningFeeSat: fee.miningFeeSat,
        serviceFeeSat: fee.serviceFeeSat
      }
    );
    const paid = await receive(node, 40_000);
    expect(paid.isPaid).toBe(true);
    expect(quote.kind === 'purchase' && quote.keepSat[0]).toBe(paid.receivedSat);
    expect(paid.fees).toBe((40_000 - paid.receivedSat) * 1000);
    expect(node.outgoing).toMatchObject([
      { subType: 'auto_liquidity', sent: 40_000 - paid.receivedSat }
    ]);
    const info = await call(node, 'GET', '/getinfo');
    expect(info.channels).toMatchObject([
      { state: 'Normal', capacitySat: 2_040_000, balanceSat: paid.receivedSat }
    ]);
    // Now it fits, and the next quote has no creation fee.
    expect((await receive(node, 5_000)).receivedSat).toBe(5_000);
    expect(
      (await call(node, 'GET', '/estimateliquidityfees?amountSat=2000000')).serviceFeeSat
    ).toBe(20_000);

    const tiny = mock.freshScenario();
    expect((await receive(tiny, 5_000)).receivedSat).toBe(5_000);
    expect(await call(tiny, 'GET', '/getbalance')).toMatchObject({
      balanceSat: 0,
      feeCreditSat: 5_000
    });
    expect((await call(tiny, 'GET', '/getinfo')).channels).toEqual([]);
  });
});

describe('fee credit', () => {
  test('spent on a purchase, it leaves the ledger equal to balance + credit', async () => {
    // The reviewer's case: 5,000 lands in fee credit, then 40,000 sets off a
    // purchase whose fee the credit partly pays. phoenixd (lightning-kmp)
    // reports the purchase's FULL fee on the payment, and a received amount
    // that already has the credit's share added back.
    const node = mock.freshScenario();
    const handler = mock.phoenixdHandler(node, 'limited', { paidAfterMs: 0 });
    const call = (method: string, path: string, body?: string) =>
      handler(
        new Request(`http://phoenixd.test${path}`, {
          method,
          body,
          headers: {
            authorization: `Basic ${btoa(`:${mock.MOCK_PASSWORD.limited}`)}`,
            ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
          }
        })
      ).then((r) => r.json() as Promise<Record<string, any>>);
    const receive = async (amountSat: number) => {
      const made = await call('POST', '/createinvoice', `amountSat=${amountSat}&description=x`);
      return call('GET', `/payments/incoming/${made.paymentHash}`);
    };

    expect((await receive(5_000)).receivedSat).toBe(5_000);
    expect(await call('GET', '/getbalance')).toMatchObject({ balanceSat: 0, feeCreditSat: 5_000 });
    const big = await receive(40_000);
    const fee = 21_400 + Math.ceil(411 * 2.5);
    expect(big.fees).toBe(fee * 1000);
    expect(big.receivedSat).toBe(40_000 - fee + 5_000);
    expect(node.outgoing).toMatchObject([{ subType: 'auto_liquidity', fees: fee * 1000 }]);

    // Review records each as INCOME of what the payer sent, less the fee.
    const ledger = node.incoming.reduce(
      (sum, r) =>
        sum +
        figures({
          direction: 'in',
          amountSat: r.receivedSat as number,
          feeMsat: r.fees as number,
          requestedSat: r.requestedSat as number
        } as Parameters<typeof figures>[0]).creditedSats,
      0
    );
    const after = await call('GET', '/getbalance');
    expect(after.feeCreditSat).toBe(0);
    expect(ledger).toBe(after.balanceSat + after.feeCreditSat);
  });
});

describe('sync', () => {
  beforeEach(() => {
    routeFetch();
    phoenixdDown = false;
    lnbitsDown = false;
    scope = 'limited';
    useMockEnv();
    // The test files share one in-memory database: touch only this module's state.
    db.delete(schema.lightningPayments).run();
    db.delete(schema.settings).where(like(schema.settings.key, 'ln_%')).run();
  });

  const rows = () => db.select().from(schema.lightningPayments).all();

  test('copies every completed payment once; re-running adds nothing', async () => {
    const first = await syncLightning({ force: true });
    expect(first.ok).toBe(true);
    expect(first.added).toBe(SCENARIO.incoming.length + SCENARIO.outgoing.length);
    const second = await syncLightning({ force: true });
    expect(second.added).toBe(0);
    expect(rows()).toHaveLength(SCENARIO.incoming.length + SCENARIO.outgoing.length);
  });

  test('each liquidity purchase pairs with the payment that carries its fee', async () => {
    await syncLightning({ force: true });
    const purchases = rows().filter((r) => r.subType === 'auto_liquidity');
    expect(purchases).toHaveLength(2);
    for (const p of purchases) {
      expect(p.review).toBe('paired');
      const trigger = rows().find((r) => r.key === p.pairedKey)!;
      expect(trigger.direction).toBe('in');
      expect(trigger.feeMsat).toBe(p.feeMsat);
    }
  });

  test('LNbits adds comments and zaps; only a properly signed zap is verified', async () => {
    await syncLightning({ force: true });
    const zaps = rows().filter((r) => r.zapPubkey != null);
    expect(zaps).toHaveLength(2);
    expect(zaps.filter((z) => z.zapVerified).map((z) => z.zapContent)).toEqual(['great post']);
    expect(rows().find((r) => r.comment === 'Thanks for the open-source work')).toBeTruthy();
    // the CLI invoice never went through LNbits
    const cli = rows().find((r) => r.description === 'invoice from the CLI')!;
    expect(cli.comment).toBeNull();
    expect(cli.zapPubkey).toBeNull();
  });

  test('without NOSTR_PUBKEY a zap names nobody', async () => {
    delete process.env.NOSTR_PUBKEY;
    await syncLightning({ force: true });
    expect(rows().filter((r) => r.zapVerified)).toEqual([]);
    useMockEnv();
    await syncLightning({ force: true });
    expect(rows().filter((r) => r.zapVerified)).toHaveLength(1);
  });

  test('a zap request lifted from one payment names nobody on another', async () => {
    // The reviewer's replay: one validly signed request for us, attached to
    // two payments ten minutes apart. Only the first may name its sender.
    const sk = hexToBytes('22'.repeat(32));
    const zapper = bytesToHex(schnorr.getPublicKey(sk));
    const at = NOW - 3600;
    const e = {
      pubkey: zapper,
      createdAt: at - 30,
      kind: 9734,
      tags: [
        ['amount', '5000000'],
        ['p', mock.MOCK_NOSTR_PUBKEY]
      ],
      content: 'twice?'
    };
    const id = eventId(e);
    const nostr = JSON.stringify({
      id,
      pubkey: zapper,
      created_at: e.createdAt,
      kind: 9734,
      tags: e.tags,
      content: e.content,
      sig: bytesToHex(schnorr.sign(hexToBytes(id), sk))
    });
    for (const [label, when] of [
      ['replay first', at],
      ['replay second', at + 600]
    ] as const) {
      const hash = bytesToHex(new Bun.CryptoHasher('sha256').update(label).digest());
      SCENARIO.incoming.push({
        type: 'incoming_payment',
        subType: 'lightning',
        paymentHash: hash,
        isPaid: true,
        requestedSat: 5_000,
        receivedSat: 5_000,
        fees: 0,
        createdAt: when * 1000 - 5000,
        completedAt: when * 1000
      });
      SCENARIO.lnbits.push({
        checking_id: hash,
        payment_hash: hash,
        amount: 5_000_000,
        fee: 0,
        status: 'success',
        time: new Date(when * 1000).toISOString(),
        extra: { tag: 'lnurlp', nostr }
      });
    }
    try {
      await syncLightning({ force: true, full: true });
      const twice = rows().filter((r) => r.zapContent === 'twice?');
      expect(twice).toHaveLength(2);
      expect(twice.map((r) => r.zapId)).toEqual([id, id]);
      expect(twice.sort((a, b) => a.completedAt - b.completedAt).map((r) => r.zapVerified)).toEqual(
        [true, false]
      );
    } finally {
      SCENARIO.incoming.splice(-2, 2);
      SCENARIO.lnbits.splice(-2, 2);
    }
  });

  test('a sync never resets review state', async () => {
    await syncLightning({ force: true });
    const t = schema.lightningPayments;
    const one = rows().find((r) => r.direction === 'in' && r.subType === 'lightning')!;
    db.update(t).set({ review: 'ignored' }).where(eqId(one.id)).run();
    await syncLightning({ force: true });
    expect(rows().find((r) => r.id === one.id)!.review).toBe('ignored');
  });

  test('LNbits down: the sync still succeeds, with a warning', async () => {
    lnbitsDown = true;
    const s = await syncLightning({ force: true });
    expect(s.ok).toBe(true);
    expect(s.warning).toMatch(/LNbits/);
    expect(rows().some((r) => r.comment != null)).toBe(false);
  });

  test('phoenixd down: the sync fails and says why; nothing is written', async () => {
    phoenixdDown = true;
    const s = await syncLightning({ force: true });
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/unreachable/);
    expect(rows()).toHaveLength(0);
    expect(lastSync()?.ok).toBe(false);
  });

  test('automatic syncs are throttled; a forced one is not', async () => {
    await syncLightning({ force: true });
    const at = lastSync()!.at;
    phoenixdDown = true; // a real request now would fail
    const again = await syncLightning();
    expect(again.ok).toBe(true);
    expect(again.at).toBe(at);
  });

  test('the view: newest first, fees in sats, a hand-entered row with the hash counts as recorded', async () => {
    await syncLightning({ force: true });
    const nodeId = lastSync()!.nodeId!;
    const comment = rows().find((r) => r.comment === 'Thanks for the open-source work')!;
    const wallet = db
      .insert(schema.wallets)
      .values({ name: 'Lightning test node', kind: 'hot', layer: 'lightning', createdAt: NOW })
      .returning({ id: schema.wallets.id })
      .get();
    const now = NOW;
    const inserted = db
      .insert(schema.transactions)
      .values({
        type: 'INCOME',
        ts: comment.completedAt,
        walletId: wallet.id,
        amountSats: comment.amountSat,
        fiatCurrency: 'INR',
        fiatAmountMinor: 100,
        fxRateToInr: 1,
        inrValueMinor: 100,
        txid: comment.paymentHash,
        refKind: 'lightning',
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: schema.transactions.id })
      .get();
    const view = listPayments(nodeId);
    expect(view[0].completedAt).toBeGreaterThanOrEqual(view[1].completedAt);
    const v = view.find((p) => p.key === comment.key)!;
    expect(v.txIdInLedger).toBe(inserted.id);
    const topUp = view.find(
      (p) => p.direction === 'in' && p.feeSat > 0 && p.requestedSat === 40_000
    )!;
    expect(topUp.feeSat).toBe(22_100);
    expect(topUp.amountSat).toBe(17_900);
    expect(importKeyFor(topUp.key)).toBe(`phoenixd:${topUp.key}`);
    db.delete(schema.transactions).where(eq(schema.transactions.id, inserted.id)).run();
    db.delete(schema.wallets).where(eq(schema.wallets.id, wallet.id)).run();
  });
});

const eqId = (id: number) => eq(schema.lightningPayments.id, id);
