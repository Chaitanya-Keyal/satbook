<script lang="ts">
	// The 2-of-3 triad row (spec §3.2/§3.3): BTC amount × rate = fiat amount,
	// with the manual/derived state machine from ./triad, currency select on the
	// fiat side and the FX conversion row for USD/EUR. The parent owns the
	// TriadState ($state proxy) and rate/FX fetch orchestration; this component
	// renders it and applies user edits.
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import type { FiatCurrency } from '$lib/types';
	import { formatInr, formatRateInr, parseFiatShorthand } from '$lib/utils/money';
	import BtcAmountInput from './BtcAmountInput.svelte';
	import {
		CURRENCY_SYMBOL,
		derivedField,
		editField,
		formatFiatMinor,
		formatRateValue,
		parseFiatText,
		parseRateText,
		type TriadState,
		type TriField
	} from './triad';

	interface FxView {
		rate: number | null;
		state: 'idle' | 'pending' | 'fetched' | 'manual' | 'failed' | 'saved';
		label: string | null; // 'ECB 2026-08-01'
	}

	let {
		tri,
		currency,
		oncurrencychange,
		fx,
		onfxinput,
		rateChip = null,
		rateError = null,
		ratePending = false,
		btcLabel,
		fiatLabel,
		btcChip = null,
		onedit,
		onfieldblur,
		amountError = null,
		fiatError = null,
		fxError = null
	}: {
		tri: TriadState;
		currency: FiatCurrency;
		oncurrencychange: (c: FiatCurrency) => void;
		fx: FxView;
		onfxinput: (rate: number | null) => void;
		rateChip?: string | null;
		rateError?: string | null;
		ratePending?: boolean;
		btcLabel: string;
		fiatLabel: string;
		btcChip?: string | null;
		onedit?: (field: TriField) => void;
		onfieldblur?: (field: TriField | 'fx') => void;
		amountError?: string | null;
		fiatError?: string | null;
		fxError?: string | null;
	} = $props();

	const dfield = $derived(derivedField(tri));
	const rateStyledDerived = $derived(dfield === 'rate' || tri.ratePrefilled);

	// --- rate field ----------------------------------------------------------

	let rateRaw = $state('');
	let rateFocused = $state(false);
	$effect(() => {
		void tri.rate;
		void currency;
		if (!rateFocused || rateStyledDerived)
			rateRaw = tri.rate == null ? '' : formatRateValue(tri.rate, currency);
	});

	function onRateInput(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value;
		rateRaw = v;
		onedit?.('rate');
		editField(tri, 'rate', parseRateText(v));
	}

	// --- fiat field ----------------------------------------------------------

	let fiatRaw = $state('');
	let fiatFocused = $state(false);
	$effect(() => {
		void tri.fiatMinor;
		void currency;
		if (!fiatFocused || dfield === 'fiat')
			fiatRaw = tri.fiatMinor == null ? '' : formatFiatMinor(tri.fiatMinor, currency);
	});

	function onFiatInput(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value;
		fiatRaw = v;
		const parsed = parseFiatText(v);
		if (parsed != null || v.trim() === '') {
			onedit?.('fiat');
			editField(tri, 'fiat', parsed);
		}
	}

	function onFiatBlur() {
		fiatFocused = false;
		// k / L / Cr shorthand resolves on blur: '1.2L' → ₹1,20,000
		const major = parseFiatShorthand(fiatRaw);
		if (major != null && Math.round(major * 100) !== tri.fiatMinor) {
			onedit?.('fiat');
			editField(tri, 'fiat', Math.round(major * 100));
		}
		onfieldblur?.('fiat');
	}

	// --- fx field ------------------------------------------------------------

	let fxRaw = $state('');
	let fxFocused = $state(false);
	$effect(() => {
		void fx.rate;
		if (!fxFocused) fxRaw = fx.rate == null ? '' : fx.rate.toFixed(2);
	});

	const inrRecordedMinor = $derived(
		tri.fiatMinor != null && fx.rate != null ? Math.round(tri.fiatMinor * fx.rate) : null
	);

	const inputBase =
		'h-9 w-full rounded-md border bg-surface num text-[13px] transition-colors duration-100 placeholder:text-muted/50';
	const labelCls = 'text-[11px] font-medium text-muted';
</script>

{#snippet fGlyph()}
	<span
		class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 num text-[11px] derived"
		title="derived — typing takes over"
	>
		ƒ
	</span>
{/snippet}

<div
	class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.1fr)] sm:gap-3"
>
	<!-- BTC amount -->
	<div>
		<span class="flex items-center gap-1.5 {labelCls}">
			<label for="tri-btc">{btcLabel}</label>
			{#if btcChip}
				<span class="rounded-full bg-surface-2 px-1.5 py-px text-[10px] derived">{btcChip}</span>
			{/if}
		</span>
		<div class="mt-1">
			<BtcAmountInput
				id="tri-btc"
				sats={tri.sats}
				derived={dfield === 'btc'}
				invalid={!!amountError}
				oninput={(v) => {
					onedit?.('btc');
					editField(tri, 'btc', v);
				}}
				onblur={() => onfieldblur?.('btc')}
			/>
		</div>
		{#if amountError}
			<p class="mt-1 text-[11px] text-loss">{amountError}</p>
		{/if}
	</div>

	<span class="hidden pt-8 num text-sm text-muted select-none sm:block" aria-hidden="true">×</span>

	<!-- rate -->
	<div>
		<label class={labelCls} for="tri-rate">Rate ({CURRENCY_SYMBOL[currency]}/BTC)</label>
		<div class="relative mt-1">
			<span
				class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 num text-[12px] text-muted"
			>
				{CURRENCY_SYMBOL[currency]}
			</span>
			<input
				id="tri-rate"
				type="text"
				value={rateRaw}
				placeholder="0"
				inputmode="decimal"
				autocomplete="off"
				spellcheck="false"
				class="{inputBase} border-border pr-7 pl-7 hover:border-muted/50 {rateStyledDerived
					? 'derived'
					: ''}"
				oninput={onRateInput}
				onfocus={() => (rateFocused = true)}
				onblur={() => {
					rateFocused = false;
					onfieldblur?.('rate');
				}}
			/>
			{#if rateStyledDerived}{@render fGlyph()}{/if}
		</div>
		{#if rateError}
			<p class="mt-1 text-[11px] text-loss">{rateError}</p>
		{:else if ratePending && tri.rate == null}
			<p class="mt-1 text-[11px] derived">Fetching rate…</p>
		{:else if rateChip}
			<p class="mt-1">
				<span class="rounded-full bg-surface-2 px-1.5 py-px text-[10px] derived">{rateChip}</span>
			</p>
		{/if}
		{#if currency !== 'INR' && tri.rate != null && fx.rate != null}
			<p class="mt-1 num text-[11px] text-muted">≈ {formatRateInr(tri.rate * fx.rate)} / BTC</p>
		{/if}
	</div>

	<span class="hidden pt-8 num text-sm text-muted select-none sm:block" aria-hidden="true">=</span>

	<!-- fiat amount + currency -->
	<div>
		<label class={labelCls} for="tri-fiat">{fiatLabel}</label>
		<div class="mt-1 flex">
			<div class="relative min-w-0 flex-1">
				<span
					class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 num text-[12px] text-muted"
				>
					{CURRENCY_SYMBOL[currency]}
				</span>
				<input
					id="tri-fiat"
					type="text"
					value={fiatRaw}
					placeholder="0"
					inputmode="decimal"
					autocomplete="off"
					spellcheck="false"
					title="shorthand: 5k = 5,000 · 1.2L = 1,20,000"
					aria-invalid={!!fiatError || undefined}
					class="{inputBase} rounded-r-none {fiatError
						? 'border-loss'
						: 'border-border hover:border-muted/50'} pr-7 pl-7 {dfield === 'fiat' ? 'derived' : ''}"
					oninput={onFiatInput}
					onfocus={() => (fiatFocused = true)}
					onblur={onFiatBlur}
				/>
				{#if dfield === 'fiat'}{@render fGlyph()}{/if}
			</div>
			<select
				value={currency}
				aria-label="Currency"
				class="h-9 shrink-0 select-field rounded-md rounded-l-none border border-l-0 border-border bg-surface-2 pl-2.5 num text-[12px] transition-colors duration-100 hover:text-text"
				onchange={(e) =>
					oncurrencychange((e.currentTarget as HTMLSelectElement).value as FiatCurrency)}
			>
				{#each ['INR', 'USD', 'EUR'] as const as c (c)}
					<option value={c}>{c}</option>
				{/each}
			</select>
		</div>
		{#if fiatError}
			<p class="mt-1 text-[11px] text-loss">{fiatError}</p>
		{/if}
	</div>
</div>

{#if currency !== 'INR'}
	<!-- FX conversion row (spec §3.3) -->
	<div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 num text-xs">
		<span class="text-muted">FX 1 {currency} =</span>
		<span class="relative">
			<span
				class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 num text-[12px] text-muted"
			>
				₹
			</span>
			<input
				type="text"
				value={fxRaw}
				inputmode="decimal"
				autocomplete="off"
				spellcheck="false"
				aria-label="FX rate to INR"
				placeholder="0.00"
				aria-invalid={!!fxError || undefined}
				class="h-8 w-24 rounded-md border bg-surface pl-6 num text-[13px] transition-colors duration-100 placeholder:text-muted/50 {fxError
					? 'border-loss'
					: 'border-border hover:border-muted/50'}"
				oninput={(e) => {
					fxRaw = (e.currentTarget as HTMLInputElement).value;
					onfxinput(parseRateText(fxRaw));
				}}
				onfocus={() => (fxFocused = true)}
				onblur={() => {
					fxFocused = false;
					onfieldblur?.('fx');
				}}
			/>
		</span>
		{#if fx.state === 'pending'}
			<span class="derived">Fetching…</span>
		{:else if fx.state === 'failed'}
			<span class="text-loss">Fetch failed — enter rate</span>
		{:else if fx.state === 'manual'}
			<span class="rounded-full bg-surface-2 px-1.5 py-px text-[10px] derived">manual</span>
		{:else if fx.state === 'saved'}
			<span class="rounded-full bg-surface-2 px-1.5 py-px text-[10px] derived">saved rate</span>
		{:else if fx.state === 'fetched' && fx.label}
			<span class="rounded-full bg-surface-2 px-1.5 py-px text-[10px] derived">
				fetched · {fx.label}
			</span>
		{/if}
		{#if inrRecordedMinor != null}
			<span class="text-muted">
				<ArrowRight size={12} class="inline-block align-middle" aria-hidden="true" />
				{formatInr(inrRecordedMinor)} will be recorded
			</span>
		{/if}
	</div>
	{#if fxError}
		<p class="mt-1 text-[11px] text-loss">{fxError}</p>
	{/if}
{/if}
