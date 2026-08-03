// Global sats⇄BTC display unit (Svelte 5 rune state). The layout hydrates it
// from the server-persisted setting on init; toggling writes back via
// POST /api/unit (fire-and-forget — the optimistic local flip is the UX).

import { browser } from '$app/environment';

export const unit = $state({ value: 'sats' as 'sats' | 'btc' });

export function setUnitValue(value: 'sats' | 'btc'): void {
	if (unit.value === value) return;
	unit.value = value;
	if (browser)
		void fetch('/api/unit', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ unit: value })
		}).catch(() => {
			/* persistence failure is non-fatal; next load re-syncs from server */
		});
}

export function toggleUnit(): void {
	setUnitValue(unit.value === 'sats' ? 'btc' : 'sats');
}
