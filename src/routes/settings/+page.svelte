<script lang="ts">
	import { enhance } from '$app/forms';
	import Select from '$lib/components/Select.svelte';
	import { setUnitValue, unit } from '$lib/stores/unit.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The unit store is already hydrated by the layout; the control below reads
	// and writes it directly (setUnitValue POSTs /api/unit).

	let pwSubmitting = $state(false);
	let lnTesting = $state(false);
	// svelte-ignore state_referenced_locally
	let lnWalletId = $state(
		data.lightning?.configured && data.lightning.walletId != null
			? String(data.lightning.walletId)
			: ''
	);
	let lnCreating = $state(false);

	const inputCls =
		'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm transition-colors duration-100 hover:border-muted/60';
	const btnCls =
		'rounded-md border border-border px-3 py-1.5 text-xs transition-colors duration-100 hover:bg-surface-2 disabled:opacity-60';
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

	{#if data.lightning}
		{@const ln = data.lightning}
		<!-- Lightning -->
		<section aria-label="lightning" id="lightning">
			<h2 class="text-sm font-medium">Lightning</h2>
			{#if !ln.configured}
				<p role="alert" class="mt-1 text-xs text-loss">{ln.problem}.</p>
				<p class="mt-1 text-xs text-muted">The settings are described in docs/lightning.md.</p>
			{:else}
				<p class="mt-1 text-xs text-muted">
					satbook reads this phoenixd node and never pays from it. Give it phoenixd's limited-access
					password, which cannot pay or send.
				</p>
				<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
					<dt class="text-muted">phoenixd</dt>
					<dd class="num break-all">{ln.phoenixd}</dd>
					<dt class="text-muted">LNbits</dt>
					<dd class="num break-all">{ln.lnbits ?? 'not set — no comments or zaps'}</dd>
					{#if ln.proxy}
						<dt class="text-muted">proxy</dt>
						<dd class="num break-all">{ln.proxy}</dd>
					{/if}
					{#if ln.address}
						<dt class="text-muted">address</dt>
						<dd class="num break-all">{ln.address}</dd>
					{/if}
				</dl>

				<form
					method="POST"
					action="?/lnTest"
					class="mt-3"
					use:enhance={() => {
						lnTesting = true;
						return async ({ update }) => {
							await update({ reset: false });
							lnTesting = false;
						};
					}}
				>
					<button type="submit" disabled={lnTesting} class={btnCls}>
						{lnTesting ? 'Testing…' : 'Test connection'}
					</button>
				</form>
				{#if form?.lnTest}
					{@const t = form.lnTest}
					<ul class="mt-2 space-y-1 text-xs">
						<li>
							{#if t.node.ok}
								<span class="text-gain">phoenixd reachable</span>
								<span class="text-muted"
									>· {t.node.chain} · {t.node.version} · node {t.node.nodeId.slice(0, 12)}…</span
								>
							{:else}
								<span class="text-loss">{t.node.error}</span>
							{/if}
						</li>
						<li>
							{#if t.scope === 'limited'}
								<span class="text-gain">limited-access password</span>
								<span class="text-muted">· satbook cannot pay from this node</span>
							{:else if t.scope === 'full'}
								<span class="text-loss">full-access password</span>
								<span class="text-muted"
									>· this one can pay and send; switch to http-password-limited-access</span
								>
							{:else}
								<span class="text-muted">password scope could not be checked</span>
							{/if}
						</li>
						{#if t.lnbits}
							<li>
								{#if t.lnbits.ok}
									<span class="text-gain">LNbits reachable</span>
									<span class="text-muted">· wallet “{t.lnbits.name}”</span>
								{:else}
									<span class="text-loss">{t.lnbits.error}</span>
								{/if}
							</li>
						{/if}
					</ul>
				{/if}

				<div class="mt-5">
					<p class="text-xs text-muted">
						The wallet that stands for this node. Its ledger balance is checked against the node.
					</p>
					{#if ln.wallets.length > 0}
						<form method="POST" action="?/lnWallet" use:enhance class="mt-2 flex max-w-sm gap-2">
							<div class="min-w-0 flex-1">
								<Select
									name="walletId"
									ariaLabel="node wallet"
									value={lnWalletId}
									options={[
										...(ln.walletId == null ? [{ value: '', label: 'Choose a wallet…' }] : []),
										...ln.wallets.map((w) => ({
											value: String(w.id),
											label: `${w.name}${w.custodial ? ' (custodial)' : ''}`
										}))
									]}
									onchange={(v) => (lnWalletId = v)}
									triggerClass="w-full rounded-md border border-border bg-surface py-2 pr-7 pl-3 text-sm transition-colors duration-100 hover:border-muted/60"
								/>
							</div>
							<button type="submit" class={btnCls}>Save</button>
						</form>
					{/if}
					{#if ln.walletId == null || lnCreating}
						<form
							method="POST"
							action="?/lnWallet"
							use:enhance={() =>
								async ({ update }) => {
									await update();
									lnCreating = false;
								}}
							class="mt-2 flex max-w-sm gap-2"
						>
							<input type="hidden" name="create" value="1" />
							<input
								name="name"
								value="Lightning node"
								maxlength="40"
								aria-label="new wallet name"
								class={inputCls}
							/>
							<button type="submit" class="{btnCls} whitespace-nowrap">Create wallet</button>
						</form>
						<p class="mt-1 text-[11px] text-muted">A hot, self-custodial Lightning wallet.</p>
					{:else}
						<button
							type="button"
							onclick={() => (lnCreating = true)}
							class="mt-2 text-[11px] text-muted underline hover:text-text"
						>
							or create a new wallet for it
						</button>
					{/if}
					{#if form?.lnError}
						<p role="alert" class="mt-2 text-xs text-loss">{form.lnError}</p>
					{/if}
				</div>
			{/if}
		</section>
	{/if}

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
				<span class="text-text">Backup.</span> The SQLite database is the entire application state.
				Copy it with
				<code class="rounded border border-border bg-surface-2 px-1.5 py-0.5 num text-[11px]">
					deploy/backup.sh
				</code>
				rather than by hand — it takes a consistent copy while the app runs, which a plain file copy of
				a live database does not. Restoring is
				<code class="rounded border border-border bg-surface-2 px-1.5 py-0.5 num text-[11px]">
					deploy/restore.sh
				</code>; both are described in docs/self-hosting.md.
			</p>
			<p class="num text-[11px]">
				{data.txCount} transactions · {data.walletCount} wallets · {data.dbPath}
			</p>
		</div>
	</section>
</div>
