// The 2-of-3 triad state machine (spec §3.2) — pure logic, no runes, so it is
// unit-testable under bun. Each field is `manual` (user-typed) or derived: the
// two most-recently-edited fields are manual, the third derives live. Typing
// into the derived field promotes it and demotes the least-recently-edited.
// A prefilled rate ("derived-with-value") participates as a known value until
// the user touches it or it becomes the computed member.

import type { FiatCurrency } from '../../types';
import { indianGroup, SATS_PER_BTC } from '../../utils/money';

export type TriField = 'btc' | 'rate' | 'fiat';

export interface TriadState {
	/** BTC amount as integer satoshis. */
	sats: number | null;
	/** Rate in MAJOR units of the selected fiat per BTC, full precision. */
	rate: number | null;
	/** Fiat amount as integer minor units of the selected fiat. */
	fiatMinor: number | null;
	/** User-edited fields, most recent LAST, max length 2. */
	manual: TriField[];
	/** Rate was filled by a fetch and never user-typed. */
	ratePrefilled: boolean;
}

const ALL: TriField[] = ['btc', 'rate', 'fiat'];

export function initialTriad(): TriadState {
	return { sats: null, rate: null, fiatMinor: null, manual: [], ratePrefilled: false };
}

/** Which field is currently derived (computed), or null when nothing derives. */
export function derivedField(s: TriadState): TriField | null {
	if (s.manual.length >= 2) return ALL.find((f) => !s.manual.includes(f)) ?? null;
	if (s.manual.length === 1 && s.manual[0] !== 'rate' && s.ratePrefilled && s.rate != null)
		return s.manual[0] === 'btc' ? 'fiat' : 'btc';
	return null;
}

/** Has the user ever typed into the rate field? */
export function rateEdited(s: TriadState): boolean {
	return s.manual.includes('rate');
}

/**
 * Recompute the derived member in place. Rounding per spec: derived sats to
 * whole sats, derived fiat to whole minor units; derived rate keeps full
 * precision (display rounds).
 */
export function recomputeTriad(s: TriadState): void {
	const d = derivedField(s);
	if (d === 'fiat') {
		s.fiatMinor =
			s.sats != null && s.rate != null && s.rate > 0 ? Math.round((s.sats * s.rate) / 1e6) : null;
	} else if (d === 'btc') {
		s.sats =
			s.fiatMinor != null && s.rate != null && s.rate > 0
				? Math.round((s.fiatMinor * 1e6) / s.rate)
				: null;
	} else if (d === 'rate') {
		s.rate =
			s.sats != null && s.sats > 0 && s.fiatMinor != null ? (s.fiatMinor * 1e6) / s.sats : null;
	}
}

/**
 * A user keystroke into `field` with the parsed `value` (null = cleared).
 * Promotes the field to manual (demoting the least-recently-edited) and
 * recomputes the derived member.
 */
export function editField(s: TriadState, field: TriField, value: number | null): void {
	if (field === 'rate') s.ratePrefilled = false;
	const i = s.manual.indexOf(field);
	if (i !== -1) s.manual.splice(i, 1);
	s.manual.push(field);
	if (s.manual.length > 2) s.manual.shift();
	if (field === 'btc') s.sats = value;
	else if (field === 'rate') s.rate = value;
	else s.fiatMinor = value;
	recomputeTriad(s);
}

/**
 * Apply a fetched rate (live or historical). No-op when the user has touched
 * the rate or when the rate is currently the computed member. `null` clears a
 * stale prefill (fetch failed for a new timestamp).
 */
export function setPrefilledRate(s: TriadState, rate: number | null): void {
	if (rateEdited(s) || derivedField(s) === 'rate') return;
	s.rate = rate;
	s.ratePrefilled = rate != null;
	recomputeTriad(s);
}

/** "Save & add another": clear amounts, keep the rate (and its provenance). */
export function clearAmounts(s: TriadState): void {
	s.sats = null;
	s.fiatMinor = null;
	s.manual = s.manual.filter((f) => f === 'rate');
	recomputeTriad(s);
}

// ---------------------------------------------------------------------------
// Parsing (tolerant of thin spaces, commas, plain spaces)
// ---------------------------------------------------------------------------

const STRIP = /[\s,\u2009\u00a0]/g;

/** '1 921 337' / '1,921,337' → 1921337. Null when not a plain integer. */
export function parseSatsText(raw: string): number | null {
	const cleaned = raw.replace(STRIP, '');
	if (!/^\d{1,15}$/.test(cleaned)) return null;
	return parseInt(cleaned, 10);
}

/** '0.019 213 37' → 1921337 sats. Tolerates partial input ('1.', '.5'). */
export function parseBtcText(raw: string): number | null {
	const cleaned = raw.replace(STRIP, '');
	if (cleaned === '' || cleaned === '.') return null;
	const m = /^(\d{0,7})(?:\.(\d{0,8}))?$/.exec(cleaned);
	if (!m) return null;
	const whole = m[1] ? parseInt(m[1], 10) : 0;
	const frac = (m[2] ?? '').padEnd(8, '0');
	return whole * SATS_PER_BTC + (frac ? parseInt(frac, 10) : 0);
}

/** Rate text → positive float (major fiat units per BTC), else null. */
export function parseRateText(raw: string): number | null {
	const cleaned = raw.replace(STRIP, '');
	if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
	const n = parseFloat(cleaned);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Plain fiat decimal text → integer minor units (no k/L shorthand — blur handles that). */
export function parseFiatText(raw: string): number | null {
	const cleaned = raw.replace(STRIP, '');
	if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
	const n = parseFloat(cleaned);
	return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// ---------------------------------------------------------------------------
// Display (no currency symbol — the field renders it as a prefix)
// ---------------------------------------------------------------------------

export const CURRENCY_SYMBOL: Record<FiatCurrency, string> = { INR: '₹', USD: '$', EUR: '€' };

function westernGroup(digits: string): string {
	return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function groupFor(currency: FiatCurrency, digits: string): string {
	return currency === 'INR' ? indianGroup(digits) : westernGroup(digits);
}

/** Minor units → grouped major-unit string; cents shown only when nonzero. */
export function formatFiatMinor(minor: number, currency: FiatCurrency): string {
	const sign = minor < 0 ? '−' : '';
	const abs = Math.abs(minor);
	const major = Math.floor(abs / 100);
	const cents = abs % 100;
	const grouped = groupFor(currency, major.toString());
	return `${sign}${grouped}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
}

/** Rate display: 0 decimals when whole-ish, else 2; grouping per currency. */
export function formatRateValue(rate: number, currency: FiatCurrency): string {
	const rounded = Math.round(rate * 100) / 100;
	const whole = Math.trunc(rounded);
	const frac = Math.round((rounded - whole) * 100);
	if (frac === 0) return groupFor(currency, Math.round(rate).toString());
	return `${groupFor(currency, whole.toString())}.${frac.toString().padStart(2, '0')}`;
}
