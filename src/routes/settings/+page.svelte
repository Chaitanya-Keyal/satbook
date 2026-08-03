<script lang="ts">
	import { enhance } from '$app/forms';
	import { setUnitValue, unit } from '$lib/stores/unit.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The unit store is already hydrated by the layout; the control below reads
	// and writes it directly (setUnitValue POSTs /api/unit).

	let pwSubmitting = $state(false);
</script>

<svelte:head><title>settings · satbook</title></svelte:head>

<h1 class="label-caps">settings</h1>

<div class="mt-3 max-w-2xl space-y-10">
	<!-- Display -->
	<section aria-label="display">
		<h2 class="text-sm font-medium">Display</h2>
		<p class="mt-1 text-xs text-muted">
			Default unit for every BTC quantity — tiles, ledger, wallets, lot queue and the entry form.
			Also flips with <kbd class="rounded border border-border bg-surface-2 px-1 num text-[11px]"
				>u</kbd
			>
			or the top-bar toggle.
		</p>
		<div
			class="mt-3 inline-flex rounded-md border border-border p-0.5"
			role="group"
			aria-label="display unit"
		>
			<button
				type="button"
				aria-pressed={unit.value === 'sats'}
				onclick={() => setUnitValue('sats')}
				class="rounded-[4px] px-3 py-1 num text-xs transition-colors duration-100 {unit.value ===
				'sats'
					? 'bg-surface-2 text-text'
					: 'text-muted hover:text-text'}"
			>
				sats
			</button>
			<button
				type="button"
				aria-pressed={unit.value === 'btc'}
				onclick={() => setUnitValue('btc')}
				class="rounded-[4px] px-3 py-1 num text-xs transition-colors duration-100 {unit.value ===
				'btc'
					? 'bg-surface-2 text-text'
					: 'text-muted hover:text-text'}"
			>
				BTC
			</button>
		</div>
	</section>

	<!-- Security -->
	<section aria-label="security">
		<h2 class="text-sm font-medium">Security</h2>
		<p class="mt-1 text-xs text-muted">
			Changing the password signs out every session — including this one — and returns you to the
			lock screen.
		</p>
		<form
			method="POST"
			action="?/changePassword"
			class="mt-3 max-w-xs space-y-3"
			use:enhance={() => {
				pwSubmitting = true;
				return async ({ update }) => {
					pwSubmitting = false;
					await update();
				};
			}}
		>
			<div>
				<label class="text-xs text-muted" for="pw-current">Current password</label>
				<input
					id="pw-current"
					name="current"
					type="password"
					required
					autocomplete="current-password"
					class="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 num text-sm transition-colors duration-100 hover:border-muted/60"
				/>
			</div>
			<div>
				<label class="text-xs text-muted" for="pw-new">New password</label>
				<input
					id="pw-new"
					name="new"
					type="password"
					required
					minlength="8"
					autocomplete="new-password"
					class="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 num text-sm transition-colors duration-100 hover:border-muted/60"
				/>
			</div>
			<div>
				<label class="text-xs text-muted" for="pw-confirm">Confirm new password</label>
				<input
					id="pw-confirm"
					name="confirm"
					type="password"
					required
					minlength="8"
					autocomplete="new-password"
					class="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 num text-sm transition-colors duration-100 hover:border-muted/60"
				/>
			</div>
			{#if form?.passwordError != null}
				<p role="alert" class="text-xs text-loss">{form.passwordError}</p>
			{/if}
			<button
				type="submit"
				disabled={pwSubmitting}
				class="rounded-md bg-accent px-3 py-2 text-xs font-medium text-bg transition-opacity duration-100 hover:opacity-90 disabled:opacity-60"
			>
				{pwSubmitting ? 'Changing…' : 'Change password'}
			</button>
		</form>
	</section>

	<!-- Data -->
	<section aria-label="data">
		<h2 class="text-sm font-medium">Data</h2>
		<div class="mt-3 space-y-3 text-xs leading-relaxed text-muted">
			<p>
				<span class="text-text">Import.</span> The one-time Excel import runs from the terminal:
				<code class="rounded border border-border bg-surface-2 px-1.5 py-0.5 num text-[11px]">
					bun scripts/import-xlsx.ts
				</code>
				— see the README for the sheet format and re-run rules.
			</p>
			<p>
				<span class="text-text">Backup.</span> The SQLite file
				<code class="rounded border border-border bg-surface-2 px-1.5 py-0.5 num text-[11px]">
					data/btc.db
				</code>
				is the entire application state — copy it and you have a full backup; see the README for the restore
				steps.
			</p>
			<p class="num text-[11px]">
				{data.txCount} transactions · {data.walletCount} wallets · data/btc.db
			</p>
		</div>
	</section>
</div>
