// Display helpers for the Lightning dashboard (client-safe, no server imports).

/** What a synced phoenixd payment was, in words. */
export function paymentLabel(direction: 'in' | 'out', subType: string): string {
	if (direction === 'in') return 'Received';
	switch (subType) {
		case 'lightning':
			return 'Sent';
		case 'splice_out':
			return 'Sent on-chain';
		case 'auto_liquidity':
		case 'manual_liquidity':
			return 'Liquidity purchase';
		case 'splice_cpfp':
			return 'Fee bump';
		case 'channel_close':
			return 'Channel closed';
		default:
			return subType.replaceAll('_', ' ');
	}
}

/** 'npub1abcdef…uvwxyz' */
export function shortNpub(npub: string): string {
	return npub.length > 20 ? `${npub.slice(0, 10)}…${npub.slice(-6)}` : npub;
}

/** The share of a channel bar, as a CSS percentage, never NaN. */
export function pct(part: number, whole: number): string {
	return whole > 0 ? `${Math.max(0, Math.min(100, (part / whole) * 100)).toFixed(2)}%` : '0%';
}
