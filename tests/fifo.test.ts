// FIFO engine suite — the 12 cases from docs/design-architecture.md §10.
// Runs under TZ=America/New_York to prove IST/FY math ignores the runtime TZ.
import { describe, expect, test } from 'bun:test';
import { computePortfolio } from '../src/lib/server/engine/fifo';
import type { Portfolio, Tx } from '../src/lib/types';
import { mulDivRound, SATS_PER_BTC } from '../src/lib/utils/money';
import { istInputToUtcSec } from '../src/lib/utils/time';

const BTC = SATS_PER_BTC;

// --- terse ledger builders -------------------------------------------------

type TxSpec = Omit<Tx, 'id'>;

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
	notes: null,
	source: 'manual'
} satisfies Omit<TxSpec, 'type' | 'ts' | 'amountSats'>;

const acq =
	(type: 'INCOME' | 'BUY') =>
	(ts: number, sats: number, inr: number, walletId = 1, extra: Partial<TxSpec> = {}): TxSpec => ({
		...BASE,
		type,
		ts,
		amountSats: sats,
		inrValueMinor: inr,
		fiatCurrency: 'INR',
		walletId,
		...extra
	});
const disp =
	(type: 'SELL' | 'SPEND') =>
	(ts: number, sats: number, inr: number, walletId = 1, extra: Partial<TxSpec> = {}): TxSpec => ({
		...BASE,
		type,
		ts,
		amountSats: sats,
		inrValueMinor: inr,
		fiatCurrency: 'INR',
		walletId,
		...extra
	});
const buy = acq('BUY');
const income = acq('INCOME');
const sell = disp('SELL');
const spend = disp('SPEND');
const transfer = (
	ts: number,
	sats: number,
	from: number,
	to: number,
	feeSats = 0,
	feeInrValueMinor: number | null = null,
	extra: Partial<TxSpec> = {}
): TxSpec => ({
	...BASE,
	type: 'TRANSFER',
	ts,
	amountSats: sats,
	fromWalletId: from,
	toWalletId: to,
	feeSats,
	feeInrValueMinor,
	...extra
});

/** Assigns ids 1..n in array order (the monotonic-PK tie-break). */
const ledger = (...specs: TxSpec[]): Tx[] => specs.map((s, i) => ({ ...s, id: i + 1 }));

// --- shared assertions -----------------------------------------------------

const sumBalances = (p: Portfolio) =>
	Object.values(p.walletBalancesSats).reduce((a, b) => a + b, 0);

function expectHoldingsInvariant(p: Portfolio) {
	expect(p.holdingsSats).toBe(p.openLots.reduce((s, l) => s + l.remainingSats, 0));
	expect(p.holdingsSats).toBe(sumBalances(p));
}

/** Every number in the output must be a finite integer — no NaN, no floats. */
function expectWellFormed(v: unknown): void {
	if (typeof v === 'number') {
		expect(Number.isFinite(v)).toBe(true);
		expect(Number.isInteger(v)).toBe(true);
	} else if (Array.isArray(v)) for (const x of v) expectWellFormed(x);
	else if (v !== null && typeof v === 'object')
		for (const x of Object.values(v)) expectWellFormed(x);
}

function expectDisposalArithmetic(p: Portfolio) {
	for (const d of p.disposals) {
		expect(d.slices.reduce((s, x) => s + x.costMinor, 0)).toBe(d.totalCostMinor);
		expect(d.taxableConservativeMinor).toBe(d.slices.reduce((s, x) => s + x.incomeMinor, 0));
		expect(d.netGainMinor).toBe(d.considerationMinor - d.totalCostMinor);
		for (const s of d.slices)
			expect(s.incomeMinor).toBe(Math.max(0, s.considerationMinor - s.costMinor));
	}
}

// ---------------------------------------------------------------------------

const T0 = istInputToUtcSec('2025-06-01T10:00');
const H = 3600;

describe('1. single BUY, partial SELL', () => {
	test('lot splits; consumed + remaining cost === original cost exactly', () => {
		const cost = 499_999_937; // odd paise so rounding actually happens
		const txs = ledger(buy(T0, BTC, cost), sell(T0 + H, 33_333_333, 200_000_000));
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.openLots).toHaveLength(1);
		const lot = p.openLots[0];
		expect(lot.lotTxId).toBe(1);
		expect(lot.originalSats).toBe(BTC);
		expect(lot.remainingSats).toBe(BTC - 33_333_333);
		const consumed = p.disposals[0].totalCostMinor;
		expect(consumed).toBe(mulDivRound(cost, 33_333_333, BTC));
		expect(consumed + lot.remainingCostMinor).toBe(cost);
		expectHoldingsInvariant(p);
	});

	test('exact exhaustion takes the whole remaining cost — no rounding dust', () => {
		const cost = 499_999_937;
		const txs = ledger(
			buy(T0, BTC, cost),
			sell(T0 + H, 33_333_333, 200_000_000),
			sell(T0 + 2 * H, BTC - 33_333_333, 400_000_000)
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.openLots).toEqual([]);
		expect(p.holdingsSats).toBe(0);
		expect(p.disposals[0].totalCostMinor + p.disposals[1].totalCostMinor).toBe(cost);
	});
});

describe('2. SELL spanning 3 lots', () => {
	test('3 VdaRows; slice costs and considerations conserve exactly', () => {
		const costs = [500_000_001, 300_000_007, 1_400_000_003];
		const consideration = 1_600_000_001;
		const txs = ledger(
			buy(T0, BTC, costs[0]),
			buy(T0 + H, 50_000_000, costs[1]),
			buy(T0 + 2 * H, 2 * BTC, costs[2]),
			sell(T0 + 3 * H, 220_000_000, consideration)
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.vdaRows).toHaveLength(3);
		const d = p.disposals[0];
		expect(d.slices.map((s) => s.lotTxId)).toEqual([1, 2, 3]);
		expect(d.slices.map((s) => s.satsConsumed)).toEqual([BTC, 50_000_000, 70_000_000]);
		// full lots take exact remaining cost; the partial third is mulDivRound'ed
		expect(d.slices.map((s) => s.costMinor)).toEqual([
			500_000_001,
			300_000_007,
			mulDivRound(1_400_000_003, 70_000_000, 2 * BTC)
		]);
		// Σ slice costs === cost removed from the queue
		const acqCost = costs.reduce((a, b) => a + b, 0);
		const openCost = p.openLots.reduce((s, l) => s + l.remainingCostMinor, 0);
		expect(d.totalCostMinor).toBe(acqCost - openCost);
		// Σ slice considerations === disposal consideration (last slice = remainder)
		expect(d.slices.reduce((s, x) => s + x.considerationMinor, 0)).toBe(consideration);
		expectDisposalArithmetic(p);
		expectHoldingsInvariant(p);
	});

	test('remainder lands on the LAST slice, not naive rounding', () => {
		// 3 one-sat lots, 100p consideration: naive rounding gives 33/33/33 = 99.
		const txs = ledger(
			buy(T0, 1, 10),
			buy(T0 + 1, 1, 10),
			buy(T0 + 2, 1, 10),
			sell(T0 + 3, 3, 100)
		);
		const p = computePortfolio(txs);
		expect(p.disposals[0].slices.map((s) => s.considerationMinor)).toEqual([33, 33, 34]);
	});
});

describe('3. loss disposal', () => {
	test('conservative income floors at 0; net gain stays negative; FY delta visible', () => {
		const txs = ledger(
			buy(T0, BTC, 1_000_000_000), // ₹1Cr
			buy(T0 + H, BTC, 500_000_000), // ₹50L
			sell(T0 + 2 * H, BTC, 800_000_000), // lot 1 → −₹20L loss
			sell(T0 + 3 * H, BTC, 700_000_000) // lot 2 → +₹20L gain
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		const [loss, gain] = p.disposals;
		expect(loss.netGainMinor).toBe(-200_000_000);
		expect(loss.taxableConservativeMinor).toBe(0);
		expect(loss.slices[0].incomeMinor).toBe(0);
		expect(gain.netGainMinor).toBe(200_000_000);
		expect(gain.taxableConservativeMinor).toBe(200_000_000);
		// FY aggregation over vdaRows: conservative vs net, plus the delta
		const fy = loss.fy;
		const rows = p.vdaRows.filter((r) => r.fy === fy);
		const conservative = rows.reduce((s, r) => s + r.incomeMinor, 0);
		const net = rows.reduce((s, r) => s + (r.considerationMinor - r.costMinor), 0);
		expect(conservative).toBe(200_000_000);
		expect(net).toBe(0);
		expect(conservative - net).toBe(200_000_000);
	});
});

describe('4. TRANSFER with fee', () => {
	const lot1Cost = 50_000_000; // 0.1 BTC
	const lot2Cost = 600_000_000; // 1 BTC
	const fee = 624;
	const txs = ledger(
		buy(T0, 10_000_000, lot1Cost, 1),
		buy(T0 + H, BTC, lot2Cost, 1),
		transfer(T0 + 2 * H, 50_000_000, 1, 2, fee, 6000)
	);

	test('balances shift; fee leaves the queue with NO disposal and NO VdaRow', () => {
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.disposals).toEqual([]);
		expect(p.vdaRows).toEqual([]);
		expect(p.walletBalancesSats).toEqual({
			1: 10_000_000 + BTC - 50_000_000 - fee,
			2: 50_000_000
		});
		// head lot lost exactly the fee sats + their pro-rated cost; lot 2 untouched
		const feeCost = mulDivRound(lot1Cost, fee, 10_000_000);
		expect(p.openLots).toEqual([
			{
				lotTxId: 1,
				acquiredTs: T0,
				originalSats: 10_000_000,
				remainingSats: 10_000_000 - fee,
				remainingCostMinor: lot1Cost - feeCost
			},
			{
				lotTxId: 2,
				acquiredTs: T0 + H,
				originalSats: BTC,
				remainingSats: BTC,
				remainingCostMinor: lot2Cost
			}
		]);
		expect(p.netInvestedMinor).toBe(lot1Cost + lot2Cost);
		expectHoldingsInvariant(p);
	});

	test('moved sats kept their global-FIFO position: later SELL from wallet 2 consumes lot 1 first', () => {
		const p = computePortfolio([
			...txs,
			{ ...sell(T0 + 3 * H, 20_000_000, 130_000_000, 2), id: 4 }
		]);
		expect(p.issues).toEqual([]);
		const d = p.disposals[0];
		expect(d.slices.map((s) => s.lotTxId)).toEqual([1, 2]);
		expect(d.slices[0].satsConsumed).toBe(10_000_000 - fee);
		expect(d.slices.reduce((s, x) => s + x.considerationMinor, 0)).toBe(130_000_000);
		expectDisposalArithmetic(p);
		expectHoldingsInvariant(p);
	});
});

describe('5. fees are never taxable', () => {
	test('TRANSFER fee consumes lots without any disposal or VDA row', () => {
		const txs = ledger(
			buy(T0, BTC, 500_000_000, 1),
			transfer(T0 + H, 60_000_000, 1, 2, 1000, 6000)
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.disposals).toHaveLength(0);
		expect(p.vdaRows).toHaveLength(0);
		// moved sats stay in the lot (global FIFO); only the 1000 fee sats leave,
		// taking their pro-rata cost (5 paise/sat)
		expect(p.openLots[0].remainingSats).toBe(BTC - 1000);
		expect(p.openLots[0].remainingCostMinor).toBe(500_000_000 - 5000);
		expect(p.walletBalancesSats[1]).toBe(BTC - 60_001_000);
		expect(p.walletBalancesSats[2]).toBe(60_000_000);
		expectHoldingsInvariant(p);
	});

	test('SELL fee: disposal covers only amountSats; fee sats consumed after, untaxed', () => {
		const txs = ledger(
			buy(T0, BTC, 500_000_000, 1),
			sell(T0 + H, 20_000_000, 150_000_000, 1, { feeSats: 1000 })
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.disposals).toHaveLength(1);
		const d = p.disposals[0];
		expect(d.satsDisposed).toBe(20_000_000);
		expect(d.considerationMinor).toBe(150_000_000);
		expect(d.totalCostMinor).toBe(100_000_000); // 2e7 sats at 5 paise/sat
		expect(d.netGainMinor).toBe(50_000_000);
		// fee consumed after the disposal at the same 5 paise/sat basis
		expect(p.openLots[0].remainingSats).toBe(BTC - 20_001_000);
		expect(p.openLots[0].remainingCostMinor).toBe(500_000_000 - 100_000_000 - 5000);
		expect(p.walletBalancesSats[1]).toBe(BTC - 20_001_000);
		expect(p.vdaRows.every((r) => r.disposalKind !== 'FEE')).toBe(true);
		expectDisposalArithmetic(p);
		expectHoldingsInvariant(p);
	});

	test('SPEND fee behaves identically', () => {
		const txs = ledger(
			buy(T0, BTC, 500_000_000, 1),
			spend(T0 + H, 20_000_000, 150_000_000, 1, { feeSats: 624 })
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.disposals).toHaveLength(1);
		expect(p.holdingsSats).toBe(BTC - 20_000_624);
		expectHoldingsInvariant(p);
	});

	test('feeInrValueMinor is purely informational — output ignores it', () => {
		const a = computePortfolio(
			ledger(buy(T0, BTC, 500_000_000, 1), transfer(T0 + H, 50_000_000, 1, 2, 1000, null))
		);
		const b = computePortfolio(
			ledger(buy(T0, BTC, 500_000_000, 1), transfer(T0 + H, 50_000_000, 1, 2, 1000, 999_999))
		);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe('6. INCOME lot basis', () => {
	test('basis = INR FMV at receipt; later SELL pulls cost from it', () => {
		const txs = ledger(
			income(T0, 50_000_000, 400_000_000, 1),
			sell(T0 + H, 20_000_000, 250_000_000, 1)
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		const s = p.disposals[0].slices[0];
		expect(s.lotTxId).toBe(1);
		expect(s.acquiredTs).toBe(T0);
		expect(s.costMinor).toBe(mulDivRound(400_000_000, 20_000_000, 50_000_000)); // 160000000
		expect(s.incomeMinor).toBe(250_000_000 - 160_000_000);
		expect(p.openLots[0].remainingCostMinor).toBe(240_000_000);
		expect(p.netInvestedMinor).toBe(400_000_000 - 250_000_000);
		expectHoldingsInvariant(p);
	});
});

describe('7. same-timestamp ordering', () => {
	test('BUY entered after a same-second SELL still ranks first — no INSUFFICIENT_LOTS', () => {
		const txs = ledger(
			sell(T0, 40_000_000, 260_000_000, 1), // id 1, but SELL ranks after BUY
			buy(T0, BTC, 600_000_000, 1) // id 2
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.disposals[0].slices[0].lotTxId).toBe(2);
	});

	test('same ts, same type → ordered by id', () => {
		const txs = ledger(
			buy(T0, BTC, 500_000_000, 1),
			buy(T0, BTC, 900_000_000, 1),
			sell(T0, 50_000_000, 350_000_000, 1)
		);
		const p = computePortfolio(txs);
		const s = p.disposals[0].slices[0];
		expect(s.lotTxId).toBe(1);
		expect(s.costMinor).toBe(250_000_000);
	});

	test('explicit seq overrides typeRank at the same ts', () => {
		const txs = ledger(
			sell(T0, 10_000_000, 100_000_000, 1), // seq null → 0, runs FIRST
			buy(T0, BTC, 500_000_000, 1, { seq: 1 })
		);
		const p = computePortfolio(txs);
		expect(p.issues.some((i) => i.code === 'INSUFFICIENT_LOTS' && i.txId === 1)).toBe(true);
	});
});

describe('8. backdated insert', () => {
	test('an earlier cheap BUY appended later (higher id) changes the SELL basis', () => {
		const base: TxSpec[] = [
			buy(T0 + H, BTC, 900_000_000, 1),
			sell(T0 + 2 * H, 50_000_000, 400_000_000, 1)
		];
		const before = computePortfolio(ledger(...base));
		expect(before.disposals[0].totalCostMinor).toBe(450_000_000);
		expect(before.disposals[0].slices[0].lotTxId).toBe(1);

		const after = computePortfolio(ledger(...base, buy(T0, BTC, 200_000_000, 1)));
		expect(after.issues).toEqual([]);
		expect(after.disposals[0].totalCostMinor).toBe(100_000_000);
		expect(after.disposals[0].slices[0].lotTxId).toBe(3); // the backdated lot is the new head
		expectHoldingsInvariant(after);
	});
});

describe('9. INSUFFICIENT_LOTS', () => {
	test('exact shortfall reported; partial consumption; engine keeps going, output well-formed', () => {
		const txs = ledger(
			buy(T0, 50_000_000, 400_000_000, 1),
			sell(T0 + H, 80_000_000, 700_000_000, 1), // 3e7 sats short
			buy(T0 + 2 * H, BTC, 500_000_000, 1),
			sell(T0 + 3 * H, 10_000_000, 90_000_000, 1) // must still compute cleanly
		);
		const p = computePortfolio(txs);
		const short = p.issues.find((i) => i.code === 'INSUFFICIENT_LOTS')!;
		expect(short.txId).toBe(2);
		expect(short.detail).toContain('30000000');
		// the same SELL also drives wallet 1 negative — both problems surface at once
		expect(p.issues.some((i) => i.code === 'NEGATIVE_WALLET_BALANCE' && i.txId === 2)).toBe(true);
		const d = p.disposals[0];
		expect(d.satsDisposed).toBe(80_000_000);
		expect(d.slices).toHaveLength(1);
		expect(d.slices[0].satsConsumed).toBe(50_000_000);
		expect(d.totalCostMinor).toBe(400_000_000); // full lot, exact exhaustion
		// processing continued past the bad row
		const d2 = p.disposals[1];
		expect(d2.slices[0].lotTxId).toBe(3);
		expect(d2.totalCostMinor).toBe(50_000_000);
		expectWellFormed(p);
	});
});

describe('10. NEGATIVE_WALLET_BALANCE', () => {
	test('transfer out of an underfunded wallet names the wallet and resulting balance', () => {
		const txs = ledger(buy(T0, BTC, 500_000_000, 1), transfer(T0 + H, 50_000_000, 2, 3));
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([
			{
				txId: 2,
				code: 'NEGATIVE_WALLET_BALANCE',
				detail: 'wallet 2 balance would be -50000000 sats'
			}
		]);
		// transfers are Σ-neutral: the holdings invariant still reconciles
		expect(p.walletBalancesSats).toEqual({ 1: BTC, 2: -50_000_000, 3: 50_000_000 });
		expectHoldingsInvariant(p);
		expectWellFormed(p);
	});
});

describe('11. FY boundary (IST)', () => {
	test('Mar 31 23:00 IST vs Apr 1 00:30 IST land in different FYs', () => {
		const txs = ledger(
			buy(istInputToUtcSec('2025-03-01T12:00'), BTC, 500_000_000, 1),
			sell(istInputToUtcSec('2025-03-31T23:00'), 10_000_000, 100_000_000, 1),
			// 19:00 UTC Mar 31 — a UTC-date implementation would misfile this one
			sell(istInputToUtcSec('2025-04-01T00:30'), 10_000_000, 100_000_000, 1)
		);
		const p = computePortfolio(txs);
		expect(p.issues).toEqual([]);
		expect(p.disposals.map((d) => d.fy)).toEqual(['FY2024-25', 'FY2025-26']);
		expect(p.vdaRows.map((r) => r.fy)).toEqual(['FY2024-25', 'FY2025-26']);
	});
});

describe('12. property-style invariants', () => {
	// deterministic PRNG so failures reproduce
	function mulberry32(seed: number) {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const randInt = (rng: () => number, lo: number, hi: number) =>
		lo + Math.floor(rng() * (hi - lo + 1));
	const shuffle = <T>(arr: T[], rng: () => number): T[] => {
		const a = [...arr];
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	};

	test('random valid ledgers at 1–10 BTC / ₹50L–₹1Cr magnitudes hold every invariant', () => {
		const rng = mulberry32(0xb7c5eed);
		for (let iter = 0; iter < 150; iter++) {
			const specs: TxSpec[] = [];
			const bal: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
			let queueSats = 0;
			let acqSats = 0;
			let acqInr = 0;
			let disposedInr = 0;
			let feeSatsTotal = 0;
			let feeEvents = 0;
			let ts = 1_600_000_000;
			const n = randInt(rng, 5, 25);

			for (let i = 0; i < n; i++) {
				ts += randInt(rng, 60, 90_000);
				const pricePaisePerBtc = randInt(rng, 500_000_000, 1_000_000_000);
				const pushAcquisition = () => {
					const w = randInt(rng, 1, 3);
					const sats = randInt(rng, BTC, 10 * BTC);
					const inr = mulDivRound(pricePaisePerBtc, sats, BTC);
					specs.push(rng() < 0.5 ? buy(ts, sats, inr, w) : income(ts, sats, inr, w));
					bal[w] += sats;
					queueSats += sats;
					acqSats += sats;
					acqInr += inr;
				};
				const funded = [1, 2, 3].filter((w) => bal[w] > 0);
				const roll = i === 0 ? 0 : rng();
				if (roll < 0.45 || funded.length === 0) {
					pushAcquisition();
				} else if (roll < 0.75) {
					const w = funded[randInt(rng, 0, funded.length - 1)];
					const avail = Math.min(queueSats, bal[w]);
					const fee = avail > 1 && rng() < 0.4 ? randInt(rng, 0, Math.min(2000, avail - 1)) : 0;
					const sats = randInt(rng, 1, avail - fee);
					const inr = mulDivRound(pricePaisePerBtc, sats, BTC);
					specs.push(
						rng() < 0.5
							? sell(ts, sats, inr, w, { feeSats: fee })
							: spend(ts, sats, inr, w, { feeSats: fee })
					);
					bal[w] -= sats + fee;
					queueSats -= sats + fee;
					disposedInr += inr;
					feeSatsTotal += fee;
					if (fee > 0) feeEvents++;
				} else {
					const from = funded[randInt(rng, 0, funded.length - 1)];
					const to = from === 3 ? 1 : from + 1;
					const fee = randInt(rng, 0, Math.min(2000, bal[from] - 1));
					const amount = randInt(rng, 1, bal[from] - fee);
					const feeInr = fee > 0 ? mulDivRound(pricePaisePerBtc, fee, BTC) : null;
					specs.push(transfer(ts, amount, from, to, fee, feeInr));
					bal[from] -= amount + fee;
					bal[to] += amount;
					queueSats -= fee;
					feeSatsTotal += fee;
					if (fee > 0) feeEvents++;
				}
			}

			const txs = ledger(...specs);
			const p = computePortfolio(shuffle(txs, rng));

			expect(p.issues).toEqual([]);
			expectHoldingsInvariant(p);
			expectWellFormed(p);

			// determinism: input order must not matter — byte-identical output
			expect(JSON.stringify(computePortfolio(txs))).toBe(JSON.stringify(p));

			// sats conservation: acquired = held + disposed + consumed as fees
			const consumedSats = p.disposals.reduce(
				(s, d) => s + d.slices.reduce((x, sl) => x + sl.satsConsumed, 0),
				0
			);
			expect(p.holdingsSats + consumedSats + feeSatsTotal).toBe(acqSats);

			// cost conservation: fee-consumed cost leaves the queue silently but is
			// bounded by the generated price range (5–10 paise/sat, ± rounding)
			const openCost = p.openLots.reduce((s, l) => s + l.remainingCostMinor, 0);
			const disposedCost = p.disposals.reduce((s, d) => s + d.totalCostMinor, 0);
			const feeCost = acqInr - openCost - disposedCost;
			expect(feeCost).toBeGreaterThanOrEqual(feeSatsTotal * 5 - feeEvents * 2);
			expect(feeCost).toBeLessThanOrEqual(feeSatsTotal * 10 + feeEvents * 2);
			if (feeSatsTotal === 0) expect(feeCost).toBe(0);

			expect(p.netInvestedMinor).toBe(acqInr - disposedInr);

			// no FEE rows ever surface in tax output
			expect(p.disposals.every((d) => d.kind !== 'FEE')).toBe(true);
			expect(p.vdaRows.every((r) => r.disposalKind !== 'FEE')).toBe(true);

			// per-disposal slice arithmetic, incl. Σ considerations === consideration
			for (const d of p.disposals)
				expect(d.slices.reduce((s, x) => s + x.considerationMinor, 0)).toBe(d.considerationMinor);
			expectDisposalArithmetic(p);
		}
	});

	test('pure function: frozen input, repeated calls → byte-identical', () => {
		const txs = ledger(
			buy(T0, BTC, 500_000_000, 1),
			transfer(T0 + H, 40_000_000, 1, 2, 500, 3000),
			sell(T0 + 2 * H, 30_000_000, 200_000_000, 2)
		);
		txs.forEach(Object.freeze);
		Object.freeze(txs);
		const a = computePortfolio(txs);
		const b = computePortfolio(txs);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});
