// Indian financial year (Apr 1 – Mar 31) bucketing, keyed to the IST calendar
// date of a UTC timestamp. FY labels look like 'FY2025-26'.

import { IST_OFFSET_SEC } from './time';

/** unix sec UTC → 'FY2025-26' (IST-based; a disposal at Mar 31 23:00 IST vs Apr 1 00:30 IST differs). */
export function fyOf(ts: number): string {
	const d = new Date((ts + IST_OFFSET_SEC) * 1000);
	const y = d.getUTCFullYear();
	const startYear = d.getUTCMonth() >= 3 ? y : y - 1; // months 0-based; Apr = 3
	return fyLabel(startYear);
}

export function fyLabel(startYear: number): string {
	return `FY${startYear}-${((startYear + 1) % 100).toString().padStart(2, '0')}`;
}

/** 'FY2025-26' → its FY start year (2025). Throws on malformed labels. */
export function fyStartYear(fy: string): number {
	const m = /^FY(\d{4})-(\d{2})$/.exec(fy);
	if (!m) throw new Error(`fyStartYear: bad FY label '${fy}'`);
	return parseInt(m[1], 10);
}

/** Half-open UTC range [startTs, endTs) covering the FY in IST wall time. */
export function fyRange(fy: string): { startTs: number; endTs: number } {
	const y = fyStartYear(fy);
	const startTs = Math.floor(Date.UTC(y, 3, 1) / 1000) - IST_OFFSET_SEC;
	const endTs = Math.floor(Date.UTC(y + 1, 3, 1) / 1000) - IST_OFFSET_SEC;
	return { startTs, endTs };
}

/** Every FY label from the FY containing minTs through the FY containing maxTs, ascending. */
export function fySpan(minTs: number, maxTs: number): string[] {
	const first = fyStartYear(fyOf(minTs));
	const last = fyStartYear(fyOf(maxTs));
	const out: string[] = [];
	for (let y = first; y <= last; y++) out.push(fyLabel(y));
	return out;
}
