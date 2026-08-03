<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import PortfolioChart from '$lib/components/PortfolioChart.svelte';
	import Tile from '$lib/components/Tile.svelte';
	import TypeBadge from '$lib/components/TypeBadge.svelte';
	import { toggleUnit, unit } from '$lib/stores/unit.svelte';
	import { formatAmount, formatUsd } from '$lib/utils/display';
	import { formatInr, formatRateInr, mulDivRound, SATS_PER_BTC } from '$lib/utils/money';
	import { formatIstDateShort, formatRelative } from '$lib/utils/time';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type RecentRow = PageData['recent'][number];

	const MINUS = '−';
	const EM = '—';

	const p = $derived(data.price);
	const holdings = $derived(data.holdingsSats);
	const invested = $derived(data.netInvestedMinor);

	// Degenerate states (task spec): holdings 0 → fully realized; invested ≤ 0
	// with history → house money. A brand-new empty ledger is neither.
	const hasHistory = $derived(data.totalTx > 0);
	const fullyRealized = $derived(hasHistory && holdings === 0);
	const houseMoney = $derived(hasHistory && invested <= 0);

	// Price-derived numbers still render from the last-known price when stale,
	// with the amber underline; em-dash only when no price row has EVER existed.
	const priceStale = $derived(p != null && (p.stale || data.now - p.fetchedAt > 600));
	const staleTitle = $derived(
		p ? `Computed from price fetched ${formatRelative(p.fetchedAt, data.now)}` : ''
	);

	const valueMinor = $derived(
		p ? mulDivRound(holdings, Math.round(p.btcInr * 100), SATS_PER_BTC) : null
	);
	const valueUsd = $derived(p ? (holdings / SATS_PER_BTC) * p.btcUsd : null);
	const plMinor = $derived(valueMinor != null ? valueMinor - invested : null);
	const plPct = $derived(plMinor != null && invested > 0 ? (plMinor / invested) * 100 : null);

	const breakEvenInr = $derived(
		holdings > 0 && invested > 0 ? mulDivRound(invested, 1_000_000, holdings) : null
	);
	const breakEvenUsd = $derived(
		breakEvenInr != null && p ? breakEvenInr * (p.btcUsd / p.btcInr) : null
	);
	// Gauge maps ±50% around break-even onto the line; dot clamped near edges.
	const gaugePos = $derived.by(() => {
		if (breakEvenInr == null || p == null) return null;
		const rel = (p.btcInr / breakEvenInr - 1) / 0.5;
		return 50 + 50 * Math.max(-0.92, Math.min(0.92, rel));
	});

	const estTaxMinor = $derived(Math.round(data.fy.taxableMinor * 0.312));

	const plValue = $derived.by(() => {
		if (plMinor == null) return EM;
		const base = formatInr(plMinor, { explicitPlus: true });
		if (plPct == null) return base;
		const sign = plPct >= 0 ? '+' : MINUS;
		return `${base} · ${sign}${Math.abs(plPct).toFixed(1)}%`;
	});

	const sinceLabel = $derived(
		data.sinceTs != null ? formatIstDateShort(data.sinceTs).split(' ').slice(1).join(' ') : null
	);

	const SEG_COLORS = ['#8b8d96', '#5c5f68', '#3c3f47'];

	// Auto-composed one-liners per spec §2 — "Bought 120 000 sats · Cold storage".
	function describe(t: RecentRow): string {
		const amount = formatAmount(t.amountSats, unit.value);
		switch (t.type) {
			case 'INCOME':
				return t.notes ?? `Income ${amount} · ${t.walletName ?? '?'}`;
			case 'BUY':
				return `Bought ${amount} · ${t.walletName ?? '?'}`;
			case 'SELL':
				return `Sold ${amount} · ${t.walletName ?? '?'}`;
			case 'SPEND':
				return `Spent ${amount} · ${t.walletName ?? '?'}`;
			case 'TRANSFER':
				return `Transfer ${t.fromName ?? '?'} to ${t.toName ?? '?'}`;
		}
	}

	function signedInr(t: RecentRow): { text: string; cls: string } | null {
		if (t.type === 'TRANSFER' || t.inrValueMinor == null) return null;
		const outgoing = t.type === 'SELL' || t.type === 'SPEND';
		return {
			text: formatInr(outgoing ? -t.inrValueMinor : t.inrValueMinor, { explicitPlus: true }),
			cls: outgoing ? 'text-loss' : 'text-gain'
		};
	}
</script>

<svelte:head><title>dashboard · satbook</title></svelte:head>

<div class="grid grid-cols-2 gap-3 lg:grid-cols-12 lg:gap-4">
	<!-- Holdings — click flips the unit, same as the global toggle -->
	<Tile
		class="col-span-1 lg:col-span-3"
		label="holdings"
		value={fullyRealized || !hasHistory ? EM : formatAmount(holdings, unit.value)}
		onclick={toggleUnit}
	>
		{#snippet subline()}
			{#if fullyRealized}
				Fully realized
			{:else if !hasHistory}
				No entries yet
			{/if}
		{/snippet}
		{#if holdings > 0}
			<div
				class="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
				aria-hidden="true"
			>
				{#each data.wallets as w, i (w.id)}
					{#if w.sats > 0}
						<div
							class="h-full"
							style="width: {(w.sats / holdings) *
								100}%; min-width: 2px; background-color: {SEG_COLORS[i % SEG_COLORS.length]}"
							title="{w.name} · {formatAmount(w.sats, unit.value)}"
						></div>
					{/if}
				{/each}
			</div>
		{/if}
	</Tile>

	<!-- Net invested -->
	<Tile
		class="col-span-1 lg:col-span-3"
		label="net invested"
		value={hasHistory ? formatInr(invested) : EM}
	>
		{#snippet subline()}
			{#if data.txCount > 0}
				Across {data.txCount} transactions{sinceLabel ? ` since ${sinceLabel}` : ''}
			{:else}
				No entries yet
			{/if}
		{/snippet}
	</Tile>

	<!-- Current value -->
	<Tile
		class="col-span-1 lg:col-span-3"
		label="current value"
		value={valueMinor != null ? formatInr(valueMinor) : EM}
		stale={priceStale}
		{staleTitle}
	>
		{#snippet subline()}
			{#if valueUsd != null}
				≈ {formatUsd(valueUsd)}
			{:else}
				No price data yet
			{/if}
		{/snippet}
	</Tile>

	<!-- Unrealized P/L -->
	<Tile
		class="col-span-1 lg:col-span-3"
		label="unrealized p/l"
		value={plValue}
		valueClass={plMinor == null ? '' : plMinor >= 0 ? 'text-gain' : 'text-loss'}
		stale={priceStale}
		{staleTitle}
	>
		{#snippet subline()}
			{#if plMinor == null}
				No price data yet
			{:else if houseMoney}
				House money — basis fully recovered
			{:else}
				Against net invested
			{/if}
		{/snippet}
	</Tile>

	<!-- Break-even (wide) — the tile a stacker actually stares at -->
	<Tile
		class="col-span-2 lg:col-span-6"
		label="break-even"
		value={breakEvenInr != null ? `${formatRateInr(breakEvenInr)} / BTC` : EM}
	>
		{#snippet subline()}
			{#if breakEvenInr == null}
				{#if fullyRealized}
					Fully realized — no open position
				{:else if houseMoney}
					House money — cost basis fully recovered
				{:else}
					No entries yet
				{/if}
			{:else if breakEvenUsd != null}
				≈ {formatUsd(breakEvenUsd)}
			{:else}
				No price data yet
			{/if}
		{/snippet}
		{#if gaugePos != null && p != null && breakEvenInr != null}
			<div
				class="relative mt-4 h-3"
				title="live {formatRateInr(p.btcInr)} vs break-even {formatRateInr(breakEvenInr)}"
			>
				<div class="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-border"></div>
				<div
					class="absolute top-1/2 left-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-muted"
				></div>
				<div
					class="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full {p.btcInr >=
					breakEvenInr
						? 'bg-gain'
						: 'bg-loss'}"
					style="left: {gaugePos}%"
				></div>
			</div>
			<p class="mt-1 num text-[10px] text-muted" class:stale-underline={priceStale}>
				Live price {p.btcInr >= breakEvenInr ? 'above' : 'below'} break-even
			</p>
		{/if}
	</Tile>

	<!-- This FY taxable gains (wide, links /tax) -->
	<Tile
		class="col-span-2 lg:col-span-6"
		label="this fy taxable gains · {data.fy.label.toLowerCase()}"
		value={formatInr(data.fy.taxableMinor)}
		href="/tax"
	>
		{#snippet subline()}
			{#if data.fy.disposals > 0}
				Est. tax {formatInr(estTaxMinor)} @ 31.2% · {data.fy.disposals} disposal{data.fy
					.disposals === 1
					? ''
					: 's'}
			{:else}
				No disposals yet this FY
			{/if}
		{/snippet}
	</Tile>

	<!-- Chart (8 cols) -->
	<div class="col-span-2 lg:col-span-8">
		<PortfolioChart />
	</div>

	<!-- Recent activity (4 cols) -->
	<section
		class="col-span-2 flex flex-col rounded-md border border-border bg-surface p-4 lg:col-span-4"
		aria-label="recent activity"
	>
		<h2 class="label-caps">recent activity</h2>
		{#if data.recent.length === 0}
			<p class="mt-4 num text-xs text-muted">
				— No entries — press <kbd class="rounded border border-border bg-surface-2 px-1">n</kbd>
				to add your first, or
				<a class="underline transition-colors duration-100 hover:text-text" href="/settings">
					import your sheet in Settings
				</a>
			</p>
		{:else}
			<ul class="mt-2 flex-1 divide-y divide-border/60">
				{#each data.recent as t (t.id)}
					{@const s = signedInr(t)}
					<li class="flex items-center gap-2.5 py-2.5">
						<TypeBadge type={t.type} />
						<div class="min-w-0 flex-1">
							<p class="truncate text-[13px]" title={describe(t)}>{describe(t)}</p>
							<p class="num text-[11px] text-muted">{formatRelative(t.ts, data.now)}</p>
						</div>
						{#if s}
							<span class="shrink-0 num text-xs {s.cls}">{s.text}</span>
						{:else}
							<span class="shrink-0 num text-xs text-muted">{EM}</span>
						{/if}
					</li>
				{/each}
			</ul>
			<a
				href="/tx"
				class="mt-auto inline-flex items-center gap-1 pt-3 text-xs text-muted transition-colors duration-100 hover:text-text"
			>
				All transactions <ArrowRight size={14} aria-hidden="true" />
			</a>
		{/if}
	</section>
</div>
