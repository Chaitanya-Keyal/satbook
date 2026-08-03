<script lang="ts">
	import { enhance } from '$app/forms';
	import { replaceState } from '$app/navigation';
	import Check from '@lucide/svelte/icons/check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import LotSliceTable from '$lib/components/LotSliceTable.svelte';
	import TypeBadge from '$lib/components/TypeBadge.svelte';
	import { unit } from '$lib/stores/unit.svelte';
	import type { TxType } from '$lib/types';
	import { formatAmount, formatUsd, signedAmount } from '$lib/utils/display';
	import { fyOf } from '$lib/utils/fy';
	import { formatInr, formatRateInr, formatSats, mulDivRound } from '$lib/utils/money';
	import { formatIstDateShort, formatIstFull, formatUtcFull } from '$lib/utils/time';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type TxRow = PageData['txs'][number];

	const EM = '—';
	const TX_TYPES: TxType[] = ['INCOME', 'BUY', 'SELL', 'SPEND', 'TRANSFER'];
	const HUES: Record<TxType, string> = {
		INCOME: 'var(--color-badge-income)',
		BUY: 'var(--color-badge-buy)',
		SELL: 'var(--color-badge-sell)',
		SPEND: 'var(--color-badge-spend)',
		TRANSFER: 'var(--color-badge-transfer)'
	};

	// --- filters (URL-hydrated on load, client-owned after) -------------------

	// svelte-ignore state_referenced_locally
	const initialFilters = data.filters;
	let selTypes = $state<TxType[]>([...initialFilters.types]);
	let walletF = $state(initialFilters.wallet);
	let fyF = $state(initialFilters.fy);
	let q = $state(initialFilters.q);
	let sheetOpen = $state(false);
	let searchEl = $state<HTMLInputElement | null>(null);

	const activeCount = $derived(
		selTypes.length + (walletF !== '' ? 1 : 0) + (fyF !== '' ? 1 : 0) + (q.trim() !== '' ? 1 : 0)
	);

	function syncUrl() {
		const p = new URLSearchParams();
		if (selTypes.length > 0) p.set('type', selTypes.join(','));
		if (walletF !== '') p.set('wallet', walletF);
		if (fyF !== '') p.set('fy', fyF);
		if (q.trim() !== '') p.set('q', q.trim());
		try {
			replaceState(p.size > 0 ? `/tx?${p}` : '/tx', {});
		} catch {
			// router not ready yet — deep-link sync is best-effort
		}
	}

	function toggleType(t: TxType) {
		selTypes = selTypes.includes(t) ? selTypes.filter((x) => x !== t) : [...selTypes, t];
		syncUrl();
	}

	function clearFilters() {
		selTypes = [];
		walletF = '';
		fyF = '';
		q = '';
		syncUrl();
	}

	const filtered = $derived(
		data.txs.filter((t) => {
			if (selTypes.length > 0 && !selTypes.includes(t.type)) return false;
			if (walletF !== '') {
				const wid = +walletF;
				if (t.walletId !== wid && t.fromWalletId !== wid && t.toWalletId !== wid) return false;
			}
			if (fyF !== '' && fyOf(t.ts) !== fyF) return false;
			const needle = q.trim().toLowerCase();
			if (needle !== '') {
				const noteHit = (t.notes ?? '').toLowerCase().includes(needle);
				const txidHit = (t.txid ?? '').toLowerCase().startsWith(needle);
				if (!noteHit && !txidHit) return false;
			}
			return true;
		})
	);

	// Footer aggregates for the current filter: sats flow signed by direction
	// (network fees always leave the stack; TRANSFER nets to −fee), INR signed
	// by direction (TRANSFER carries none).
	const netSats = $derived(
		filtered.reduce((sum, t) => {
			if (t.type === 'INCOME' || t.type === 'BUY') return sum + t.amountSats;
			if (t.type === 'SELL' || t.type === 'SPEND') return sum - t.amountSats - t.feeSats;
			return sum - t.feeSats;
		}, 0)
	);
	const netInr = $derived(
		filtered.reduce((sum, t) => {
			if (t.type === 'TRANSFER' || t.inrValueMinor == null) return sum;
			return t.type === 'SELL' || t.type === 'SPEND'
				? sum - t.inrValueMinor
				: sum + t.inrValueMinor;
		}, 0)
	);

	// --- row helpers -----------------------------------------------------------

	const walletNames = $derived(new Map(data.wallets.map((w) => [w.id, w.name])));
	const nameOf = (id: number | null) => (id != null ? (walletNames.get(id) ?? `#${id}`) : '?');

	function walletLabel(t: TxRow): string {
		return t.type === 'TRANSFER'
			? `${nameOf(t.fromWalletId)} → ${nameOf(t.toWalletId)}`
			: nameOf(t.walletId);
	}

	function btcCell(t: TxRow): { text: string; cls: string } {
		if (t.type === 'TRANSFER') return { text: formatAmount(t.amountSats, unit.value), cls: '' };
		const outgoing = t.type === 'SELL' || t.type === 'SPEND';
		return signedAmount(outgoing ? -t.amountSats : t.amountSats, unit.value);
	}

	function inrCell(t: TxRow): { text: string; cls: string } | null {
		if (t.type === 'TRANSFER' || t.inrValueMinor == null) return null;
		const outgoing = t.type === 'SELL' || t.type === 'SPEND';
		return {
			text: formatInr(outgoing ? -t.inrValueMinor : t.inrValueMinor, { explicitPlus: true }),
			cls: outgoing ? 'text-loss' : 'text-gain'
		};
	}

	/** Effective ₹/BTC of the row (inrValueMinor·10⁶ / sats), null for TRANSFER. */
	function rateOf(t: TxRow): number | null {
		if (t.type === 'TRANSFER' || t.inrValueMinor == null || t.amountSats <= 0) return null;
		return mulDivRound(t.inrValueMinor, 1_000_000, t.amountSats);
	}

	/** 'FY2023-24' → 'FY23-24' (dialog copy voice per spec §4). */
	function shortFy(ts: number): string {
		return fyOf(ts).replace(/^FY20/, 'FY');
	}

	function formatFiatMinor(minor: number, cur: 'USD' | 'EUR'): string {
		const sym = cur === 'USD' ? '$' : '€';
		const [whole, frac] = (Math.abs(minor) / 100).toFixed(2).split('.');
		return `${sym}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
	}

	/** Raw rate-source slugs → human text ('sheet-import' → 'imported from sheet'). */
	function humanRateSource(slug: string): string {
		const KNOWN: Record<string, string> = {
			'sheet-import': 'imported from sheet',
			manual: 'manual',
			live: 'live price',
			coindcx: 'CoinDCX',
			'coindcx-1h': 'CoinDCX 1h close',
			'coindcx-1d': 'CoinDCX daily close',
			'coindcx+binance': 'CoinDCX + Binance',
			'coindcx+frankfurter': 'CoinDCX + Frankfurter'
		};
		return KNOWN[slug] ?? slug.replaceAll('-', ' ');
	}

	// --- expansion / copy ------------------------------------------------------

	let expandedId = $state<number | null>(null);
	let copiedId = $state<number | null>(null);

	function toggleRow(id: number) {
		expandedId = expandedId === id ? null : id;
	}

	function copyTxid(id: number, txid: string) {
		void navigator.clipboard.writeText(txid);
		copiedId = id;
		setTimeout(() => {
			if (copiedId === id) copiedId = null;
		}, 1500);
	}

	// --- delete confirm --------------------------------------------------------

	let confirmDelete = $state<TxRow | null>(null);
	let deleting = $state(false);

	// --- toast + flash ---------------------------------------------------------

	let toast = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	function showToast(msg: string) {
		toast = msg;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 4000);
	}

	let flashId = $state<number | null>(null);
	let flashHandled = false;
	$effect(() => {
		if (flashHandled) return;
		flashHandled = true;
		if (data.flash == null) return;
		flashId = data.flash;
		showToast('Saved — balances and tax recomputed');
		requestAnimationFrame(() => {
			// Desktop table row or mobile card — whichever is actually rendered.
			const desktop = document.getElementById(`tx-${data.flash}`);
			const target =
				desktop && desktop.offsetParent != null
					? desktop
					: document.getElementById(`tx-m-${data.flash}`);
			target?.scrollIntoView({ block: 'center' });
		});
		setTimeout(() => (flashId = null), 2500);
		// Strip ?flash so a refresh doesn't re-announce; deferred past router init.
		setTimeout(syncUrl, 0);
	});

	// '/' from the layout focuses the ledger search (spec §1 keyboard map).
	$effect(() => {
		const focus = () => searchEl?.focus();
		window.addEventListener('ledger-search-focus', focus);
		return () => window.removeEventListener('ledger-search-focus', focus);
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (confirmDelete) confirmDelete = null;
		else if (sheetOpen) sheetOpen = false;
	}
</script>

<svelte:head><title>transactions · satbook</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

{#snippet filterControls()}
	<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="type filter">
		{#each TX_TYPES as t (t)}
			{@const active = selTypes.includes(t)}
			<button
				type="button"
				aria-pressed={active}
				onclick={() => toggleType(t)}
				class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] leading-none font-medium tracking-[0.08em] lowercase transition-colors duration-100"
				style={active
					? `color: ${HUES[t]}; border-color: color-mix(in srgb, ${HUES[t]} 45%, transparent); background-color: color-mix(in srgb, ${HUES[t]} 15%, transparent);`
					: undefined}
				class:border-border={!active}
				class:text-muted={!active}
				class:hover:text-text={!active}
			>
				<span
					class="size-1.5 rounded-full"
					style="background-color: {active ? HUES[t] : 'var(--color-border)'}"
					aria-hidden="true"
				></span>
				{t.toLowerCase()}
			</button>
		{/each}
	</div>
	<select
		aria-label="wallet filter"
		bind:value={walletF}
		onchange={syncUrl}
		class="rounded-md border border-border bg-surface px-2 py-1 text-xs transition-colors duration-100 hover:border-muted/60"
	>
		<option value="">All wallets</option>
		{#each data.wallets as w (w.id)}
			<option value={String(w.id)}>{w.name}{w.archived ? ' (archived)' : ''}</option>
		{/each}
	</select>
	<select
		aria-label="financial year filter"
		bind:value={fyF}
		onchange={syncUrl}
		class="rounded-md border border-border bg-surface px-2 py-1 num text-xs transition-colors duration-100 hover:border-muted/60"
	>
		<option value="">All FYs</option>
		{#each data.fys as fy (fy)}
			<option value={fy}>{fy}</option>
		{/each}
	</select>
	{#if activeCount > 0}
		<button
			type="button"
			onclick={clearFilters}
			class="rounded-md px-2 py-1 text-xs text-muted transition-colors duration-100 hover:text-text"
		>
			Clear ({activeCount})
		</button>
	{/if}
{/snippet}

{#snippet expansion(t: TxRow)}
	{@const disposal = data.disposals[t.id]}
	{@const lot = data.openLots[t.id]}
	{@const rate = rateOf(t)}
	<div class="space-y-4 px-1 py-3 text-xs lg:px-3">
		<div class="grid gap-x-8 gap-y-3 lg:grid-cols-2">
			<div class="space-y-3">
				<div>
					<p class="label-caps">timestamp</p>
					<p class="mt-0.5 num">
						{formatIstFull(t.ts)} <span class="text-muted">({formatUtcFull(t.ts)})</span>
					</p>
				</div>
				{#if t.txid}
					<div>
						<p class="label-caps">txid</p>
						<p class="mt-0.5 num break-all text-muted">{t.txid}</p>
						<div class="mt-1.5 flex flex-wrap items-center gap-3">
							<button
								type="button"
								onclick={() => copyTxid(t.id, t.txid!)}
								class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:text-text"
							>
								{#if copiedId === t.id}
									<Check size={11} aria-hidden="true" /> Copied
								{:else}
									<Copy size={11} aria-hidden="true" /> Copy
								{/if}
							</button>
							<a
								href="https://blockstream.info/tx/{t.txid}"
								target="_blank"
								rel="noreferrer"
								class="inline-flex items-center gap-1 text-[11px] text-muted underline transition-colors duration-100 hover:text-text"
							>
								blockstream.info <ExternalLink size={11} aria-hidden="true" />
							</a>
							<a
								href="https://mempool.emzy.de/tx/{t.txid}"
								target="_blank"
								rel="noreferrer"
								class="inline-flex items-center gap-1 text-[11px] text-muted underline transition-colors duration-100 hover:text-text"
							>
								mempool.emzy.de <ExternalLink size={11} aria-hidden="true" />
							</a>
						</div>
					</div>
				{/if}
				{#if rate != null}
					<div>
						<p class="label-caps">rate</p>
						<p class="mt-0.5 num">
							{formatRateInr(rate)} / BTC
							{#if t.btcUsdRate != null}
								<span class="text-muted">· {formatUsd(t.btcUsdRate)} / BTC</span>
							{/if}
							{#if t.rateSource}
								<span class="ml-1 derived">{humanRateSource(t.rateSource)}</span>
							{/if}
						</p>
					</div>
				{/if}
				{#if t.fiatCurrency != null && t.fiatCurrency !== 'INR' && t.fiatAmountMinor != null}
					<div>
						<p class="label-caps">original fiat</p>
						<p class="mt-0.5 num">
							{formatFiatMinor(t.fiatAmountMinor, t.fiatCurrency)}
							{#if t.fxRateToInr != null}
								<span class="text-muted">· fx 1 {t.fiatCurrency} = ₹{t.fxRateToInr.toFixed(2)}</span
								>
							{/if}
							{#if t.inrValueMinor != null}
								<span class="text-muted">→ {formatInr(t.inrValueMinor)} recorded</span>
							{/if}
						</p>
					</div>
				{/if}
				{#if t.type === 'TRANSFER' || t.feeSats > 0}
					<div>
						<p class="label-caps">network fee</p>
						<p class="mt-0.5 num">
							{formatSats(t.feeSats)} sats
							{#if t.feeSats > 0}
								<span class="text-muted">
									· consumes FIFO lots untaxed{t.feeInrValueMinor != null
										? ` · ≈ ${formatInr(t.feeInrValueMinor)} at the time`
										: ''}
								</span>
							{/if}
						</p>
					</div>
				{/if}
			</div>

			<div>
				{#if (t.type === 'SELL' || t.type === 'SPEND') && disposal}
					<p class="label-caps">lots consumed</p>
					<p class="mt-0.5 num text-muted">
						Taxable {formatInr(disposal.taxableConservativeMinor)} · net
						{formatInr(disposal.netGainMinor, { explicitPlus: true })} · {disposal.slices.length}
						lot{disposal.slices.length === 1 ? '' : 's'}
					</p>
					<div class="mt-2">
						<LotSliceTable slices={disposal.slices} compact />
					</div>
				{:else if t.type === 'INCOME' || t.type === 'BUY'}
					<p class="label-caps">lot created</p>
					<p class="mt-0.5 num">
						Created lot #{t.id} · {formatAmount(t.amountSats, unit.value)}
						{#if rate != null}
							@ {formatRateInr(rate)} / BTC
						{/if}
						{#if lot}
							· {formatAmount(lot.remainingSats, unit.value)} remaining
						{:else}
							· <span class="text-muted">fully consumed</span>
						{/if}
					</p>
				{/if}
			</div>
		</div>

		<div class="flex flex-wrap items-center justify-end gap-3 border-t border-border/60 pt-3">
			{#if form?.deleteError != null && form?.deleteId === t.id}
				<p role="alert" class="mr-auto text-xs text-loss">{form.deleteError}</p>
			{/if}
			<div class="flex shrink-0 items-center gap-2">
				<a
					href="/tx/{t.id}/edit"
					class="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-text"
				>
					Edit
				</a>
				<button
					type="button"
					onclick={() => (confirmDelete = t)}
					class="rounded-md border border-loss/40 px-3 py-1.5 text-xs text-loss transition-colors duration-100 hover:bg-loss/10"
				>
					Delete
				</button>
			</div>
		</div>
	</div>
{/snippet}

<h1 class="label-caps">transactions</h1>

<!-- Sticky filter bar -->
<div
	class="sticky top-12 z-20 -mx-4 mt-3 border-b border-border bg-bg/95 px-4 py-2.5 backdrop-blur"
>
	<div class="hidden flex-wrap items-center gap-2.5 md:flex">
		{@render filterControls()}
		<input
			type="search"
			placeholder="Search note or txid · /"
			aria-label="search transactions"
			bind:this={searchEl}
			bind:value={q}
			oninput={syncUrl}
			class="ml-auto w-56 rounded-md border border-border bg-surface px-2.5 py-1 num text-xs transition-colors duration-100 placeholder:text-muted/70 hover:border-muted/60"
		/>
	</div>
	<div class="flex items-center gap-2 md:hidden">
		<input
			type="search"
			placeholder="Search note or txid"
			aria-label="search transactions"
			bind:value={q}
			oninput={syncUrl}
			class="min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 num text-xs transition-colors duration-100 placeholder:text-muted/70"
		/>
		<button
			type="button"
			onclick={() => (sheetOpen = true)}
			class="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors duration-100 hover:text-text"
		>
			Filters{activeCount - (q.trim() !== '' ? 1 : 0) > 0
				? ` (${activeCount - (q.trim() !== '' ? 1 : 0)})`
				: ''}
		</button>
	</div>
</div>

{#if data.txs.length === 0}
	<p class="mt-10 text-center num text-xs text-muted">
		— No entries — press <kbd class="rounded border border-border bg-surface-2 px-1">n</kbd> to add,
		or
		<a href="/settings" class="underline transition-colors duration-100 hover:text-text">
			import your sheet in Settings
		</a>
	</p>
{:else if filtered.length === 0}
	<p class="mt-10 text-center num text-xs text-muted">
		— No entries match —
		<button
			type="button"
			onclick={clearFilters}
			class="underline transition-colors duration-100 hover:text-text"
		>
			clear filters
		</button>
	</p>
{:else}
	<!-- Desktop table -->
	<div class="mt-1 hidden overflow-x-auto md:block">
		<table class="w-full border-collapse text-[13px]">
			<thead>
				<tr class="border-b border-border">
					<th class="py-2 pr-3 text-left label-caps font-medium">date</th>
					<th class="py-2 pr-3 text-left label-caps font-medium">type</th>
					<th class="py-2 pr-3 text-left label-caps font-medium">wallet</th>
					<th class="py-2 pr-3 text-right label-caps font-medium">
						{unit.value === 'btc' ? 'btc' : 'sats'}
					</th>
					<th class="py-2 pr-3 text-right label-caps font-medium">inr</th>
					<th class="py-2 pr-3 text-right label-caps font-medium">rate ₹/btc</th>
					<th class="py-2 pr-3 text-left label-caps font-medium">note</th>
					<th class="py-2" aria-label="expand"></th>
				</tr>
			</thead>
			<tbody>
				{#each filtered as t (t.id)}
					{@const btc = btcCell(t)}
					{@const inr = inrCell(t)}
					{@const rate = rateOf(t)}
					{@const open = expandedId === t.id}
					<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
					<tr
						id="tx-{t.id}"
						role="button"
						tabindex="0"
						aria-expanded={open}
						onclick={() => toggleRow(t.id)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								toggleRow(t.id);
							}
						}}
						class="cursor-pointer border-b border-border/60 transition-colors duration-150 {open
							? 'bg-surface-2'
							: 'hover:bg-surface'} {flashId === t.id ? 'bg-accent/10' : ''}"
					>
						<td
							class="py-2 pr-3 num whitespace-nowrap"
							title="{formatIstFull(t.ts)} · {formatUtcFull(t.ts)}"
						>
							{formatIstDateShort(t.ts)}
						</td>
						<td class="py-2 pr-3"><TypeBadge type={t.type} /></td>
						<td class="py-2 pr-3 whitespace-nowrap text-muted">{walletLabel(t)}</td>
						<td class="py-2 pr-3 text-right num whitespace-nowrap {btc.cls}">{btc.text}</td>
						<td class="py-2 pr-3 text-right num whitespace-nowrap {inr?.cls ?? 'text-muted'}">
							{inr?.text ?? EM}
						</td>
						<td class="py-2 pr-3 text-right num whitespace-nowrap text-muted">
							{rate != null ? formatRateInr(rate) : EM}
						</td>
						<td class="max-w-[220px] truncate py-2 pr-3 text-muted" title={t.notes ?? undefined}>
							{t.notes ?? ''}
						</td>
						<td class="py-2 text-right text-muted">
							<ChevronRight
								size={14}
								class="ml-auto transition-transform duration-150 {open ? 'rotate-90' : ''}"
								aria-hidden="true"
							/>
						</td>
					</tr>
					{#if open}
						<tr class="border-b border-border/60 bg-surface">
							<td colspan="8">{@render expansion(t)}</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>

	<!-- Mobile card list -->
	<ul class="mt-3 space-y-2 md:hidden">
		{#each filtered as t (t.id)}
			{@const btc = btcCell(t)}
			{@const inr = inrCell(t)}
			{@const open = expandedId === t.id}
			<li
				id="tx-m-{t.id}"
				class="rounded-md border border-border transition-colors duration-150 {flashId === t.id
					? 'bg-accent/10'
					: open
						? 'bg-surface-2'
						: 'bg-surface'}"
			>
				<button
					type="button"
					class="block w-full px-3 py-2.5 text-left"
					aria-expanded={open}
					onclick={() => toggleRow(t.id)}
				>
					<span class="flex items-center gap-2">
						<TypeBadge type={t.type} />
						<span class="num text-xs">{formatIstDateShort(t.ts)}</span>
						<span class="min-w-0 flex-1 truncate text-right text-xs text-muted">
							{walletLabel(t)}
						</span>
					</span>
					<span class="mt-1.5 flex items-baseline justify-between gap-3">
						<span class="num text-[13px] {btc.cls}">{btc.text}</span>
						<span class="num text-xs {inr?.cls ?? 'text-muted'}">{inr?.text ?? EM}</span>
					</span>
				</button>
				{#if open}
					<div class="border-t border-border/60 px-2">{@render expansion(t)}</div>
				{/if}
			</li>
		{/each}
	</ul>

	<!-- Footer line -->
	<p class="mt-3 num text-xs text-muted">
		{filtered.length} transaction{filtered.length === 1 ? '' : 's'} · net
		{formatInr(netInr, { explicitPlus: true })} · net {signedAmount(netSats, unit.value).text}
	</p>
{/if}

<!-- Mobile filter bottom sheet -->
{#if sheetOpen}
	<div class="fixed inset-0 z-50 md:hidden">
		<button
			type="button"
			class="absolute inset-0 bg-black/60"
			aria-label="Close filters"
			onclick={() => (sheetOpen = false)}
		></button>
		<div
			role="dialog"
			aria-modal="true"
			aria-label="filters"
			class="absolute inset-x-0 bottom-0 rounded-t-md border-t border-border bg-surface p-4 pb-[max(env(safe-area-inset-bottom),1rem)]"
		>
			<div class="flex items-center justify-between">
				<h2 class="label-caps">filters</h2>
				<button
					type="button"
					onclick={() => (sheetOpen = false)}
					class="rounded-md px-2 py-1 text-xs text-muted transition-colors duration-100 hover:text-text"
				>
					Done
				</button>
			</div>
			<div class="mt-3 flex flex-col items-start gap-3">
				{@render filterControls()}
			</div>
		</div>
	</div>
{/if}

<!-- Delete confirm dialog -->
{#if confirmDelete}
	{@const target = confirmDelete}
	<div class="fixed inset-0 z-50">
		<button
			type="button"
			class="absolute inset-0 bg-black/60"
			aria-label="Cancel delete"
			onclick={() => (confirmDelete = null)}
		></button>
		<div
			role="alertdialog"
			aria-modal="true"
			aria-label="confirm delete"
			class="absolute top-1/2 left-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-5"
		>
			<h2 class="text-sm font-medium">Delete this transaction?</h2>
			<p class="mt-2 text-xs leading-relaxed text-muted">
				All derived data — wallet balances, FIFO lots, and tax reports for
				<span class="num">{shortFy(target.ts)}</span> onward — recomputes from the remaining ledger.
			</p>
			<form
				method="POST"
				action="?/delete"
				class="mt-4 flex justify-end gap-2"
				use:enhance={() => {
					deleting = true;
					return async ({ result, update }) => {
						deleting = false;
						confirmDelete = null;
						if (result.type === 'success') showToast('Deleted — balances and tax recomputed');
						await update();
					};
				}}
			>
				<input type="hidden" name="id" value={target.id} />
				<button
					type="button"
					onclick={() => (confirmDelete = null)}
					class="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors duration-100 hover:text-text"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={deleting}
					class="rounded-md bg-loss px-3 py-1.5 text-xs font-medium text-bg transition-opacity duration-100 hover:opacity-90 disabled:opacity-60"
				>
					{deleting ? 'Deleting…' : 'Delete and recompute'}
				</button>
			</form>
		</div>
	</div>
{/if}

{#if toast}
	<div
		role="status"
		class="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-surface-2 px-4 py-2 num text-xs whitespace-nowrap lg:bottom-6"
	>
		{toast}
	</div>
{/if}
