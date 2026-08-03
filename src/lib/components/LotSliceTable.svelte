<script lang="ts">
	// Per-lot consumption table — shared by the entry-form gain preview, ledger
	// row expansion and tax center (spec §3.4 / §4 / §6). Loss slices render
	// income ₹0 with the raw negative muted beside it ("floored" voice).
	import { unit } from '$lib/stores/unit.svelte';
	import type { LotSlice } from '$lib/types';
	import { formatBtc, formatInr, formatSats } from '$lib/utils/money';
	import { formatIstDateShort } from '$lib/utils/time';

	let { slices, compact = false }: { slices: LotSlice[]; compact?: boolean } = $props();

	const fmtAmount = $derived(unit.value === 'btc' ? formatBtc : formatSats);
	const cellY = $derived(compact ? 'py-1' : 'py-1.5');
</script>

<div class="overflow-x-auto">
	<table class="w-full border-collapse num {compact ? 'text-[11px]' : 'text-xs'}">
		<thead>
			<tr class="border-b border-border">
				<th class="label-caps {cellY} pr-3 text-left font-medium">acquired</th>
				<th class="label-caps {cellY} pr-3 text-right font-medium">
					{unit.value === 'btc' ? 'btc' : 'sats'}
				</th>
				<th class="label-caps {cellY} pr-3 text-right font-medium">cost</th>
				<th class="label-caps {cellY} pr-3 text-right font-medium">consideration</th>
				<th class="label-caps {cellY} text-right font-medium">income</th>
			</tr>
		</thead>
		<tbody>
			{#each slices as s (`${s.lotTxId}-${s.acquiredTs}-${s.satsConsumed}`)}
				{@const raw = s.considerationMinor - s.costMinor}
				<tr class="border-b border-border/60 last:border-0">
					<td class="{cellY} pr-3 whitespace-nowrap">{formatIstDateShort(s.acquiredTs)}</td>
					<td class="{cellY} pr-3 text-right whitespace-nowrap">{fmtAmount(s.satsConsumed)}</td>
					<td class="{cellY} pr-3 text-right whitespace-nowrap">{formatInr(s.costMinor)}</td>
					<td class="{cellY} pr-3 text-right whitespace-nowrap">
						{formatInr(s.considerationMinor)}
					</td>
					<td class="{cellY} text-right whitespace-nowrap">
						{#if raw < 0}
							<span>₹0</span>
							<span class="ml-1 derived" title="floored in conservative view">
								({formatInr(raw)})
							</span>
						{:else}
							{formatInr(s.incomeMinor)}
						{/if}
					</td>
				</tr>
			{:else}
				<tr>
					<td colspan="5" class="py-3 text-center text-muted">— No lots consumed —</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
