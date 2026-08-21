<script lang="ts">
	// Three-way converter: bitcoin ⇄ rupees ⇄ dollars at the live price, with
	// both rates editable so it doubles as a what-if calculator. Nothing is
	// saved — the ledger is untouched by this screen.
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import BtcAmountInput from '$lib/components/tx-form/BtcAmountInput.svelte';
	import { parseFiatText, parseRateText } from '$lib/components/tx-form/triad';
	import type { LivePricePayload } from '$lib/types';
	import { indianGroup, parseFiatShorthand, SATS_PER_BTC } from '$lib/utils/money';
	import { formatRelative } from '$lib/utils/time';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Field = 'btc' | 'inr' | 'usd';

	const inputBase =
		'h-9 w-full rounded-md border border-border bg-surface num text-[13px] transition-colors duration-100 placeholder:text-muted/50 hover:border-muted/50';
	const labelCls = 'text-[11px] font-medium text-muted';

	// svelte-ignore state_referenced_locally
	let price = $state<LivePricePayload | null>(data.price);
	// svelte-ignore state_referenced_locally
	let now = $state(data.now);
	let refreshing = $state(false);

	// --- rates ---------------------------------------------------------------

	const liveUsdInr = (p: LivePricePayload | null) =>
		p && p.btcUsd > 0 ? p.btcInr / p.btcUsd : null;

	// svelte-ignore state_referenced_locally
	let btcInr = $state<number | null>(data.price?.btcInr ?? null);
	// svelte-ignore state_referenced_locally
	let usdInr = $state<number | null>(liveUsdInr(data.price));
	let ratesTouched = $state(false);

	const btcUsd = $derived(btcInr != null && usdInr != null && usdInr > 0 ? btcInr / usdInr : null);
	const ready = $derived(btcInr != null && btcInr > 0 && usdInr != null && usdInr > 0);

	function useLiveRates() {
		if (!price) return;
		btcInr = price.btcInr;
		usdInr = liveUsdInr(price);
		ratesTouched = false;
	}

	async function refresh() {
		refreshing = true;
		try {
			const res = await fetch('/api/price');
			if (res.ok) {
				price = (await res.json()) as LivePricePayload;
				if (!ratesTouched) useLiveRates();
			}
		} catch {
			/* keep the last known rates */
		}
		now = Math.floor(Date.now() / 1000);
		refreshing = false;
	}

	const rateChip = $derived.by(() => {
		if (ratesTouched) return 'Manual rates';
		if (!price) return 'No live price — enter rates';
		const age = Math.max(0, now - price.fetchedAt);
		return `${price.stale || age > 1800 ? 'Stale' : 'Live'} · ${formatRelative(price.fetchedAt, now)}`;
	});

	// --- amounts -------------------------------------------------------------
	// One anchor field holds what the user typed; the other two derive from it
	// directly (never through a rounded intermediate).

	let anchor = $state<Field>('inr');
	let amount = $state<number | null>(null); // sats when anchor is btc, else major fiat

	const sats = $derived.by(() => {
		if (amount == null || !ready) return anchor === 'btc' ? amount : null;
		if (anchor === 'btc') return amount;
		if (anchor === 'inr') return Math.round((amount / btcInr!) * SATS_PER_BTC);
		return Math.round((amount / btcUsd!) * SATS_PER_BTC);
	});
	const inrMajor = $derived.by(() => {
		if (amount == null || !ready) return null;
		if (anchor === 'inr') return amount;
		if (anchor === 'btc') return (amount / SATS_PER_BTC) * btcInr!;
		return amount * usdInr!;
	});
	const usdMajor = $derived.by(() => {
		if (amount == null || !ready) return null;
		if (anchor === 'usd') return amount;
		if (anchor === 'btc') return (amount / SATS_PER_BTC) * btcUsd!;
		return amount / usdInr!;
	});

	const isDerived = (f: Field) => amount != null && anchor !== f;

	/** Adaptive precision: 2dp normally, 4dp for sub-unit amounts, zeros trimmed. */
	function fiatText(v: number | null, indian: boolean): string {
		if (v == null) return '';
		const abs = Math.abs(v);
		let s = abs.toFixed(abs > 0 && abs < 1 ? 4 : 2);
		if (s.includes('.')) s = s.replace(/\.?0+$/, '');
		const [whole, frac] = s.split('.');
		const grouped = indian ? indianGroup(whole) : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		return `${v < 0 ? '−' : ''}${grouped}${frac ? `.${frac}` : ''}`;
	}

	// --- field wiring --------------------------------------------------------

	let inrRaw = $state('');
	let usdRaw = $state('');
	let inrFocused = $state(false);
	let usdFocused = $state(false);
	// Edited-since-focus. Without this, blurring an untouched derived field
	// would re-anchor onto its own rounded display text and the other fields
	// would drift a digit every time focus moved between them.
	let inrDirty = $state(false);
	let usdDirty = $state(false);

	// Echo the canonical value whenever this field is not the one being typed in.
	$effect(() => {
		void inrMajor;
		if (!inrFocused || anchor !== 'inr') inrRaw = fiatText(inrMajor, true);
	});
	$effect(() => {
		void usdMajor;
		if (!usdFocused || anchor !== 'usd') usdRaw = fiatText(usdMajor, false);
	});

	function onFiatInput(field: 'inr' | 'usd', e: Event) {
		const raw = (e.currentTarget as HTMLInputElement).value;
		if (field === 'inr') {
			inrRaw = raw;
			inrDirty = true;
		} else {
			usdRaw = raw;
			usdDirty = true;
		}
		anchor = field;
		const minor = parseFiatText(raw);
		amount = minor == null ? null : minor / 100;
	}

	// Blur accepts the same k / L shorthand as the entry form ('1.2L' → 120000).
	function onFiatBlur(field: 'inr' | 'usd') {
		const raw = field === 'inr' ? inrRaw : usdRaw;
		const dirty = field === 'inr' ? inrDirty : usdDirty;
		const shorthand = dirty ? parseFiatShorthand(raw) : null;
		if (shorthand != null && raw.trim() !== '') {
			anchor = field;
			amount = shorthand;
		}
		if (field === 'inr') {
			inrFocused = false;
			inrDirty = false;
		} else {
			usdFocused = false;
			usdDirty = false;
		}
	}

	let btcInrRaw = $state('');
	let btcUsdRaw = $state('');
	let usdInrRaw = $state('');
	let btcInrFocused = $state(false);
	let btcUsdFocused = $state(false);
	let usdInrFocused = $state(false);

	// Grouped while idle for legibility; the parser strips separators on input.
	$effect(() => {
		void btcInr;
		if (!btcInrFocused) btcInrRaw = btcInr == null ? '' : indianGroup(String(Math.round(btcInr)));
	});
	$effect(() => {
		void btcUsd;
		if (!btcUsdFocused) btcUsdRaw = fiatText(btcUsd, false);
	});
	$effect(() => {
		void usdInr;
		if (!usdInrFocused) usdInrRaw = usdInr == null ? '' : usdInr.toFixed(2);
	});

	function onRateInput(which: 'btcInr' | 'btcUsd' | 'usdInr', e: Event) {
		const raw = (e.currentTarget as HTMLInputElement).value;
		const parsed = parseRateText(raw);
		ratesTouched = true;
		if (which === 'btcInr') {
			btcInrRaw = raw;
			btcInr = parsed;
		} else if (which === 'usdInr') {
			usdInrRaw = raw;
			usdInr = parsed;
		} else {
			// Only two of the three rates are independent: a typed dollar price
			// keeps the FX rate and moves the rupee price.
			btcUsdRaw = raw;
			if (parsed != null && usdInr != null && usdInr > 0) btcInr = parsed * usdInr;
			else if (parsed == null) btcInr = null;
		}
	}

	function clearAll() {
		amount = null;
		anchor = 'inr';
	}
</script>

<svelte:head><title>convert · satbook</title></svelte:head>

<h1 class="label-caps">convert</h1>
<p class="mt-1 text-xs text-muted">
	Bitcoin, rupees and dollars at the live price. Type in any field — the other two follow. Nothing
	here is saved.
</p>

<div class="mt-4 max-w-md space-y-3">
	<!-- Amounts -->
	<section class="rounded-md border border-border bg-surface p-4" aria-label="amounts">
		<div class="space-y-3">
			<div>
				<label class={labelCls} for="conv-btc">Bitcoin</label>
				<div class="mt-1">
					<BtcAmountInput
						id="conv-btc"
						sats={sats ?? null}
						derived={isDerived('btc')}
						oninput={(s) => {
							anchor = 'btc';
							amount = s;
						}}
					/>
				</div>
			</div>

			<div>
				<label class={labelCls} for="conv-inr">Indian rupees</label>
				<div class="relative mt-1">
					<span
						class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 num text-[12px] text-muted"
					>
						₹
					</span>
					<input
						id="conv-inr"
						type="text"
						value={inrRaw}
						placeholder="0"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						class="{inputBase} pr-8 pl-7 {isDerived('inr') ? 'derived' : ''}"
						oninput={(e) => onFiatInput('inr', e)}
						onfocus={() => {
							inrFocused = true;
							inrDirty = false;
						}}
						onblur={() => onFiatBlur('inr')}
					/>
					{#if isDerived('inr')}
						<span
							class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 num text-[11px] derived"
							title="derived — typing takes over">ƒ</span
						>
					{/if}
				</div>
			</div>

			<div>
				<label class={labelCls} for="conv-usd">US dollars</label>
				<div class="relative mt-1">
					<span
						class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 num text-[12px] text-muted"
					>
						$
					</span>
					<input
						id="conv-usd"
						type="text"
						value={usdRaw}
						placeholder="0"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						class="{inputBase} pr-8 pl-7 {isDerived('usd') ? 'derived' : ''}"
						oninput={(e) => onFiatInput('usd', e)}
						onfocus={() => {
							usdFocused = true;
							usdDirty = false;
						}}
						onblur={() => onFiatBlur('usd')}
					/>
					{#if isDerived('usd')}
						<span
							class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 num text-[11px] derived"
							title="derived — typing takes over">ƒ</span
						>
					{/if}
				</div>
			</div>
		</div>

		{#if !ready}
			<p class="mt-3 text-[11px] text-loss">Enter both rates below to convert.</p>
		{:else if amount != null}
			<button
				type="button"
				class="mt-3 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-text"
				onclick={clearAll}
			>
				Clear
			</button>
		{/if}
	</section>

	<!-- Rates -->
	<section class="rounded-md border border-border bg-surface p-4" aria-label="rates">
		<div class="flex items-center justify-between gap-3">
			<h2 class="label-caps">rates</h2>
			<div class="flex items-center gap-2">
				<span class="rounded-full bg-surface-2 px-1.5 py-px text-[10px] derived">{rateChip}</span>
				<button
					type="button"
					class="rounded-md p-1 text-muted transition-colors duration-100 hover:text-text disabled:opacity-50"
					onclick={refresh}
					disabled={refreshing}
					title="Refresh live price"
					aria-label="Refresh live price"
				>
					<RefreshCw size={13} strokeWidth={1.5} class={refreshing ? 'animate-spin' : ''} />
				</button>
			</div>
		</div>

		<div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
			<div>
				<label class={labelCls} for="conv-rate-btc">1 BTC in ₹</label>
				<div class="relative mt-1">
					<span
						class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 num text-[12px] text-muted"
					>
						₹
					</span>
					<input
						id="conv-rate-btc"
						type="text"
						value={btcInrRaw}
						placeholder="0"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						class="{inputBase} pr-2.5 pl-7"
						oninput={(e) => onRateInput('btcInr', e)}
						onfocus={() => (btcInrFocused = true)}
						onblur={() => (btcInrFocused = false)}
					/>
				</div>
			</div>
			<div>
				<label class={labelCls} for="conv-rate-btcusd">1 BTC in $</label>
				<div class="relative mt-1">
					<span
						class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 num text-[12px] text-muted"
					>
						$
					</span>
					<input
						id="conv-rate-btcusd"
						type="text"
						value={btcUsdRaw}
						placeholder="0"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						class="{inputBase} pr-2.5 pl-7"
						oninput={(e) => onRateInput('btcUsd', e)}
						onfocus={() => (btcUsdFocused = true)}
						onblur={() => (btcUsdFocused = false)}
					/>
				</div>
			</div>
			<div class="col-span-2 sm:col-span-1">
				<label class={labelCls} for="conv-rate-usd">1 USD in ₹</label>
				<div class="relative mt-1">
					<span
						class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 num text-[12px] text-muted"
					>
						₹
					</span>
					<input
						id="conv-rate-usd"
						type="text"
						value={usdInrRaw}
						placeholder="0"
						inputmode="decimal"
						autocomplete="off"
						spellcheck="false"
						class="{inputBase} pr-2.5 pl-7"
						oninput={(e) => onRateInput('usdInr', e)}
						onfocus={() => (usdInrFocused = true)}
						onblur={() => (usdInrFocused = false)}
					/>
				</div>
			</div>
		</div>

		{#if ratesTouched && price}
			<div class="mt-3">
				<button
					type="button"
					class="num text-[11px] text-muted underline decoration-border underline-offset-2 transition-colors duration-100 hover:text-text"
					onclick={useLiveRates}
				>
					Use live rates
				</button>
			</div>
		{/if}
	</section>
</div>
