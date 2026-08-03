// Whole suite runs under TZ=America/New_York (see package.json test script) to
// prove every IST/FY computation is independent of the runtime timezone.
import { describe, expect, test } from 'bun:test';
import { fyOf, fyRange, fySpan, fyStartYear } from '../src/lib/utils/fy';
import {
	btcToSats,
	formatBtc,
	formatInr,
	formatInrCompact,
	formatSats,
	indianGroup,
	mulDivRound,
	parseFiatShorthand,
	toMinor
} from '../src/lib/utils/money';
import {
	formatIstDateShort,
	formatIstFull,
	formatUtcFull,
	istDateString,
	istInputToUtcSec,
	utcDateString,
	utcSecToIstInput
} from '../src/lib/utils/time';

const THIN = '\u2009';
const MINUS = '\u2212';

describe('mulDivRound', () => {
	test('exact small values', () => {
		expect(mulDivRound(10, 3, 2)).toBe(15);
		expect(mulDivRound(7, 3, 2)).toBe(11); // 10.5 rounds up
		expect(mulDivRound(0, 5, 7)).toBe(0);
	});

	test('survives paise×sats magnitudes that overflow Number', () => {
		// ~1 BTC lot at ₹50L: cost 5e8 paise, 1e8 sats — product 5e16 > MAX_SAFE_INTEGER.
		const costPaise = 5_00_00_000_00;
		const lotSats = 100_000_000;
		const half = mulDivRound(costPaise, lotSats / 2, lotSats);
		expect(half).toBe(costPaise / 2);
		// A float implementation drifts on odd splits; BigInt must stay exact.
		expect(mulDivRound(999_999_999_99, 33_333_333, 100_000_000)).toBe(33_333_333_000);
	});

	test('rejects bad inputs', () => {
		expect(() => mulDivRound(-1, 2, 3)).toThrow();
		expect(() => mulDivRound(1, 2, 0)).toThrow();
		expect(() => mulDivRound(1.5, 2, 3)).toThrow();
	});
});

describe('formatting', () => {
	test('sats thin-space grouping', () => {
		expect(formatSats(1_921_337)).toBe(`1${THIN}921${THIN}337`);
		expect(formatSats(624)).toBe('624');
		expect(formatSats(-45_000)).toBe(`${MINUS}45${THIN}000`);
	});

	test('BTC 8dp grouped from decimal point', () => {
		expect(formatBtc(1_921_337)).toBe(`0.019${THIN}213${THIN}37`);
		expect(formatBtc(50_000_000)).toBe(`0.500${THIN}000${THIN}00`);
		expect(formatBtc(250_000_000)).toBe(`2.500${THIN}000${THIN}00`);
	});

	test('Indian digit grouping', () => {
		expect(indianGroup('123456789')).toBe('12,34,56,789');
		expect(indianGroup('1234')).toBe('1,234');
		expect(indianGroup('123')).toBe('123');
	});

	test('INR from paise', () => {
		expect(formatInr(38069440)).toBe('₹3,80,694');
		expect(formatInr(38069440, { paise: 'always' })).toBe('₹3,80,694.40');
		expect(formatInr(-155000_00)).toBe(`${MINUS}₹1,55,000`);
		expect(formatInr(99_50, { paise: 'nonzero' })).toBe('₹99.50');
	});

	test('compact lakh/crore', () => {
		expect(formatInrCompact(4_80_000_00)).toBe('₹4.8L');
		expect(formatInrCompact(1_20_00_000_00)).toBe('₹1.2Cr');
		expect(formatInrCompact(12_400_00)).toBe('₹12.4k');
	});

	test('shorthand parsing', () => {
		expect(parseFiatShorthand('1.2L')).toBe(120000);
		expect(parseFiatShorthand('5k')).toBe(5000);
		expect(parseFiatShorthand('1,20,000')).toBe(120000);
		expect(parseFiatShorthand('abc')).toBeNull();
	});

	test('btcToSats / toMinor float guards', () => {
		expect(btcToSats('0.01010600')).toBe(1_010_600);
		expect(btcToSats('0.010106')).toBe(1_010_600);
		expect(btcToSats(0.00171451)).toBe(171_451);
		expect(toMinor(1199.999999999)).toBe(120000);
		expect(toMinor(2461)).toBe(246100);
	});
});

describe('time (fixed +5:30, TZ-independent)', () => {
	test('IST wall → UTC and back', () => {
		// 2025-07-24 18:34 IST == 13:04 UTC
		const ts = istInputToUtcSec('2025-07-24T18:34');
		expect(ts).toBe(Math.floor(Date.UTC(2025, 6, 24, 13, 4) / 1000));
		expect(utcSecToIstInput(ts)).toBe('2025-07-24T18:34');
	});

	test('IST date crosses midnight before UTC does', () => {
		// 2026-02-04 23:48 UTC == 2026-02-05 05:18 IST
		const ts = Math.floor(Date.UTC(2026, 1, 4, 23, 48) / 1000);
		expect(istDateString(ts)).toBe('2026-02-05');
		expect(utcDateString(ts)).toBe('2026-02-04');
	});

	test('display formats', () => {
		const ts = istInputToUtcSec('2023-05-14T20:30');
		expect(formatIstDateShort(ts)).toBe('14 May ’23');
		expect(formatIstFull(ts)).toBe('2023-05-14 20:30 IST');
		expect(formatUtcFull(ts)).toBe('2023-05-14 15:00 UTC');
	});
});

describe('financial year', () => {
	test('bucketing at the Apr 1 IST boundary', () => {
		expect(fyOf(istInputToUtcSec('2026-03-31T23:00'))).toBe('FY2025-26');
		expect(fyOf(istInputToUtcSec('2026-04-01T00:30'))).toBe('FY2026-27');
		// The same two instants in UTC are 17:30 and 19:00 on Mar 31 — IST must win.
		expect(fyOf(istInputToUtcSec('2025-07-24T18:34'))).toBe('FY2025-26');
	});

	test('range round-trips', () => {
		const { startTs, endTs } = fyRange('FY2025-26');
		expect(fyOf(startTs)).toBe('FY2025-26');
		expect(fyOf(startTs - 1)).toBe('FY2024-25');
		expect(fyOf(endTs - 1)).toBe('FY2025-26');
		expect(fyOf(endTs)).toBe('FY2026-27');
	});

	test('span and parsing', () => {
		expect(fyStartYear('FY2025-26')).toBe(2025);
		expect(() => fyStartYear('2025-26')).toThrow();
		const span = fySpan(istInputToUtcSec('2025-07-24T18:34'), istInputToUtcSec('2026-07-06T05:22'));
		expect(span).toEqual(['FY2025-26', 'FY2026-27']);
	});
});
