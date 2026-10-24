<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ReviewCard from '$lib/components/lightning/ReviewCard.svelte';
	import { unit } from '$lib/stores/unit.svelte';
	import { formatAmount } from '$lib/utils/display';
	import { paymentLabel } from '$lib/utils/lightning';
	import { formatIstDateShort } from '$lib/utils/time';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let selected = $state<Record<string, boolean>>({});
	const selectedKeys = $derived(data.pending.filter((p) => selected[p.key]).map((p) => p.key));
	const selectable = $derived(
		data.pending.filter((p) => p.direction === 'in' && p.actions.includes('income'))
	);
	let showIgnored = $state(false);

	const errorFor = (key: string) =>
		form && 'key' in form && form.key === key && 'error' in form ? (form.error as string) : null;
</script>

<svelte:head><title>Review · Lightning · satbook</title></svelte:head>

<div class="flex flex-wrap items-baseline justify-between gap-3">
	<h1 class="label-caps">lightning · review</h1>
	<a
		href="/lightning"
		class="inline-flex items-center gap-1 text-[11px] text-muted transition-colors duration-100 hover:text-text"
	>
		<ArrowLeft size={12} aria-hidden="true" /> dashboard
	</a>
</div>

<p class="mt-2 max-w-2xl text-xs leading-relaxed text-muted">
	Payments the node received or sent that are not in the ledger yet. Record each one as what it was:
	income (a donation, grant or pay), a transfer between your own wallets, or a spend. The amounts
	come from the node; INR values from the BTC price at the payment's time. Oldest first: work down
	the list, so every payment out finds the sats that came in before it.
</p>

{#if !data.wallet}
	<div class="mt-3 rounded-md border border-border bg-surface p-3 text-xs text-muted">
		Choose the wallet that stands for this node first.
		<a href="/settings#lightning" class="text-text underline">Settings → Lightning</a>
	</div>
{/if}
{#if data.testnet}
	<div class="mt-3 rounded-md border border-border bg-surface-2 p-3 text-xs">
		<span class="font-medium">Test network.</span>
		<span class="text-muted">
			{data.recordingAllowed
				? 'Recording is on because this is a development server; use a scratch database.'
				: 'Test sats have no value, so recording is off.'}
		</span>
	</div>
{/if}

{#if form?.recorded}
	<p class="mt-3 text-xs text-muted">
		Recorded as <a href="/tx#tx-{form.recorded}" class="text-text underline">#{form.recorded}</a>.
	</p>
{:else if form?.recordedMany}
	<p class="mt-3 text-xs text-muted">Recorded {form.recordedMany} as donations.</p>
{:else if form?.linked}
	<p class="mt-3 text-xs text-muted">
		Linked to <a href="/tx#tx-{form.linked}" class="text-text underline">#{form.linked}</a>.
	</p>
{/if}
{#if form?.bulkError}
	<p role="alert" class="mt-3 text-xs text-loss">{form.bulkError}</p>
{/if}

{#if data.pending.length === 0}
	<p class="mt-6 num text-xs text-muted">— Nothing to review —</p>
{:else}
	{#if selectable.length > 1}
		<form
			method="POST"
			use:enhance={() =>
				async ({ update }) => {
					await update();
					selected = {};
				}}
			class="mt-4 flex flex-wrap items-center gap-2 text-xs"
		>
			<label class="inline-flex items-center gap-1.5 text-muted">
				<input
					type="checkbox"
					class="size-3.5 accent-accent"
					checked={selectedKeys.length > 0 && selectedKeys.length === selectable.length}
					onchange={(e) => {
						const on = e.currentTarget.checked;
						selected = Object.fromEntries(selectable.map((p) => [p.key, on]));
					}}
				/>
				Select all incoming
			</label>
			{#each selectedKeys as key (key)}
				<input type="hidden" name="key" value={key} />
			{/each}
			<button
				type="submit"
				formaction="?/donations"
				disabled={selectedKeys.length === 0 || !data.recordingAllowed || !data.wallet}
				class="rounded-md border border-border px-2.5 py-1 text-[11px] transition-colors duration-100 hover:bg-surface-2 disabled:opacity-50"
			>
				Record {selectedKeys.length || ''} as donations
			</button>
			<button
				type="submit"
				formaction="?/ignore"
				disabled={selectedKeys.length === 0}
				class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted transition-colors duration-100 hover:text-text disabled:opacity-50"
			>
				Ignore {selectedKeys.length || ''}
			</button>
		</form>
	{/if}

	<ul class="mt-3 space-y-3">
		{#each data.pending as p (p.key)}
			<ReviewCard
				{p}
				wallets={data.wallets}
				allowed={data.recordingAllowed && data.wallet != null}
				error={errorFor(p.key)}
				bind:selected={selected[p.key]}
			/>
		{/each}
	</ul>

	<form
		method="POST"
		action="?/ignoreBefore"
		use:enhance
		class="mt-6 flex flex-wrap items-center gap-2 text-[11px] text-muted"
	>
		<span>Already recorded the early history elsewhere? Ignore everything before</span>
		<input
			type="date"
			name="date"
			aria-label="ignore payments before this date"
			class="rounded-md border border-border bg-bg px-2 py-1 num text-[11px] text-text"
		/>
		<button
			type="submit"
			class="rounded-md border border-border px-2.5 py-1 transition-colors duration-100 hover:text-text"
		>
			Ignore
		</button>
	</form>
{/if}

{#if data.ignored.length > 0}
	<section class="mt-8" aria-label="ignored payments">
		<button
			type="button"
			onclick={() => (showIgnored = !showIgnored)}
			class="label-caps transition-colors duration-100 hover:text-text"
		>
			ignored · {data.ignored.length}
			{showIgnored ? '▾' : '▸'}
		</button>
		{#if showIgnored}
			<ul class="mt-2 divide-y divide-border/60 text-xs">
				{#each data.ignored as p (p.key)}
					<li class="flex items-center justify-between gap-3 py-2">
						<span class="min-w-0 truncate">
							<span class="num text-muted">{formatIstDateShort(p.completedAt)}</span>
							· {paymentLabel(p.direction, p.subType)}
							· <span class="num">{formatAmount(p.amountSat, unit.value)}</span>
							{#if p.note}<span class="text-muted"> · {p.note}</span>{/if}
						</span>
						<form method="POST" action="?/restore" use:enhance>
							<input type="hidden" name="key" value={p.key} />
							<button
								type="submit"
								class="rounded border border-border px-2 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:text-text"
							>
								Restore
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}
