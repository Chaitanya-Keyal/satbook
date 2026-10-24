// The review inbox: the pure classification rules (what a payment can become
// and the exact ledger draft), then recording, linking and ignoring against
// the mock node. Prices come from 1h candles seeded into the cache, so no
// rate provider is ever called. Test files share one in-memory database, so
// everything created here is removed again.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

process.env.DATABASE_PATH = ':memory:';
delete process.env.ADMIN_PASSWORD;

const { draftFor, figures, suggest } = await import('../src/lib/server/lightning/classify');
const { db, schema } = await import('../src/lib/server/db');
const { syncLightning } = await import('../src/lib/server/lightning/sync');
const { setLightningWallet } = await import('../src/lib/server/lightning/node');
const review = await import('../src/lib/server/lightning/review');
const { getLedger, getPortfolio } = await import('../src/lib/server/ledger');
const mock = await import('../scripts/mock-phoenixd');
const { eq, inArray, like } = await import('drizzle-orm');

type Row = typeof schema.lightningPayments.$inferSelect;
const row = (over: Partial<Row>): Row => ({
	id: 1,
	nodeId: 'node',
	key: 'in:aa',
	direction: 'in',
	subType: 'lightning',
	paymentHash: 'aa'.repeat(32),
	txId: null,
	amountSat: 21_000,
	feeMsat: 0,
	requestedSat: 21_000,
	description: null,
	payerNote: null,
	completedAt: 1_700_000_000,
	memo: null,
	comment: null,
	lnAddress: null,
	zapPubkey: null,
	zapContent: null,
	zapVerified: null,
	review: 'pending',
	pairedKey: null,
	syncedAt: 1_700_000_000,
	...over
});
const CTX = { nodeWalletId: 10, rate: 7_000_000, rateSource: 'binance-1h' };

describe('figures', () => {
	test('incoming without a fee: the amount received', () => {
		expect(figures(row({}))).toEqual({
			amountSats: 21_000,
			feeSats: 0,
			creditedSats: 21_000,
			certain: true
		});
	});

	test('a payment that bought liquidity: the payer’s amount, the fee, what was credited', () => {
		const f = figures(row({ amountSat: 8_289, feeMsat: 21_711_000, requestedSat: 30_000 }));
		expect(f).toEqual({ amountSats: 30_000, feeSats: 21_711, creditedSats: 8_289, certain: true });
	});

	test('no invoice amount: reconstructed, and flagged as uncertain', () => {
		const f = figures(row({ amountSat: 8_289, feeMsat: 21_711_000, requestedSat: null }));
		expect(f.amountSats).toBe(30_000);
		expect(f.certain).toBe(false);
	});

	test('outgoing: phoenixd’s `sent` includes the fee', () => {
		const f = figures(row({ direction: 'out', amountSat: 61_200, feeMsat: 1_200_000 }));
		expect(f.amountSats).toBe(60_000);
		expect(f.feeSats).toBe(1_200);
	});
});

describe('suggest', () => {
	test('a Lightning Address payment suggests a donation; a CLI invoice plain income', () => {
		expect(suggest(row({ comment: 'thanks', lnAddress: 'you@example.com' })).kind).toBe('donation');
		const cli = suggest(row({ description: 'invoice from the CLI' }));
		expect(cli.kind).toBe('income');
		expect(cli.note).toBe('invoice from the CLI');
	});

	test('only a verified zap names its sender', () => {
		const pk = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
		expect(suggest(row({ zapPubkey: pk, zapVerified: true })).counterparty).toMatch(/^npub1/);
		expect(suggest(row({ zapPubkey: pk, zapVerified: false })).counterparty).toBe('');
	});

	test('what each outgoing kind can become', () => {
		expect(
			suggest(row({ direction: 'out', subType: 'splice_out', amountSat: 61_200 })).action
		).toBe('transfer');
		expect(suggest(row({ direction: 'out', subType: 'lightning', amountSat: 1_004 })).action).toBe(
			'spend'
		);
		const lone = suggest(row({ direction: 'out', subType: 'auto_liquidity' }));
		expect(lone.actions).toEqual([]);
		expect(lone.manualReason).toMatch(/liquidity/);
	});

	test('a fee larger than the payment: income only, nothing to transfer', () => {
		const s = suggest(row({ amountSat: -21_000, feeMsat: 22_000_000, requestedSat: 1_000 }));
		expect(s.actions).toEqual(['income']);
		expect(s.figures.creditedSats).toBe(-21_000);
	});
});

describe('draftFor', () => {
	test('income: the payer’s amount valued at the time, the fee kept, the hash as reference', () => {
		const r = draftFor(
			row({ amountSat: 8_289, feeMsat: 21_711_000, requestedSat: 30_000, comment: 'hi' }),
			{ action: 'income', kind: 'donation', counterparty: ' A. Donor ', note: 'hi' },
			CTX
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.draft).toMatchObject({
			type: 'INCOME',
			walletId: 10,
			amountSats: 30_000,
			feeSats: 21_711,
			fiatCurrency: 'INR',
			inrValueMinor: 210_000, // 30 000 sats at ₹70,00,000 = ₹2,100
			feeInrValueMinor: 151_977,
			txid: 'aa'.repeat(32),
			refKind: 'lightning',
			incomeKind: 'donation',
			counterparty: 'A. Donor',
			notes: 'hi'
		});
	});

	test('your own payment in: a transfer crediting what landed, fee = node’s + sender’s', () => {
		const r = draftFor(
			row({ amountSat: 8_289, feeMsat: 21_711_000, requestedSat: 30_000 }),
			{ action: 'transfer', otherWalletId: 3, senderFeeSats: 124 },
			CTX
		);
		expect(r.ok && r.draft).toMatchObject({
			type: 'TRANSFER',
			fromWalletId: 3,
			toWalletId: 10,
			amountSats: 8_289,
			feeSats: 21_835
		});
	});

	test('a sweep: a transfer out with the on-chain txid', () => {
		const r = draftFor(
			row({
				direction: 'out',
				subType: 'splice_out',
				amountSat: 61_200,
				feeMsat: 1_200_000,
				paymentHash: null,
				txId: 'bb'.repeat(32)
			}),
			{ action: 'transfer', otherWalletId: 2 },
			CTX
		);
		expect(r.ok && r.draft).toMatchObject({
			fromWalletId: 10,
			toWalletId: 2,
			amountSats: 60_000,
			feeSats: 1_200,
			txid: 'bb'.repeat(32),
			refKind: 'onchain'
		});
	});

	test('refusals: the node as the other wallet, a non-option, a negative fee', () => {
		const p = row({});
		expect(draftFor(p, { action: 'transfer', otherWalletId: 10 }, CTX).ok).toBe(false);
		expect(draftFor(p, { action: 'spend' }, CTX).ok).toBe(false);
		expect(draftFor(p, { action: 'transfer', otherWalletId: 3, senderFeeSats: -1 }, CTX).ok).toBe(
			false
		);
	});
});

// --- against the mock node ---------------------------------------------------------

const NOW = Math.floor(Date.now() / 1000);
const SCENARIO = mock.scenario(NOW);
const created = { wallets: [] as number[] };

beforeAll(async () => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		const host = new URL(req.url).host;
		if (host === 'phoenixd.test') return mock.phoenixdHandler(SCENARIO)(req);
		if (host === 'lnbits.test') return mock.lnbitsHandler(SCENARIO)(req);
		throw new Error(`unmocked fetch: ${req.url}`);
	}) as typeof fetch;
	process.env.PHOENIXD_URL = 'http://phoenixd.test';
	process.env.PHOENIXD_PASSWORD = mock.MOCK_PASSWORD.limited;
	process.env.LNBITS_URL = 'http://lnbits.test';
	process.env.LNBITS_INVOICE_KEY = mock.MOCK_INVOICE_KEY;
	db.delete(schema.lightningPayments).run();
	db.delete(schema.settings).where(like(schema.settings.key, 'ln_%')).run();

	for (const [name, kind, layer] of [
		['Review node', 'hot', 'lightning'],
		['Review cold', 'cold', 'onchain'],
		['Review phone', 'hot', 'lightning']
	] as const) {
		const w = db
			.insert(schema.wallets)
			.values({ name, kind, layer, createdAt: NOW })
			.returning({ id: schema.wallets.id })
			.get();
		created.wallets.push(w.id);
	}
	setLightningWallet(created.wallets[0]);
	// Every payment's hour gets a cached 1h candle at ₹70,00,000.
	const hours = new Set(
		[...SCENARIO.incoming, ...SCENARIO.outgoing].map(
			(p) => Math.floor((p.completedAt as number) / 1000 / 3600) * 3600
		)
	);
	for (const h of hours)
		db.insert(schema.priceCandles)
			.values({
				pair: 'BTC_INR',
				interval: '1h',
				periodStart: h,
				close: 7_000_000,
				source: 'binance',
				fetchedAt: NOW
			})
			.onConflictDoNothing()
			.run();
	await syncLightning({ force: true });
});

afterAll(() => {
	db.delete(schema.transactions).where(eq(schema.transactions.source, review.IMPORT_SOURCE)).run();
	db.delete(schema.transactions)
		.where(inArray(schema.transactions.walletId, created.wallets))
		.run();
	db.delete(schema.lightningPayments).run();
	db.delete(schema.settings).where(like(schema.settings.key, 'ln_%')).run();
	db.delete(schema.wallets).where(inArray(schema.wallets.id, created.wallets)).run();
	for (const k of ['PHOENIXD_URL', 'PHOENIXD_PASSWORD', 'LNBITS_URL', 'LNBITS_INVOICE_KEY'])
		delete process.env[k];
});

const pendingKeys = async () => (await review.pendingPayments()).map((p) => p.row.key);
const byNote = async (text: string) =>
	(await review.pendingPayments()).find(
		(p) => p.row.comment === text || p.row.description === text
	)!;

describe('review inbox', () => {
	test('lists what is not in the ledger; paired purchases never show up', async () => {
		const pending = await review.pendingPayments();
		// 6 incoming + sweep + payment out; both auto_liquidity records are paired
		expect(pending).toHaveLength(8);
		expect(pending.every((p) => p.row.subType !== 'auto_liquidity')).toBe(true);
		expect(review.pendingCount()).toBe(8);
		// INR preview at the cached candle: 21 000 sats at ₹70L = ₹1,470
		expect((await byNote('Thanks for the open-source work')).inrMinor).toBe(147_000);
	});

	test('a test-network node refuses to record unless allowed', async () => {
		const p = await byNote('Thanks for the open-source work');
		db.update(schema.settings)
			.set({ value: JSON.stringify({ ...JSON.parse(lastSyncRaw()), chain: 'testnet3' }) })
			.where(eq(schema.settings.key, 'ln_last_sync'))
			.run();
		const res = await review.recordPayment(
			p.row.key,
			{ action: 'income' },
			{ allowTestnet: false }
		);
		expect(res.ok).toBe(false);
		db.update(schema.settings)
			.set({ value: JSON.stringify({ ...JSON.parse(lastSyncRaw()), chain: 'mainnet' }) })
			.where(eq(schema.settings.key, 'ln_last_sync'))
			.run();
	});

	test('bootstrap as a transfer, a top-up as income with its fee: the ledger matches the node', async () => {
		const boot = await byNote('bootstrap');
		const t = await review.recordPayment(
			boot.row.key,
			{ action: 'transfer', otherWalletId: created.wallets[2], senderFeeSats: 124 },
			{ allowTestnet: false }
		);
		// The phone wallet has nothing, so the engine refuses the transfer out of it.
		expect(t.ok).toBe(false);
		// Fund the phone wallet by hand first, then record the bootstrap.
		const fund = db
			.insert(schema.transactions)
			.values({
				type: 'INCOME',
				ts: (boot.row.completedAt as number) - 86400,
				walletId: created.wallets[2],
				amountSats: 100_000,
				fiatCurrency: 'INR',
				fiatAmountMinor: 700_000,
				fxRateToInr: 1,
				inrValueMinor: 700_000,
				createdAt: NOW,
				updatedAt: NOW
			})
			.returning({ id: schema.transactions.id })
			.get();
		expect(fund.id).toBeGreaterThan(0);
		const ok = await review.recordPayment(
			boot.row.key,
			{ action: 'transfer', otherWalletId: created.wallets[2], senderFeeSats: 124 },
			{ allowTestnet: false }
		);
		expect(ok.ok).toBe(true);

		const topUp = (await review.pendingPayments()).find((p) => p.row.requestedSat === 40_000)!;
		expect(
			(await review.recordPayment(topUp.row.key, { action: 'income' }, { allowTestnet: false })).ok
		).toBe(true);
		const rows = getLedger().filter((r) => r.source === review.IMPORT_SOURCE);
		const income = rows.find((r) => r.type === 'INCOME')!;
		expect(income).toMatchObject({ amountSats: 40_000, feeSats: 22_100, incomeKind: 'donation' });
		expect(income.inrValueMinor).toBe(280_000);
		// the node's wallet now holds what the node holds from those two payments
		expect(getPortfolio().walletBalancesSats[created.wallets[0]]).toBe(8_289 + 17_900);
	});

	test('recording twice is refused; the payment leaves the inbox', async () => {
		const p = await byNote('Thanks for the open-source work');
		expect(
			(await review.recordPayment(p.row.key, { action: 'income' }, { allowTestnet: false })).ok
		).toBe(true);
		expect(await pendingKeys()).not.toContain(p.row.key);
		const again = await review.recordPayment(
			p.row.key,
			{ action: 'income' },
			{ allowTestnet: false }
		);
		expect(again.ok).toBe(false);
	});

	test('deleting the ledger row puts the payment back up for review', async () => {
		const imported = getLedger().filter(
			(r) => r.source === review.IMPORT_SOURCE && r.type === 'INCOME' && r.amountSats === 21_000
		);
		expect(imported).toHaveLength(1);
		db.delete(schema.transactions).where(eq(schema.transactions.id, imported[0].id)).run();
		expect((await byNote('Thanks for the open-source work')).row.review).toBe('pending');
	});

	test('link: a row entered by hand takes the payment’s import key', async () => {
		const cli = await byNote('invoice from the CLI');
		const manual = db
			.insert(schema.transactions)
			.values({
				type: 'INCOME',
				ts: cli.row.completedAt + 120,
				walletId: created.wallets[0],
				amountSats: 50_000,
				fiatCurrency: 'INR',
				fiatAmountMinor: 350_000,
				fxRateToInr: 1,
				inrValueMinor: 350_000,
				createdAt: NOW,
				updatedAt: NOW
			})
			.returning({ id: schema.transactions.id })
			.get();
		const fresh = await byNote('invoice from the CLI');
		expect(fresh.candidates.map((c) => c.id)).toContain(manual.id);
		expect(review.linkPayment(cli.row.key, manual.id).ok).toBe(true);
		expect(await pendingKeys()).not.toContain(cli.row.key);
		expect(review.linkPayment(cli.row.key, manual.id).ok).toBe(false);
	});

	test('ignore and restore; the bulk donation records with the suggested fields', async () => {
		const zap = (await review.pendingPayments()).find((p) => p.row.zapVerified === true)!;
		expect(review.setIgnored([zap.row.key], true)).toBe(1);
		expect(await pendingKeys()).not.toContain(zap.row.key);
		expect(review.ignoredPayments().map((r) => r.key)).toContain(zap.row.key);
		expect(review.setIgnored([zap.row.key], false)).toBe(1);
		const res = await review.recordAsSuggested(zap.row.key, 'donation', { allowTestnet: false });
		expect(res.ok).toBe(true);
		const tx = getLedger().find((r) => r.id === (res as { id: number }).id)!;
		expect(tx.counterparty).toMatch(/^npub1/);
		expect(tx.notes).toBe('great post');
	});
});

function lastSyncRaw(): string {
	return db.select().from(schema.settings).where(eq(schema.settings.key, 'ln_last_sync')).get()!
		.value;
}
