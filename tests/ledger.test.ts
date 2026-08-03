// Ledger CRUD suite. DATABASE_PATH must be set BEFORE the db module loads, so
// every server module is imported dynamically after the env assignment (static
// imports would hoist above it). No network: ledger.ts never touches rates.
import { describe, expect, test } from 'bun:test';

process.env.DATABASE_PATH = ':memory:';
delete process.env.ADMIN_PASSWORD;

const { createTx, createTxPair, deleteTx, getLedger, getPortfolio, previewDraft, updateTx } =
	await import('../src/lib/server/ledger');
const { db, schema } = await import('../src/lib/server/db');
const { eq } = await import('drizzle-orm');

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const T0 = now - 30 * DAY;

// Two live wallets + one archived (id 3) for the archived-rejection case, plus
// a live exchange wallet (id 4) for the composite buy+withdrawal pair.
db.insert(schema.wallets)
	.values([
		{ id: 1, name: 'Regular', kind: 'hot', sortOrder: 0, createdAt: now },
		{ id: 2, name: 'Savings', kind: 'cold', sortOrder: 1, createdAt: now },
		{
			id: 3,
			name: 'Old Exchange',
			kind: 'exchange',
			sortOrder: 2,
			archivedAt: now,
			createdAt: now
		},
		{ id: 4, name: 'Exchange', kind: 'exchange', sortOrder: 3, createdAt: now }
	])
	.run();

const BASE = {
	seq: null,
	walletId: null,
	fromWalletId: null,
	toWalletId: null,
	feeSats: 0,
	fiatCurrency: null,
	fiatAmountMinor: null,
	fxRateToInr: null,
	inrValueMinor: null,
	feeInrValueMinor: null,
	btcUsdRate: null,
	enteredRate: null,
	rateSource: null,
	txid: null,
	notes: null
};

// Base ledger: INCOME 1M, BUY 2M, SELL 1.5M (spans both lots), SPEND 100k,
// TRANSFER 1M+500 fee to Savings. Regular ends at 399 500, Savings at 1M.
const income = {
	...BASE,
	type: 'INCOME',
	ts: T0,
	walletId: 1,
	amountSats: 1_000_000,
	fiatCurrency: 'USD',
	fiatAmountMinor: 120_000,
	fxRateToInr: 83.5,
	inrValueMinor: 10_020_000
};
const buy = {
	...BASE,
	type: 'BUY',
	ts: T0 + DAY,
	walletId: 1,
	amountSats: 2_000_000,
	fiatCurrency: 'INR',
	fiatAmountMinor: 2_000_000,
	fxRateToInr: 1,
	inrValueMinor: 2_000_000
};
const sell = {
	...BASE,
	type: 'SELL',
	ts: T0 + 2 * DAY,
	walletId: 1,
	amountSats: 1_500_000,
	fiatCurrency: 'INR',
	fiatAmountMinor: 1_800_000,
	fxRateToInr: 1,
	inrValueMinor: 1_800_000
};
const spend = {
	...BASE,
	type: 'SPEND',
	ts: T0 + 3 * DAY,
	walletId: 1,
	amountSats: 100_000,
	fiatCurrency: 'EUR',
	fiatAmountMinor: 1_000,
	fxRateToInr: 90,
	inrValueMinor: 90_000
};
const transfer = {
	...BASE,
	type: 'TRANSFER',
	ts: T0 + 4 * DAY,
	fromWalletId: 1,
	toWalletId: 2,
	amountSats: 1_000_000,
	feeSats: 500,
	feeInrValueMinor: 5_000
};

let incomeId = 0;
let buyId = 0;
let sellId = 0;
let spendId = 0;

describe('createTx', () => {
	test('happy path for every type', () => {
		for (const [draft, assign] of [
			[income, (id: number) => (incomeId = id)],
			[buy, (id: number) => (buyId = id)],
			[sell, (id: number) => (sellId = id)],
			[spend, (id: number) => (spendId = id)],
			[transfer, () => {}]
		] as const) {
			const res = createTx(draft);
			expect(res.ok).toBe(true);
			if (res.ok) assign(res.id);
		}
		const ledger = getLedger();
		expect(ledger.length).toBe(5);
		expect(ledger.map((t) => t.type)).toEqual(['INCOME', 'BUY', 'SELL', 'SPEND', 'TRANSFER']);
		expect(ledger[0]).toMatchObject({
			id: incomeId,
			amountSats: 1_000_000,
			fiatCurrency: 'USD',
			inrValueMinor: 10_020_000,
			source: 'manual'
		});
		// TRANSFER row normalized: no walletId, no fiat fields.
		expect(ledger[4]).toMatchObject({
			walletId: null,
			inrValueMinor: null,
			fiatCurrency: null,
			feeSats: 500,
			feeInrValueMinor: 5_000
		});
	});

	test('coerces numeric strings', () => {
		const res = createTx({
			...buy,
			ts: T0 + 4 * DAY + 1,
			amountSats: '250000',
			inrValueMinor: '250000'
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			const row = getLedger().find((t) => t.id === res.id)!;
			expect(row.amountSats).toBe(250_000);
			expect(deleteTx(res.id).ok).toBe(true);
		}
	});

	test('SELL accepts feeSats and feeInrValueMinor', () => {
		const res = createTx({
			...sell,
			ts: T0 + 5 * DAY,
			amountSats: 10_000,
			fiatAmountMinor: 12_000,
			inrValueMinor: 12_000,
			feeSats: 100,
			feeInrValueMinor: 120
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			const row = getLedger().find((t) => t.id === res.id)!;
			expect(row.feeSats).toBe(100);
			expect(row.feeInrValueMinor).toBe(120);
			expect(deleteTx(res.id).ok).toBe(true);
		}
	});

	test('rejects a future timestamp', () => {
		const res = createTx({ ...buy, ts: now + 3600 });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.errors).toContain('timestamp is in the future');
	});

	test('rejects TRANSFER between the same wallet', () => {
		const res = createTx({ ...transfer, toWalletId: 1 });
		expect(res.ok).toBe(false);
		if (!res.ok)
			expect(res.errors).toContain('TRANSFER source and destination wallets must differ');
	});

	test('rejects TRANSFER missing wallets', () => {
		const res = createTx({ ...transfer, fromWalletId: null, toWalletId: null });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errors).toContain('TRANSFER requires fromWalletId');
			expect(res.errors).toContain('TRANSFER requires toWalletId');
		}
	});

	test('rejects non-TRANSFER missing fiat fields and walletId', () => {
		const res = createTx({ ...BASE, type: 'BUY', ts: T0, amountSats: 1000 });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errors).toContain('BUY requires walletId');
			expect(res.errors).toContain('BUY requires fiatCurrency (INR, USD or EUR)');
			expect(res.errors).toContain('BUY requires fxRateToInr > 0');
			expect(res.errors).toContain('BUY requires inrValueMinor ≥ 0 (paise)');
		}
	});

	test('rejects non-positive or non-integer amountSats', () => {
		for (const bad of [0, -5, 1.5, 'abc', null]) {
			const res = createTx({ ...buy, amountSats: bad });
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.errors).toContain('amountSats must be a positive integer (satoshis)');
		}
	});

	test('rejects unknown and archived wallets', () => {
		const missing = createTx({ ...buy, walletId: 99 });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.errors).toContain('wallet 99 does not exist');
		const archived = createTx({ ...buy, walletId: 3 });
		expect(archived.ok).toBe(false);
		if (!archived.ok) expect(archived.errors).toContain('wallet "Old Exchange" is archived');
	});

	test('rejects an oversell with a readable error naming wallet and date', () => {
		const res = createTx({ ...sell, ts: T0 + 5 * DAY, amountSats: 100_000_000 });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errors.some((e) => e.includes('Regular'))).toBe(true);
			expect(res.errors.some((e) => /SELL on \d+ \w+ ’\d\d/.test(e))).toBe(true);
			expect(res.errors.some((e) => e.includes('short'))).toBe(true);
		}
		expect(getLedger().length).toBe(5); // nothing written
	});
});

describe('getLedger ordering', () => {
	test('orders by (ts, seq??0, id)', () => {
		const late = {
			...buy,
			ts: T0 + 6 * DAY,
			amountSats: 1000,
			inrValueMinor: 100,
			fiatAmountMinor: 100
		};
		const a = createTx({ ...late, seq: 2 });
		const b = createTx({ ...late, seq: 1 });
		expect(a.ok && b.ok).toBe(true);
		if (a.ok && b.ok) {
			const tail = getLedger().slice(-2);
			expect(tail.map((t) => t.id)).toEqual([b.id, a.id]); // seq 1 before seq 2 despite later id
			expect(deleteTx(a.id).ok).toBe(true);
			expect(deleteTx(b.id).ok).toBe(true);
		}
	});
});

describe('getPortfolio', () => {
	test('replays the stored ledger with no issues', () => {
		const p = getPortfolio();
		expect(p.issues).toEqual([]);
		expect(p.holdingsSats).toBe(1_399_500);
		expect(p.walletBalancesSats[1]).toBe(399_500);
		expect(p.walletBalancesSats[2]).toBe(1_000_000);
		expect(p.netInvestedMinor).toBe(10_020_000 + 2_000_000 - 1_800_000 - 90_000);
	});
});

describe('previewDraft', () => {
	test('returns a disposal breakdown for a SELL draft without writing', () => {
		const before = getLedger().length;
		const res = previewDraft({
			...BASE,
			id: null,
			type: 'SELL',
			ts: T0 + 5 * DAY,
			walletId: 1,
			amountSats: 200_000,
			fiatCurrency: 'INR',
			fiatAmountMinor: 300_000,
			fxRateToInr: 1,
			inrValueMinor: 300_000
		});
		expect(res.ok).toBe(true);
		expect(res.issues).toEqual([]);
		expect(res.disposal).not.toBeNull();
		expect(res.disposal!.kind).toBe('SELL');
		expect(res.disposal!.satsDisposed).toBe(200_000);
		expect(res.disposal!.considerationMinor).toBe(300_000);
		expect(res.disposal!.slices.length).toBeGreaterThanOrEqual(1);
		expect(getLedger().length).toBe(before); // preview never writes
	});

	test('reports issues for an oversell draft', () => {
		const res = previewDraft({
			...BASE,
			id: null,
			type: 'SELL',
			ts: T0 + 5 * DAY,
			walletId: 1,
			amountSats: 50_000_000,
			fiatCurrency: 'INR',
			fiatAmountMinor: 100,
			fxRateToInr: 1,
			inrValueMinor: 100
		});
		expect(res.ok).toBe(false);
		expect(res.issues.some((i) => i.code === 'INSUFFICIENT_LOTS')).toBe(true);
		expect(res.issues.some((i) => i.code === 'NEGATIVE_WALLET_BALANCE')).toBe(true);
	});

	test('substitutes an existing row when id matches', () => {
		const res = previewDraft({ ...sell, id: sellId, amountSats: 1_200_000 } as never);
		expect(res.ok).toBe(true);
		expect(res.disposal!.txId).toBe(sellId);
		expect(res.disposal!.satsDisposed).toBe(1_200_000);
	});

	test('shape-invalid draft previews as not ok', () => {
		const res = previewDraft({ ...BASE, id: null, type: 'SELL', ts: T0, amountSats: -1 } as never);
		expect(res.ok).toBe(false);
		expect(res.disposal).toBeNull();
	});

	test('TRANSFER draft with fee but no feeInrValueMinor is warn-only (allowed)', () => {
		const res = previewDraft({
			...BASE,
			id: null,
			type: 'TRANSFER',
			ts: T0 + 5 * DAY,
			fromWalletId: 2,
			toWalletId: 1,
			amountSats: 10_000,
			feeSats: 100
		});
		expect(res.ok).toBe(true);
	});
});

describe('updateTx', () => {
	test('unknown id → not found', () => {
		const res = updateTx(9999, spend);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.errors[0]).toContain('not found');
	});

	test('happy update rewrites the row', () => {
		const res = updateTx(spendId, { ...spend, notes: 'coffee' });
		expect(res.ok).toBe(true);
		const row = db
			.select()
			.from(schema.transactions)
			.where(eq(schema.transactions.id, spendId))
			.get()!;
		expect(row.notes).toBe('coffee');
	});

	test('recompute rejection: shrinking a BUY that later txs depend on', () => {
		const res = updateTx(buyId, { ...buy, amountSats: 100_000 });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errors.some((e) => e.includes('Regular'))).toBe(true);
			expect(res.errors.some((e) => e.includes('below zero') || e.includes('short'))).toBe(true);
		}
		const row = db
			.select()
			.from(schema.transactions)
			.where(eq(schema.transactions.id, buyId))
			.get()!;
		expect(row.amountSats).toBe(2_000_000); // unchanged
	});
});

describe('deleteTx', () => {
	test('unknown id → not found', () => {
		const res = deleteTx(9999);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.errors[0]).toContain('not found');
	});

	test('recompute rejection: deleting a BUY a later SELL depends on', () => {
		const res = deleteTx(buyId);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			// SELL 1.5M would find only the 1M INCOME lot → INSUFFICIENT_LOTS.
			expect(res.errors.some((e) => e.includes('short 500000 sats'))).toBe(true);
			expect(res.errors.some((e) => e.includes('SELL') && e.includes('Regular'))).toBe(true);
		}
		expect(getLedger().some((t) => t.id === buyId)).toBe(true); // still there
	});

	test('happy delete removes the row', () => {
		const res = deleteTx(spendId);
		expect(res.ok).toBe(true);
		expect(getLedger().some((t) => t.id === spendId)).toBe(false);
		expect(getPortfolio().issues).toEqual([]);
	});
});

describe('createTxPair', () => {
	// Composite exchange buy: BUY into the exchange wallet + the self-custody
	// withdrawal TRANSFER, validated together and inserted atomically.
	const pairBuy = {
		...BASE,
		type: 'BUY',
		ts: T0 + 10 * DAY,
		walletId: 4,
		amountSats: 300_000,
		fiatCurrency: 'INR',
		fiatAmountMinor: 300_000,
		fxRateToInr: 1,
		inrValueMinor: 300_000
	};
	const pairTransfer = {
		...BASE,
		type: 'TRANSFER',
		ts: T0 + 10 * DAY + 7200,
		fromWalletId: 4,
		toWalletId: 2,
		amountSats: 299_000,
		feeSats: 1_000,
		feeInrValueMinor: 1_000
	};

	test('happy path inserts both rows and the ledger replays cleanly', () => {
		const before = getLedger().length;
		const res = createTxPair(pairBuy, pairTransfer);
		expect(res.ok).toBe(true);
		if (res.ok) {
			const ledger = getLedger();
			expect(ledger.length).toBe(before + 2);
			expect(ledger.find((t) => t.id === res.buyId)!.type).toBe('BUY');
			const transferRow = ledger.find((t) => t.id === res.transferId)!;
			expect(transferRow).toMatchObject({
				type: 'TRANSFER',
				fromWalletId: 4,
				toWalletId: 2,
				feeSats: 1_000
			});
			const p = getPortfolio();
			expect(p.issues).toEqual([]);
			expect(p.walletBalancesSats[4]).toBe(0); // 300k in, 299k + 1k fee out
			expect(p.walletBalancesSats[2]).toBe(1_299_000);
		}
	});

	test('withdrawal engine failure rolls back the buy; wallets unaffected', () => {
		const before = getLedger().length;
		const balancesBefore = getPortfolio().walletBalancesSats;
		const res = createTxPair(
			{
				...pairBuy,
				ts: T0 + 11 * DAY,
				amountSats: 100_000,
				fiatAmountMinor: 100_000,
				inrValueMinor: 100_000
			},
			{
				...pairTransfer,
				ts: T0 + 11 * DAY + 3600,
				amountSats: 200_000,
				feeSats: 0,
				feeInrValueMinor: null
			}
		);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errors.length).toBeGreaterThan(0);
			expect(res.errors.every((e) => e.startsWith('withdrawal: '))).toBe(true);
			expect(res.errors.some((e) => e.includes('Exchange'))).toBe(true);
		}
		expect(getLedger().length).toBe(before); // buy rolled back too
		// The non-exchange destination wallet is untouched by the failed pair.
		expect(getPortfolio().walletBalancesSats[2]).toBe(balancesBefore[2]);
		expect(getPortfolio().walletBalancesSats[4]).toBe(balancesBefore[4]);
	});

	test('withdrawal parse failure is prefixed and writes nothing', () => {
		const before = getLedger().length;
		const res = createTxPair(
			{ ...pairBuy, ts: T0 + 11 * DAY },
			{ ...pairTransfer, ts: T0 + 11 * DAY + 3600, toWalletId: 4 }
		);
		expect(res.ok).toBe(false);
		if (!res.ok)
			expect(res.errors).toContain(
				'withdrawal: TRANSFER source and destination wallets must differ'
			);
		expect(getLedger().length).toBe(before);
	});

	test('rejects a pair whose legs are not BUY + TRANSFER', () => {
		const res = createTxPair(pairTransfer, pairBuy);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errors).toContain('the first leg of a pair must be a BUY');
			expect(res.errors).toContain('withdrawal: the second leg of a pair must be a TRANSFER');
		}
	});
});
