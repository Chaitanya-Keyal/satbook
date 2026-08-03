// Scale math for the hand-rolled portfolio SVG chart. Runs under
// TZ=America/New_York like the rest of the suite — everything must be UTC-pure.
import { describe, expect, test } from 'bun:test';
import { niceStep, niceYDomain, timeTicks, valueSegments } from '../src/lib/utils/chart';

const DAY = 86400;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;

describe('niceStep', () => {
	test('snaps up to the 1/2/2.5/5 ladder', () => {
		expect(niceStep(1)).toBe(1);
		expect(niceStep(1.1)).toBe(2);
		expect(niceStep(2.2)).toBe(2.5);
		expect(niceStep(3)).toBe(5);
		expect(niceStep(7)).toBe(10);
		expect(niceStep(70)).toBe(100);
	});

	test('lands on lakh-paise multiples at portfolio magnitudes', () => {
		// ₹6.2L span / 4 ticks → raw 1.55e7 paise → snaps to 2e7 paise (₹2L steps)
		expect(niceStep(1.55e7)).toBe(2e7);
		// ₹48L span / 4 → raw 1.2e8 paise → 2e8 paise (₹20L steps)
		expect(niceStep(1.2e8)).toBe(2e8);
	});

	test('exact ladder values stay put despite float pow', () => {
		expect(niceStep(2.5e7)).toBe(2.5e7);
		expect(niceStep(5e6)).toBe(5e6);
	});

	test('degenerate input', () => {
		expect(niceStep(0)).toBe(1);
		expect(niceStep(-5)).toBe(1);
	});
});

describe('niceYDomain', () => {
	test('typical portfolio range 0..₹6.2L', () => {
		const s = niceYDomain(0, 6_20_000_00);
		expect(s.lo).toBe(0);
		expect(s.hi).toBeGreaterThanOrEqual(6_20_000_00);
		expect(s.ticks[0]).toBe(s.lo);
		expect(s.ticks[s.ticks.length - 1]).toBe(s.hi);
		expect(s.ticks.length).toBeGreaterThanOrEqual(3);
		expect(s.ticks.length).toBeLessThanOrEqual(7);
		for (const t of s.ticks) expect(t % s.step).toBe(0);
	});

	test('narrow band away from zero does not force zero in', () => {
		const s = niceYDomain(4_80_000_00, 5_10_000_00);
		expect(s.lo).toBeGreaterThan(0);
		expect(s.lo).toBeLessThanOrEqual(4_80_000_00);
		expect(s.hi).toBeGreaterThanOrEqual(5_10_000_00);
	});

	test('flat series gets padded, never zero-height', () => {
		const s = niceYDomain(1_00_000_00, 1_00_000_00);
		expect(s.hi).toBeGreaterThan(s.lo);
	});

	test('all-zero series still yields a drawable domain', () => {
		const s = niceYDomain(0, 0);
		expect(s.hi).toBeGreaterThan(s.lo);
		expect(s.lo).toBeLessThanOrEqual(0);
	});

	test('negative min (house money) floors below the data', () => {
		const s = niceYDomain(-50_000_00, 3_00_000_00);
		expect(s.lo).toBeLessThanOrEqual(-50_000_00);
		expect(s.ticks).toContain(0);
	});

	test('swapped args tolerated', () => {
		const s = niceYDomain(100, 0);
		expect(s.lo).toBe(0);
	});
});

describe('timeTicks', () => {
	test('1M-ish span → weekly day ticks', () => {
		const t0 = utc(2026, 7, 5);
		const ticks = timeTicks(t0, t0 + 30 * DAY);
		expect(ticks.length).toBeGreaterThanOrEqual(3);
		expect(ticks.length).toBeLessThanOrEqual(5);
		expect(ticks[0].label).toBe('12 Jul');
		for (const t of ticks) expect((t.ts - t0) % (7 * DAY)).toBe(0);
	});

	test('6M span → month-boundary ticks, Jan carries the year', () => {
		const ticks = timeTicks(utc(2025, 11, 10), utc(2026, 4, 20));
		const labels = ticks.map((t) => t.label);
		expect(labels).toContain('Dec');
		expect(labels).toContain('Jan ’26');
		expect(labels.length).toBeLessThanOrEqual(7);
		// every tick is a real month start inside the domain
		for (const t of ticks) {
			const d = new Date(t.ts * 1000);
			expect(d.getUTCDate()).toBe(1);
		}
	});

	test('4.5-year span → aligned quarter/half-year or year ticks, ≤ maxTicks', () => {
		const ticks = timeTicks(utc(2022, 3, 15), utc(2026, 8, 4));
		expect(ticks.length).toBeGreaterThanOrEqual(3);
		expect(ticks.length).toBeLessThanOrEqual(7);
	});

	test('decade span falls back to multi-year steps', () => {
		const ticks = timeTicks(utc(2015, 1, 1), utc(2026, 8, 1));
		expect(ticks.length).toBeLessThanOrEqual(7);
		expect(ticks.every((t) => /^\d{4}$/.test(t.label) || /’/.test(t.label))).toBe(true);
	});

	test('degenerate/empty domains', () => {
		expect(timeTicks(100, 100)).toEqual([]);
		expect(timeTicks(200, 100)).toEqual([]);
	});
});

describe('valueSegments', () => {
	const p = (v: number | null) => ({ valueMinor: v });

	test('no gaps → single segment', () => {
		expect(valueSegments([p(1), p(2), p(3)])).toEqual([[0, 2]]);
	});

	test('nulls break the path, no interpolation across gaps', () => {
		expect(valueSegments([p(1), p(null), p(3), p(4), p(null)])).toEqual([
			[0, 0],
			[2, 3]
		]);
	});

	test('leading nulls and singleton tail', () => {
		expect(valueSegments([p(null), p(null), p(7)])).toEqual([[2, 2]]);
	});

	test('all null (backfilling) → no segments', () => {
		expect(valueSegments([p(null), p(null)])).toEqual([]);
	});

	test('empty input', () => {
		expect(valueSegments([])).toEqual([]);
	});
});
