// Hand-computed scale math for the portfolio SVG chart. Pure functions, no DOM.
// Y values are integer paise; timestamps are unix seconds UTC (chart points are
// UTC calendar days, matching /api/chart).

export interface NiceScale {
	lo: number;
	hi: number;
	step: number;
	ticks: number[];
}

/**
 * Smallest "nice" step (1 / 2 / 2.5 / 5 × 10^n) ≥ raw. Lands y-gridlines on
 * clean lakh/crore multiples for typical INR portfolio magnitudes.
 */
export function niceStep(raw: number): number {
	if (!(raw > 0)) return 1;
	const pow = 10 ** Math.floor(Math.log10(raw));
	for (const m of [1, 2, 2.5, 5, 10]) {
		const step = m * pow;
		if (step >= raw - pow * 1e-9) return step;
	}
	return 10 * pow;
}

/**
 * Nice linear y-domain: lo/hi snapped to the step grid, inclusive tick list.
 * Flat series get padded so the line never sits on an edge.
 */
export function niceYDomain(min: number, max: number, targetTicks = 4): NiceScale {
	if (min > max) [min, max] = [max, min];
	let span = max - min;
	if (span === 0) span = Math.max(Math.abs(max), 10_000); // flat: pad by magnitude or ₹100
	const step = niceStep(span / targetTicks);
	const lo = Math.floor(min / step) * step;
	let hi = Math.ceil(max / step) * step;
	if (hi === lo) hi = lo + step;
	const ticks: number[] = [];
	for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
	return { lo, hi, step, ticks };
}

export interface TimeTick {
	ts: number;
	label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Sparse month/year ticks over [t0, t1] (unix sec UTC), ≤ maxTicks.
 * - short spans (≤ ~10 weeks): weekly '8 Jul' ticks anchored at t0
 * - month-scale: month boundaries aligned to the calendar (quarters, half-years),
 *   labeled 'May', with January carrying the year ('Jan ’24')
 * - multi-year: 'Jan ’23'-style year ticks (or every 2nd/4th year)
 */
export function timeTicks(t0: number, t1: number, maxTicks = 7): TimeTick[] {
	if (t1 <= t0) return [];
	const DAY = 86400;
	const spanDays = (t1 - t0) / DAY;

	if (spanDays <= 70) {
		const stepDays = spanDays <= 40 ? 7 : 14;
		const out: TimeTick[] = [];
		for (let ts = t0 + stepDays * DAY; ts <= t1; ts += stepDays * DAY) {
			const d = new Date(ts * 1000);
			out.push({ ts, label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` });
		}
		return out;
	}

	const d0 = new Date(t0 * 1000);
	const d1 = new Date(t1 * 1000);
	const m0 = d0.getUTCFullYear() * 12 + d0.getUTCMonth();
	const m1 = d1.getUTCFullYear() * 12 + d1.getUTCMonth();
	const spanMonths = m1 - m0 + 1;
	const step = [1, 2, 3, 6, 12, 24, 48].find((s) => Math.ceil(spanMonths / s) <= maxTicks) ?? 96;

	const out: TimeTick[] = [];
	for (let m = Math.ceil(m0 / step) * step; m <= m1; m += step) {
		const year = Math.floor(m / 12);
		const month = m - year * 12;
		const ts = Date.UTC(year, month, 1) / 1000;
		if (ts < t0 || ts > t1) continue;
		const yy = `’${(year % 100).toString().padStart(2, '0')}`;
		const label = step >= 12 ? `${year}` : month === 0 ? `${MONTHS[month]} ${yy}` : MONTHS[month];
		out.push({ ts, label });
	}
	return out;
}

/**
 * Contiguous runs of non-null valueMinor as inclusive [start, end] index pairs.
 * The value path breaks at every null — no interpolation across candle gaps.
 */
export function valueSegments(
	points: readonly { valueMinor: number | null }[]
): Array<[number, number]> {
	const segs: Array<[number, number]> = [];
	let start = -1;
	for (let i = 0; i < points.length; i++) {
		if (points[i].valueMinor != null) {
			if (start < 0) start = i;
		} else if (start >= 0) {
			segs.push([start, i - 1]);
			start = -1;
		}
	}
	if (start >= 0) segs.push([start, points.length - 1]);
	return segs;
}
