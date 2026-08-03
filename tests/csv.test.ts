// buildVdaCsv is pure (no DB), so the whole suite is exact-string assertions.
// Runs under TZ=America/New_York (package.json test script) — the DD/MM/YYYY
// dates must come from the fixed IST offset, never the runtime timezone.
import { describe, expect, test } from 'bun:test';
import { buildVdaCsv, VDA_CSV_HEADER } from '../src/lib/server/csv';
import type { VdaRow } from '../src/lib/types';

/** IST wall time → unix sec UTC (mirrors istInputToUtcSec, kept inline). */
const ist = (y: number, mo: number, d: number, h = 12, mi = 0) =>
	Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000) - 5.5 * 3600;

const FY = 'FY2025-26';

// A SPEND loss (income floored to 0.00, no txid) early in the FY…
const spendLoss: VdaRow = {
	disposalTxId: 30,
	disposalKind: 'SPEND',
	acquiredTs: ist(2024, 6, 15),
	transferTs: ist(2025, 5, 5),
	satsConsumed: 10_000,
	costMinor: 2_500_50,
	considerationMinor: 1_999_99,
	incomeMinor: 0,
	fy: FY
};

// …then a 2-lot SELL at 10 Jan 2026 00:30 IST (= 9 Jan 19:00 UTC — the IST
// calendar date must win), second slice a floored loss.
const sellTs = ist(2026, 1, 10, 0, 30);
const sellGain: VdaRow = {
	disposalTxId: 42,
	disposalKind: 'SELL',
	acquiredTs: ist(2024, 6, 15),
	transferTs: sellTs,
	satsConsumed: 150_000,
	costMinor: 45_000_00,
	considerationMinor: 52_000_00,
	incomeMinor: 7_000_00,
	fy: FY
};
const sellFloored: VdaRow = {
	disposalTxId: 42,
	disposalKind: 'SELL',
	acquiredTs: ist(2024, 8, 20),
	transferTs: sellTs,
	satsConsumed: 90_000,
	costMinor: 30_000_00,
	considerationMinor: 26_000_00,
	incomeMinor: 0,
	fy: FY
};

// Different FY — must never appear in an FY2025-26 export.
const nextFy: VdaRow = {
	disposalTxId: 50,
	disposalKind: 'SELL',
	acquiredTs: ist(2024, 6, 15),
	transferTs: ist(2026, 5, 1),
	satsConsumed: 5_000,
	costMinor: 100_00,
	considerationMinor: 150_00,
	incomeMinor: 50_00,
	fy: 'FY2026-27'
};

const txids = new Map<number, string | null>([
	[42, 'abc123def'],
	[30, null]
]);

describe('buildVdaCsv', () => {
	test('exact CSV: FY filter, transfer→acquisition sort, floored loss, txid resolution, TOTAL', () => {
		// Deliberately shuffled input — the builder must sort and filter itself.
		const csv = buildVdaCsv([sellFloored, nextFy, sellGain, spendLoss], FY, txids);
		expect(csv).toBe(
			VDA_CSV_HEADER +
				'\n' +
				'1,15/06/2024,05/05/2025,2500.50,1999.99,0.00,SPEND,,10000\n' +
				'2,15/06/2024,10/01/2026,45000.00,52000.00,7000.00,SELL,abc123def,150000\n' +
				'3,20/08/2024,10/01/2026,30000.00,26000.00,0.00,SELL,abc123def,90000\n' +
				'TOTAL,,,77500.50,79999.99,7000.00,,,250000\n'
		);
	});

	test('no rows in FY → header + zero TOTAL only', () => {
		expect(buildVdaCsv([nextFy], FY, txids)).toBe(
			VDA_CSV_HEADER + '\n' + 'TOTAL,,,0.00,0.00,0.00,,,0\n'
		);
	});

	test('missing txid map → empty txid column', () => {
		const csv = buildVdaCsv([sellGain], FY);
		expect(csv).toContain(',SELL,,150000\n');
	});

	test('txid containing a comma gets RFC-4180 quoted', () => {
		const csv = buildVdaCsv([sellGain], FY, new Map([[42, 'ab,"c']]));
		expect(csv).toContain(',SELL,"ab,""c",150000\n');
	});
});
