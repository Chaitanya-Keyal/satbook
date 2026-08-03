<script lang="ts">
	// Small-caps pill: full-strength dot + label on a ~15% tint (spec §4).
	import type { TxType } from '$lib/types';

	let { type }: { type: TxType | 'FEE' } = $props();

	const HUES: Record<TxType | 'FEE', string> = {
		INCOME: 'var(--color-badge-income)',
		BUY: 'var(--color-badge-buy)',
		SELL: 'var(--color-badge-sell)',
		SPEND: 'var(--color-badge-spend)',
		TRANSFER: 'var(--color-badge-transfer)',
		FEE: 'var(--color-badge-fee)'
	};

	const hue = $derived(HUES[type]);
</script>

<span
	class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] text-[10px] leading-none font-medium tracking-[0.08em] lowercase"
	style="color: {hue}; background-color: color-mix(in srgb, {hue} 15%, transparent);"
>
	<span class="size-1.5 rounded-full" style="background-color: {hue}" aria-hidden="true"></span>
	{type.toLowerCase()}
</span>
