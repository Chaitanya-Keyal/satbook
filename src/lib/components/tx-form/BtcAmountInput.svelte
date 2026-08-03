<script lang="ts">
	// BTC quantity input (spec §3.2): honors the global sats⇄BTC unit with a
	// per-field ⇄ override; sats mode groups digits live with thin spaces; the
	// equivalent in the other unit renders as helper text. `derived` fields show
	// the ƒ glyph and the app-wide dimmed-italic derived voice.
	import { unit } from '$lib/stores/unit.svelte';
	import { formatBtc, formatSats } from '$lib/utils/money';
	import { parseBtcText } from './triad';

	let {
		sats,
		derived: isDerived = false,
		satsOnly = false,
		id = undefined,
		placeholder = '0',
		invalid = false,
		showHelper = true,
		oninput,
		onblur
	}: {
		sats: number | null;
		derived?: boolean;
		/** Fee fields: fixed sats, no ⇄, no helper line. */
		satsOnly?: boolean;
		id?: string;
		placeholder?: string;
		invalid?: boolean;
		showHelper?: boolean;
		oninput: (sats: number | null) => void;
		onblur?: () => void;
	} = $props();

	let override = $state<'sats' | 'btc' | null>(null);
	const fieldUnit = $derived(satsOnly ? 'sats' : (override ?? unit.value));

	let raw = $state('');
	let focused = $state(false);
	let el = $state<HTMLInputElement | null>(null);

	function display(): string {
		if (sats == null) return '';
		return fieldUnit === 'sats' ? formatSats(sats) : formatBtc(sats);
	}

	// Echo canonical value into the field whenever the user is not mid-edit
	// (derived fields re-render live; blur normalizes manual input).
	$effect(() => {
		void sats;
		void fieldUnit;
		void isDerived;
		if (!focused || isDerived) raw = display();
	});

	function handleInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		if (fieldUnit === 'sats') {
			// live thin-space grouping with caret preservation
			const caretDigits = input.value
				.slice(0, input.selectionStart ?? input.value.length)
				.replace(/\D/g, '').length;
			const digits = input.value.replace(/\D/g, '').slice(0, 15);
			const n = digits === '' ? null : parseInt(digits, 10);
			const next = n == null ? '' : formatSats(n);
			raw = next;
			input.value = next;
			let pos = 0;
			let seen = 0;
			while (pos < next.length && seen < caretDigits) {
				if (/\d/.test(next[pos])) seen++;
				pos++;
			}
			input.setSelectionRange(pos, pos);
			oninput(n);
		} else {
			raw = input.value;
			oninput(parseBtcText(input.value));
		}
	}

	function flip() {
		override = fieldUnit === 'sats' ? 'btc' : 'sats';
		raw = display();
	}

	export function focusInput() {
		el?.focus();
	}
</script>

<div class="relative">
	<input
		bind:this={el}
		{id}
		type="text"
		value={raw}
		{placeholder}
		inputmode={fieldUnit === 'sats' ? 'numeric' : 'decimal'}
		autocomplete="off"
		spellcheck="false"
		aria-invalid={invalid || undefined}
		class="h-9 w-full rounded-md border bg-surface {satsOnly
			? 'pr-12'
			: 'pr-20'} pl-2.5 num text-[13px] transition-colors duration-100 placeholder:text-muted/50 {invalid
			? 'border-loss'
			: 'border-border hover:border-muted/50'} {isDerived ? 'derived' : ''}"
		oninput={handleInput}
		onfocus={() => (focused = true)}
		onblur={() => {
			focused = false;
			onblur?.();
		}}
	/>
	<div class="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1.5">
		{#if isDerived}
			<span class="num text-[11px] derived" title="derived — typing takes over">ƒ</span>
		{/if}
		<span class="num text-[11px] text-muted">{fieldUnit === 'sats' ? 'sats' : 'BTC'}</span>
		{#if !satsOnly}
			<button
				type="button"
				tabindex="-1"
				class="pointer-events-auto rounded px-0.5 num text-[11px] text-muted transition-colors duration-100 hover:text-text"
				title="flip sats/BTC for this field only"
				aria-label="flip unit for this field"
				onclick={flip}
			>
				⇄
			</button>
		{/if}
	</div>
</div>
{#if !satsOnly && showHelper && sats != null && sats > 0}
	<p class="mt-1 num text-[11px] text-muted">
		= {fieldUnit === 'sats' ? `${formatBtc(sats)} BTC` : `${formatSats(sats)} sats`}
	</p>
{/if}
