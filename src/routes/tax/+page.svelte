<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Info from '@lucide/svelte/icons/info';
	import LotSliceTable from '$lib/components/LotSliceTable.svelte';
	import Tile from '$lib/components/Tile.svelte';
	import TypeBadge from '$lib/components/TypeBadge.svelte';
	import { unit } from '$lib/stores/unit.svelte';
	import { formatAmount } from '$lib/utils/display';
	import { formatBtc, formatInr, formatRateInr, formatSats } from '$lib/utils/money';
	import { formatIstDateShort } from '$lib/utils/time';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const EM = '—';

	const estTaxMinor = $derived(Math.round(data.conservativeMinor * 0.312));
	const csvFilename = $derived(`schedule-vda-${data.fy.toLowerCase()}.csv`);
	const reconciled = $derived(data.holdingsSats === data.walletTotalSats);

	const qty = $derived(unit.value === 'btc' ? formatBtc : formatSats);
	const unitWord = $derived(unit.value === 'btc' ? 'BTC' : 'sats');

	// Row expansion keyed by disposal tx id — ids are FY-unique, so stale keys
	// from a previous FY selection simply never match a rendered row.
	let expanded = $state<Record<number, boolean>>({});
	const toggle = (id: number) => (expanded[id] = !expanded[id]);

	const NET_TOOLTIP =
		'Shown for reference only. Loss set-off against VDA gains is disallowed under s.115BBH; the conservative number is what the export uses.';
</script>

<svelte:head><title>tax · satbook</title></svelte:head>

<div class="flex flex-col gap-4">
	<!-- FY chips -->
	<nav class="flex flex-wrap gap-1.5" aria-label="financial year">
		{#each data.chips as chip (chip)}
			<a
				href="/tax?fy={chip}"
				data-sveltekit-noscroll
				data-sveltekit-keepfocus
				aria-current={chip === data.fy ? 'page' : undefined}
				class="rounded-full border px-3 py-1 num text-xs transition-colors duration-100 {chip ===
				data.fy
					? 'border-accent/60 bg-surface-2 text-text'
					: 'border-border text-muted hover:bg-surface hover:text-text'}"
			>
				{chip}{chip === data.currentFy ? ' · current' : ''}
			</a>
		{/each}
	</nav>

	<!-- Summary row -->
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
		<!-- 1. The filing number — largest number on the page -->
		<Tile
			label="taxable gains · {data.fy.toLowerCase()}"
			value={formatInr(data.conservativeMinor)}
			valueClass="sm:text-3xl!"
		>
			{#snippet subline()}Conservative · per-disposal, losses floored to 0{/snippet}
		</Tile>

		<!-- 2. Estimated tax -->
		<Tile label="estimated tax" value={formatInr(estTaxMinor)}>
			{#snippet subline()}× 31.2% · 30% + 4% cess{/snippet}
		</Tile>

		<!-- 3. Net incl. losses (informational, muted) -->
		<Tile
			label="net incl. losses"
			value={formatInr(data.netMinor, { explicitPlus: true })}
			valueClass="text-muted"
		>
			{#snippet subline()}
				{#if data.disposalCount > 0}
					<span class="inline-flex flex-wrap items-center gap-1.5">
						<span class="rounded-full border border-border px-1.5 py-0.5 text-[10px]">
							{formatInr(data.deltaMinor, { explicitPlus: true })} vs filing number
						</span>
						<button
							type="button"
							class="rounded-full text-muted transition-colors duration-100 hover:text-text"
							title={NET_TOOLTIP}
							aria-label="Why two numbers? {NET_TOOLTIP}"
						>
							<Info size={12} aria-hidden="true" />
						</button>
					</span>
				{:else}
					Informational only
				{/if}
			{/snippet}
		</Tile>

		<!-- 4. Disposals -->
		<Tile label="disposals" value={String(data.disposalCount)}>
			{#snippet subline()}
				{#if data.disposalCount > 0}
					{formatInr(data.considerationMinor)} total consideration
				{:else}
					None in {data.fy}
				{/if}
			{/snippet}
		</Tile>
	</div>

	<!-- Disposals table -->
	<section
		class="rounded-md border border-border bg-surface p-4"
		aria-label="disposals in {data.fy}"
	>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 class="label-caps">disposals · {data.fy.toLowerCase()}</h2>
			{#if data.disposalCount > 0}
				<a
					href="/tax/{data.fy}/export"
					download
					class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity duration-100 hover:opacity-90"
					title="downloads {csvFilename}"
				>
					Export Schedule VDA CSV — {data.fy}
				</a>
			{:else}
				<button
					type="button"
					disabled
					class="cursor-not-allowed rounded-md border border-border px-3 py-1.5 text-xs text-muted"
				>
					No disposals in this FY
				</button>
			{/if}
		</div>

		{#if data.disposalCount === 0}
			<p class="mt-4 num text-xs text-muted">— No disposals in {data.fy} —</p>
		{:else}
			<div class="relative mt-3 overflow-x-auto">
				<table class="w-full min-w-[720px] border-collapse num text-xs">
					<thead>
						<tr class="border-b border-border bg-surface">
							<th
								class="sticky left-0 z-[1] bg-inherit py-1.5 pr-3 text-left label-caps font-medium"
							>
								date
							</th>
							<th class="py-1.5 pr-3 text-left label-caps font-medium">type</th>
							<th class="py-1.5 pr-3 text-right label-caps font-medium">
								{unitWord.toLowerCase()} out
							</th>
							<th class="py-1.5 pr-3 text-right label-caps font-medium">consideration</th>
							<th class="py-1.5 pr-3 text-right label-caps font-medium">cost</th>
							<th class="py-1.5 pr-3 text-right label-caps font-medium">taxable income</th>
							<th class="py-1.5 pr-3 text-right label-caps font-medium">lots</th>
							<th class="py-1.5" aria-label="expand"></th>
						</tr>
					</thead>
					<tbody>
						{#each data.disposals as d (d.txId)}
							<tr
								class="cursor-pointer border-b border-border/60 bg-surface transition-colors duration-100 hover:bg-surface-2"
								onclick={() => toggle(d.txId)}
							>
								<td class="sticky left-0 z-[1] bg-inherit py-2 pr-3 whitespace-nowrap">
									{formatIstDateShort(d.ts)}
								</td>
								<td class="py-2 pr-3"><TypeBadge type={d.kind} /></td>
								<td class="py-2 pr-3 text-right whitespace-nowrap">{qty(d.satsDisposed)}</td>
								<td class="py-2 pr-3 text-right whitespace-nowrap">
									{formatInr(d.considerationMinor)}
								</td>
								<td class="py-2 pr-3 text-right whitespace-nowrap">{formatInr(d.totalCostMinor)}</td
								>
								<td class="py-2 pr-3 text-right whitespace-nowrap">
									{formatInr(d.taxableConservativeMinor)}
								</td>
								<td class="py-2 pr-3 text-right">{d.slices.length}</td>
								<td class="py-2 text-right">
									<button
										type="button"
										class="rounded px-1 text-muted transition-colors duration-100 hover:text-text"
										aria-expanded={!!expanded[d.txId]}
										aria-controls="disposal-{d.txId}-slices"
										aria-label="show Schedule VDA rows for this disposal"
										onclick={(e) => {
											e.stopPropagation();
											toggle(d.txId);
										}}
									>
										<ChevronRight
											size={14}
											class="transition-transform duration-100 {expanded[d.txId]
												? 'rotate-90'
												: ''}"
											aria-hidden="true"
										/>
									</button>
								</td>
							</tr>
							{#if expanded[d.txId]}
								<tr class="border-b border-border/60">
									<td colspan="8" id="disposal-{d.txId}-slices" class="bg-surface-2/40 px-3 py-3">
										<p class="label-caps">schedule vda rows</p>
										<div class="mt-2">
											<LotSliceTable slices={d.slices} compact />
										</div>
										{#if d.netGainMinor !== d.taxableConservativeMinor}
											<p class="mt-2 num text-[11px] text-muted">
												Net incl. losses {formatInr(d.netGainMinor, { explicitPlus: true })} · filing
												uses the floored {formatInr(d.taxableConservativeMinor)}
											</p>
										{/if}
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<!-- FIFO lot queue (FY-independent — the future-tax picture) -->
	<section class="rounded-md border border-border bg-surface p-4" aria-label="fifo lot queue">
		<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<h2 class="label-caps">fifo lot queue</h2>
			<p class="text-[11px] text-muted">Remaining lots, oldest first — consumed from the top</p>
		</div>

		{#if data.queue.length === 0}
			<p class="mt-4 num text-xs text-muted">— No open lots —</p>
		{:else}
			<ul class="mt-2">
				{#each data.queue as lot, i (lot.lotTxId)}
					{@const remainingPct = (lot.remainingSats / lot.originalSats) * 100}
					<li class="border-b border-border/60 py-2.5 last:border-0">
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1 num text-xs">
							<span class="text-muted">#{lot.lotTxId}</span>
							<span class="whitespace-nowrap">acquired {formatIstDateShort(lot.acquiredTs)}</span>
							{#if lot.sourceType}
								<span class="text-muted">({lot.sourceType})</span>
							{/if}
							<span class="whitespace-nowrap">
								{lot.rateInrPerBtc != null ? `${formatRateInr(lot.rateInrPerBtc)}/BTC` : EM}
							</span>
							{#if i === 0}
								<span
									class="rounded-full border border-accent/40 px-1.5 py-0.5 text-[10px] leading-none text-accent"
								>
									next to be consumed
								</span>
							{/if}
						</div>
						<div class="mt-1.5 flex items-center gap-3">
							<div
								class="flex h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2"
								role="img"
								aria-label="{formatSats(lot.remainingSats)} of {formatSats(
									lot.originalSats
								)} sats remaining"
							>
								<div
									class="h-full bg-muted/80"
									style="width: {remainingPct}%; {lot.remainingSats > 0 ? 'min-width: 2px;' : ''}"
								></div>
								<div class="h-full bg-border/40" style="width: {100 - remainingPct}%"></div>
							</div>
							<span class="num text-[11px] text-muted">
								<span class="whitespace-nowrap text-text">{qty(lot.remainingSats)}</span>
								/
								<span class="whitespace-nowrap">{qty(lot.originalSats)} {unitWord} remaining</span>
							</span>
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		<!-- Reconciliation — a free integrity check, loud when it fails -->
		<p class="mt-3 num text-xs">
			Total {formatAmount(data.holdingsSats, unit.value)}
			{#if reconciled}
				<span class="inline-flex items-center gap-1 text-gain">
					= current holdings <Check size={12} aria-hidden="true" />
				</span>
			{:else}
				<span class="text-loss">
					≠ wallet balances {formatAmount(data.walletTotalSats, unit.value)} — mismatch, check the ledger
				</span>
			{/if}
		</p>
	</section>

	<!-- Legal caveat (exact copy, spec §6) -->
	<section
		class="rounded-md border border-border bg-surface p-4"
		aria-label="how these numbers are computed"
	>
		<p class="text-xs leading-relaxed text-muted">
			<strong class="font-medium text-text">How these numbers are computed.</strong>
			Gains use FIFO cost basis applied globally across all wallets; FIFO is the prevailing practice for
			VDAs, not a statutory mandate. Each disposal is taxed independently at 30% + 4% cess; losses cannot
			offset gains or other income (s.115BBH). Only cost of acquisition is deducted — exchange fees, spreads
			and network fees are not deductible. Self-transfers between your wallets are not disposals. This
			tool does not compute TDS (s.194S) — verify TDS credits separately. Not tax advice; confirm with
			a CA before filing.
		</p>
	</section>
</div>
