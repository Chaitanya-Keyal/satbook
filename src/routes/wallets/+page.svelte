<script lang="ts">
	import Select from '$lib/components/Select.svelte';
	import { enhance } from '$app/forms';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Flame from '@lucide/svelte/icons/flame';
	import Landmark from '@lucide/svelte/icons/landmark';
	import Plus from '@lucide/svelte/icons/plus';
	import Snowflake from '@lucide/svelte/icons/snowflake';
	import { unit } from '$lib/stores/unit.svelte';
	import type { WalletKind } from '$lib/types';
	import { formatAmount } from '$lib/utils/display';
	import { formatInr, formatSats, mulDivRound, SATS_PER_BTC } from '$lib/utils/money';
	import { formatIstDateShort, formatRelative } from '$lib/utils/time';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// svelte-ignore state_referenced_locally
	let newKind = $state('hot');
	// svelte-ignore state_referenced_locally
	let addrWalletId = $state(String(data.wallets[0]?.id ?? ''));

	type WalletCard = PageData['wallets'][number];

	const EM = '—';
	const KIND_ICON: Record<WalletKind, typeof Flame> = {
		hot: Flame,
		cold: Snowflake,
		exchange: Landmark
	};
	const KIND_LABEL: Record<WalletKind, string> = {
		hot: 'hot wallet',
		cold: 'cold storage',
		exchange: 'exchange'
	};

	const priceStale = $derived(
		data.price != null && (data.price.stale || data.now - data.price.fetchedAt > 600)
	);

	function inrValue(sats: number): number | null {
		if (data.price == null || sats < 0) return null;
		return mulDivRound(sats, Math.round(data.price.btcInr * 100), SATS_PER_BTC);
	}

	function share(sats: number): number {
		return data.holdingsSats > 0 ? (sats / data.holdingsSats) * 100 : 0;
	}

	// --- card menu / rename / archive -----------------------------------------

	let menuId = $state<number | null>(null);
	let renamingId = $state<number | null>(null);
	let renameValue = $state('');
	let confirmArchive = $state<WalletCard | null>(null);
	let archiving = $state(false);

	function startRename(w: WalletCard) {
		menuId = null;
		renamingId = w.id;
		renameValue = w.name;
	}

	// --- add wallet ------------------------------------------------------------

	let addOpen = $state(false);

	// --- addresses -------------------------------------------------------------

	const addressGroups = $derived.by(() => {
		const byWallet = new Map<number, PageData['addresses']>();
		for (const a of data.addresses) {
			const list = byWallet.get(a.walletId) ?? [];
			list.push(a);
			byWallet.set(a.walletId, list);
		}
		const nameOf = (id: number) => data.wallets.find((w) => w.id === id)?.name ?? `wallet #${id}`;
		return [...byWallet.entries()]
			.map(([walletId, list]) => ({ walletId, name: nameOf(walletId), list }))
			.sort((a, b) => a.name.localeCompare(b.name));
	});

	let confirmAddrId = $state<number | null>(null);
	let copiedAddrId = $state<number | null>(null);

	function truncAddr(a: string): string {
		return a.length <= 24 ? a : `${a.slice(0, 12)}…${a.slice(-8)}`;
	}

	function copyAddr(id: number, address: string) {
		void navigator.clipboard.writeText(address);
		copiedAddrId = id;
		setTimeout(() => {
			if (copiedAddrId === id) copiedAddrId = null;
		}, 1500);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (confirmArchive) confirmArchive = null;
		else if (menuId != null) menuId = null;
		else if (renamingId != null) renamingId = null;
	}
</script>

<svelte:head><title>wallets · satbook</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<h1 class="label-caps">wallets</h1>

<!-- Wallet cards -->
<div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
	{#each data.wallets as w (w.id)}
		{@const value = inrValue(w.sats)}
		<div class="relative rounded-md border border-border bg-surface p-4">
			<div class="flex items-start justify-between gap-2">
				{#if renamingId === w.id}
					<form
						method="POST"
						action="?/renameWallet"
						class="flex min-w-0 flex-1 items-center gap-1.5"
						use:enhance={() => {
							return async ({ result, update }) => {
								if (result.type === 'success') renamingId = null;
								await update({ reset: false });
							};
						}}
					>
						<input type="hidden" name="id" value={w.id} />
						<!-- svelte-ignore a11y_autofocus -->
						<input
							name="name"
							bind:value={renameValue}
							autofocus
							maxlength="40"
							aria-label="wallet name"
							class="w-full min-w-0 rounded-md border border-border bg-bg px-2 py-1 text-[13px] transition-colors duration-100 hover:border-muted/60"
						/>
						<button
							type="submit"
							class="shrink-0 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-bg transition-opacity duration-100 hover:opacity-90"
						>
							Save
						</button>
						<button
							type="button"
							onclick={() => (renamingId = null)}
							class="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-muted transition-colors duration-100 hover:text-text"
						>
							Cancel
						</button>
					</form>
				{:else}
					{@const KindIcon = KIND_ICON[w.kind]}
					<p class="flex min-w-0 items-center gap-2 text-[13px] font-medium">
						<span class="shrink-0 text-muted" title={KIND_LABEL[w.kind]}>
							<KindIcon size={14} strokeWidth={1.75} aria-label={KIND_LABEL[w.kind]} />
						</span>
						<span class="truncate">{w.name}</span>
					</p>
					<button
						type="button"
						aria-label="wallet menu"
						aria-expanded={menuId === w.id}
						onclick={() => (menuId = menuId === w.id ? null : w.id)}
						class="-mt-1 -mr-1.5 shrink-0 rounded-md p-1.5 text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-text"
					>
						<Ellipsis size={14} aria-hidden="true" />
					</button>
				{/if}
			</div>

			{#if form?.renameError != null && form?.renameId === w.id && renamingId === w.id}
				<p role="alert" class="mt-1 text-[11px] text-loss">{form.renameError}</p>
			{/if}

			<p class="mt-3 num text-xl leading-tight font-medium">
				{formatAmount(w.sats, unit.value)}
			</p>
			<p
				class="mt-1 num text-xs text-muted"
				class:stale-underline={value != null && priceStale}
				title={value != null && priceStale ? 'Computed from a stale price' : undefined}
			>
				{value != null ? formatInr(value) : 'no price data'}
			</p>

			<div class="mt-3 h-1 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
				<div
					class="h-full rounded-full bg-muted/70"
					style="width: {share(w.sats)}%; min-width: {w.sats > 0 ? '2px' : '0'}"
				></div>
			</div>
			<p class="mt-2 num text-[11px] text-muted">
				{share(w.sats).toFixed(1)}% of holdings
				{#if w.lastTs != null}
					· last activity {formatRelative(w.lastTs, data.now)}
				{:else}
					· no activity yet
				{/if}
			</p>

			{#if menuId === w.id}
				<button
					type="button"
					class="fixed inset-0 z-30 cursor-default"
					aria-label="Close menu"
					onclick={() => (menuId = null)}
				></button>
				<div
					role="menu"
					class="absolute top-9 right-3 z-40 w-52 rounded-md border border-border bg-surface-2 py-1 text-xs"
				>
					<button
						type="button"
						role="menuitem"
						onclick={() => startRename(w)}
						class="block w-full px-3 py-1.5 text-left transition-colors duration-100 hover:bg-surface"
					>
						Rename
					</button>
					{#if w.sats === 0}
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								menuId = null;
								confirmArchive = w;
							}}
							class="block w-full px-3 py-1.5 text-left transition-colors duration-100 hover:bg-surface"
						>
							Archive
						</button>
					{:else}
						<span
							class="block cursor-not-allowed px-3 py-1.5 text-muted"
							role="menuitem"
							aria-disabled="true"
						>
							Archive
							<span class="block text-[10px]">Only zero-balance wallets can be archived</span>
						</span>
					{/if}
					<a
						href="/tx?wallet={w.id}"
						role="menuitem"
						class="flex items-center gap-1 px-3 py-1.5 transition-colors duration-100 hover:bg-surface"
					>
						View transactions <ArrowRight size={14} aria-hidden="true" />
					</a>
				</div>
			{/if}
		</div>
	{/each}

	<!-- Add wallet ghost card -->
	{#if addOpen}
		<form
			method="POST"
			action="?/createWallet"
			class="rounded-md border border-dashed border-border bg-surface p-4"
			use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') addOpen = false;
					await update();
				};
			}}
		>
			<p class="label-caps">new wallet</p>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				name="name"
				placeholder="Name"
				required
				maxlength="40"
				autofocus
				aria-label="wallet name"
				class="mt-2 w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] transition-colors duration-100 placeholder:text-muted/70 hover:border-muted/60"
			/>
			<div class="mt-2">
				<Select
					name="kind"
					ariaLabel="wallet kind"
					value={newKind}
					options={[
						{ value: 'hot', label: 'Hot wallet' },
						{ value: 'cold', label: 'Cold storage' },
						{ value: 'exchange', label: 'Exchange' }
					]}
					onchange={(v) => (newKind = v)}
					triggerClass="w-full rounded-md border border-border bg-bg py-1.5 pl-2.5 pr-7 text-xs transition-colors duration-100 hover:border-muted/60"
				/>
			</div>
			{#if form?.createError != null}
				<p role="alert" class="mt-2 text-[11px] text-loss">{form.createError}</p>
			{/if}
			<div class="mt-3 flex gap-2">
				<button
					type="submit"
					class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity duration-100 hover:opacity-90"
				>
					Create
				</button>
				<button
					type="button"
					onclick={() => (addOpen = false)}
					class="rounded-md px-2 py-1.5 text-xs text-muted transition-colors duration-100 hover:text-text"
				>
					Cancel
				</button>
			</div>
		</form>
	{:else}
		<button
			type="button"
			onclick={() => (addOpen = true)}
			class="flex min-h-[140px] items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-sm text-muted transition-colors duration-100 hover:border-muted/60 hover:text-text"
		>
			<Plus size={14} aria-hidden="true" />
			Add wallet
		</button>
	{/if}
</div>

<!-- Transfer history -->
<section class="mt-10" aria-label="transfer history">
	<h2 class="label-caps">transfer history</h2>
	{#if data.transfers.length === 0}
		<p class="mt-3 num text-xs text-muted">— No transfers —</p>
	{:else}
		<div class="mt-2 overflow-x-auto">
			<table class="w-full border-collapse text-xs">
				<thead>
					<tr class="border-b border-border">
						<th class="py-2 pr-4 text-left label-caps font-medium">route</th>
						<th class="py-2 pr-4 text-right label-caps font-medium">amount</th>
						<th class="py-2 pr-4 text-right label-caps font-medium">fee</th>
						<th class="py-2 pr-4 text-left label-caps font-medium">date</th>
						<th class="py-2 text-left label-caps font-medium">txid</th>
					</tr>
				</thead>
				<tbody>
					{#each data.transfers as t (t.id)}
						<tr class="border-b border-border/60 last:border-0">
							<td class="py-2 pr-4 whitespace-nowrap">
								{t.fromName}<ArrowRight
									size={12}
									class="mx-1 inline-block align-middle"
									aria-hidden="true"
								/><span class="sr-only">to </span>{t.toName}
							</td>
							<td class="py-2 pr-4 text-right num whitespace-nowrap">
								{formatAmount(t.amountSats, unit.value)}
							</td>
							<td class="py-2 pr-4 text-right num whitespace-nowrap text-muted">
								{t.feeSats > 0 ? `${formatSats(t.feeSats)} sats` : EM}
							</td>
							<td class="py-2 pr-4 num whitespace-nowrap">{formatIstDateShort(t.ts)}</td>
							<td class="py-2 num whitespace-nowrap">
								{#if t.txid}
									<a
										href="https://blockstream.info/tx/{t.txid}"
										target="_blank"
										rel="noreferrer"
										title={t.txid}
										class="inline-flex items-center gap-1 text-muted underline transition-colors duration-100 hover:text-text"
									>
										{t.txid.slice(0, 10)}… <ExternalLink size={11} aria-hidden="true" />
									</a>
								{:else}
									<span class="text-muted">{EM}</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<!-- Saved addresses -->
<section class="mt-10" aria-label="saved addresses">
	<h2 class="label-caps">saved addresses</h2>
	<p class="mt-1 text-xs text-muted">
		Used to auto-select your outputs when you paste a txid in the entry form.
	</p>

	{#if data.addresses.length === 0}
		<p class="mt-3 num text-xs text-muted">
			— None saved — optional; add one below and txid lookups will tag your own outputs
		</p>
	{:else}
		<div class="mt-3 space-y-4">
			{#each addressGroups as group (group.walletId)}
				<div>
					<h3 class="text-xs font-medium">{group.name}</h3>
					<ul class="mt-1 divide-y divide-border/60">
						{#each group.list as a (a.id)}
							<li class="flex items-center gap-3 py-1.5 text-xs">
								<span class="w-28 shrink-0 truncate text-muted" title={a.label ?? undefined}>
									{a.label ?? EM}
								</span>
								<span class="min-w-0 flex-1 truncate num" title={a.address}>
									{truncAddr(a.address)}
								</span>
								<button
									type="button"
									onclick={() => copyAddr(a.id, a.address)}
									class="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:text-text"
								>
									{#if copiedAddrId === a.id}
										<Check size={11} aria-hidden="true" /> Copied
									{:else}
										<Copy size={11} aria-hidden="true" /> Copy
									{/if}
								</button>
								{#if confirmAddrId === a.id}
									<form method="POST" action="?/deleteAddress" class="shrink-0" use:enhance>
										<input type="hidden" name="id" value={a.id} />
										<button
											type="submit"
											class="rounded bg-loss px-1.5 py-0.5 text-[11px] font-medium text-bg transition-opacity duration-100 hover:opacity-90"
										>
											Confirm delete
										</button>
									</form>
									<button
										type="button"
										onclick={() => (confirmAddrId = null)}
										class="shrink-0 rounded px-1 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:text-text"
									>
										Keep
									</button>
								{:else}
									<button
										type="button"
										onclick={() => (confirmAddrId = a.id)}
										class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:border-loss/40 hover:text-loss"
									>
										Delete
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Add address -->
	<form
		method="POST"
		action="?/addAddress"
		class="mt-4 flex flex-wrap items-start gap-2"
		use:enhance
	>
		<Select
			name="walletId"
			ariaLabel="wallet"
			value={addrWalletId}
			options={data.wallets.map((w) => ({ value: String(w.id), label: w.name }))}
			onchange={(v) => (addrWalletId = v)}
			triggerClass="rounded-md border border-border bg-surface py-1.5 pl-2.5 pr-7 text-xs transition-colors duration-100 hover:border-muted/60"
		/>
		<input
			name="label"
			placeholder="Label (optional)"
			maxlength="40"
			aria-label="address label"
			class="w-36 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs transition-colors duration-100 placeholder:text-muted/70 hover:border-muted/60"
		/>
		<input
			name="address"
			placeholder="bc1…"
			required
			aria-label="bitcoin address"
			class="min-w-0 flex-1 basis-64 rounded-md border border-border bg-surface px-2.5 py-1.5 num text-xs transition-colors duration-100 placeholder:text-muted/70 hover:border-muted/60"
		/>
		<button
			type="submit"
			class="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-text"
		>
			Add address
		</button>
		{#if form?.addressError != null}
			<p role="alert" class="basis-full text-[11px] text-loss">{form.addressError}</p>
		{/if}
	</form>
</section>

<!-- Archive confirm dialog -->
{#if confirmArchive}
	{@const target = confirmArchive}
	<div class="fixed inset-0 z-50">
		<button
			type="button"
			class="absolute inset-0 bg-black/60"
			aria-label="Cancel archive"
			onclick={() => (confirmArchive = null)}
		></button>
		<div
			role="alertdialog"
			aria-modal="true"
			aria-label="confirm archive"
			class="absolute top-1/2 left-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-5"
		>
			<h2 class="text-sm font-medium">Archive "{target.name}"?</h2>
			<p class="mt-2 text-xs leading-relaxed text-muted">
				The card disappears but its history stays in the ledger — wallets with history can never be
				deleted. Archived wallets cannot receive new entries.
			</p>
			{#if form?.archiveError != null && form?.archiveId === target.id}
				<p role="alert" class="mt-2 text-xs text-loss">{form.archiveError}</p>
			{/if}
			<form
				method="POST"
				action="?/archiveWallet"
				class="mt-4 flex justify-end gap-2"
				use:enhance={() => {
					archiving = true;
					return async ({ result, update }) => {
						archiving = false;
						if (result.type === 'success') confirmArchive = null;
						await update({ reset: false });
					};
				}}
			>
				<input type="hidden" name="id" value={target.id} />
				<button
					type="button"
					onclick={() => (confirmArchive = null)}
					class="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors duration-100 hover:text-text"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={archiving}
					class="rounded-md bg-loss px-3 py-1.5 text-xs font-medium text-bg transition-opacity duration-100 hover:opacity-90 disabled:opacity-60"
				>
					{archiving ? 'Archiving…' : 'Archive'}
				</button>
			</form>
		</div>
	</div>
{/if}
