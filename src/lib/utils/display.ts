// Unit-aware display helpers shared by every screen. All inputs are integer
// satoshis; formatting delegates to the canonical formatters in money.ts.

import { formatBtc, formatSats } from './money';

export type Unit = 'sats' | 'btc';

/** 1921337 → '1 921 337 sats' | '0.019 213 37 BTC' per the global unit. */
export function formatAmount(sats: number, unit: Unit): string {
	return unit === 'btc' ? `${formatBtc(sats)} BTC` : `${formatSats(sats)} sats`;
}

/**
 * Signed variant: explicit '+' / '−' (true minus comes from the formatter)
 * plus the gain/loss color class for the sign. Zero renders unsigned/uncolored.
 */
export function signedAmount(sats: number, unit: Unit): { text: string; cls: string } {
	const text = sats > 0 ? `+${formatAmount(sats, unit)}` : formatAmount(sats, unit);
	return { text, cls: sats > 0 ? 'text-gain' : sats < 0 ? 'text-loss' : '' };
}

/** 61240.4 → '$61,240' (whole dollars, western grouping; true minus when negative). */
export function formatUsd(usd: number): string {
	const sign = usd < 0 ? '−' : '';
	const grouped = Math.round(Math.abs(usd))
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `${sign}$${grouped}`;
}
