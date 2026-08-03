// All IST handling uses a fixed +5:30 offset (IST has no DST) and Date.UTC
// arithmetic exclusively — never the runtime's local timezone. datetime-local
// inputs are treated as IST wall time regardless of the browser's timezone.

export const IST_OFFSET_SEC = 5.5 * 3600;

const pad = (n: number) => n.toString().padStart(2, '0');

/** 'YYYY-MM-DDTHH:mm[:ss]' (IST wall time from a datetime-local input) → unix sec UTC. */
export function istInputToUtcSec(value: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
	if (!m) throw new Error(`istInputToUtcSec: cannot parse '${value}'`);
	const [, y, mo, d, h, mi, s] = m;
	const wallMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
	return Math.floor(wallMs / 1000) - IST_OFFSET_SEC;
}

/** unix sec UTC → 'YYYY-MM-DDTHH:mm' for a datetime-local input showing IST wall time. */
export function utcSecToIstInput(ts: number): string {
	const d = new Date((ts + IST_OFFSET_SEC) * 1000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** IST calendar date 'YYYY-MM-DD' of a UTC timestamp (drives FY bucketing). */
export function istDateString(ts: number): string {
	return utcSecToIstInput(ts).slice(0, 10);
}

/** UTC calendar date 'YYYY-MM-DD' (drives the FX cache key). */
export function utcDateString(ts: number): string {
	const d = new Date(ts * 1000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Table date: '14 May ’23' (IST). */
export function formatIstDateShort(ts: number): string {
	const d = new Date((ts + IST_OFFSET_SEC) * 1000);
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ’${d.getUTCFullYear() % 100}`;
}

/** Full: '2023-05-14 20:30 IST'. */
export function formatIstFull(ts: number): string {
	const d = new Date((ts + IST_OFFSET_SEC) * 1000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

/** Full UTC: '2023-05-14 15:00 UTC'. */
export function formatUtcFull(ts: number): string {
	const d = new Date(ts * 1000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Relative: 'just now', '4m ago', '3h ago', '2d ago'. */
export function formatRelative(ts: number, now: number): string {
	const s = Math.max(0, now - ts);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}
