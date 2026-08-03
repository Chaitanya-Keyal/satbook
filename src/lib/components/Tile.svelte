<script lang="ts">
	// Dashboard/tax stat tile: small-caps label, big mono number, muted subline.
	// Renders as <a> (href), <button> (onclick) or plain <div>. `stale` draws the
	// amber underline for numbers computed from a stale price (spec §2).
	import type { Snippet } from 'svelte';

	let {
		label,
		value,
		valueClass = '',
		stale = false,
		staleTitle = 'Computed from a stale price',
		href,
		onclick,
		class: cls = '',
		subline,
		children
	}: {
		label: string;
		value: string;
		valueClass?: string;
		stale?: boolean;
		staleTitle?: string;
		href?: string;
		onclick?: () => void;
		class?: string;
		subline?: Snippet;
		children?: Snippet;
	} = $props();

	const base =
		'block rounded-md border border-border bg-surface p-4 transition-colors duration-100';
	const interactive = 'hover:bg-surface-2';
</script>

{#snippet body()}
	<p class="label-caps">{label}</p>
	<p
		class="mt-2 num text-xl leading-tight font-medium sm:text-2xl {valueClass}"
		class:stale-underline={stale}
		title={stale ? staleTitle : undefined}
	>
		{value}
	</p>
	{#if subline}
		<div class="mt-1.5 num text-xs text-muted">{@render subline()}</div>
	{/if}
	{#if children}
		{@render children()}
	{/if}
{/snippet}

{#if href}
	<a {href} class="{base} {interactive} {cls}">{@render body()}</a>
{:else if onclick}
	<button type="button" {onclick} class="{base} {interactive} w-full text-left {cls}">
		{@render body()}
	</button>
{:else}
	<div class="{base} {cls}">{@render body()}</div>
{/if}
