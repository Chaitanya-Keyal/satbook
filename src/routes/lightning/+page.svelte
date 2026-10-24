<script lang="ts">
	import { enhance } from '$app/forms';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Tile from '$lib/components/Tile.svelte';
	import { unit } from '$lib/stores/unit.svelte';
	import { formatAmount, signedAmount } from '$lib/utils/display';
	import { paymentLabel, pct, shortNpub } from '$lib/utils/lightning';
	import { formatInr, formatSats, mulDivRound, SATS_PER_BTC } from '$lib/utils/money';
	import { formatIstDateShort, formatIstFull, formatRelative } from '$lib/utils/time';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Payment = Extract<PageData, { configured: true }>['stored'][number];

	const EM = '—';
	let syncing = $state(false);
	let copied = $state(false);

	const inr = (sats: number) =>
		data.configured && data.btcInr != null
			? formatInr(mulDivRound(Math.round(data.btcInr * 100), sats, SATS_PER_BTC))
			: null;

	/** Paired liquidity purchases ride on the payment that triggered them. */
	const visible = (ps: Payment[]) => ps.filter((p) => p.review !== 'paired');

	async function copyAddress(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard unavailable — the address is selectable text anyway */
		}
	}
</script>

<svelte:head><title>Lightning · satbook</title></svelte:head>

{#snippet who(p: Payment)}
	{#if p.zap}
		<span
			title={p.zap.verified
				? 'Zap request signature verified'
				: 'Unverified: anyone can claim a sender'}
		>
			{#if p.zap.verified}<ShieldCheck
					size={11}
					class="mr-0.5 inline-block align-[-1px] text-gain"
					aria-label="verified"
				/>{/if}zap · <span class="num">{shortNpub(p.zap.npub)}</span>{#if !p.zap.verified}<span
					class="ml-1 text-muted">(unverified)</span
				>{/if}</span
		>{#if p.zap.content}<span class="mx-1.5 text-muted">·</span>{p.zap.content}{/if}
	{:else if p.comment}
		{p.comment}
	{:else if p.note}
		{p.note}
	{:else if p.memo}
		<span class="text-muted">{p.memo}</span>
	{:else}
		<span class="text-muted">{EM}</span>
	{/if}
{/snippet}

{#snippet ledgerCell(p: Payment)}
	{#if p.txIdInLedger != null}
		<a href="/tx#tx-{p.txIdInLedger}" class="text-muted underline hover:text-text"
			>#{p.txIdInLedger}</a
		>
	{:else if p.review === 'ignored'}
		<span class="text-muted">ignored</span>
	{:else}
		<span class="text-muted">not recorded</span>
	{/if}
{/snippet}

{#snippet activity(payments: Payment[])}
	{@const rows = visible(payments)}
	{#if rows.length === 0}
		<p class="mt-3 num text-xs text-muted">— No payments yet —</p>
	{:else}
		<!-- desktop -->
		<div class="mt-2 hidden overflow-x-auto md:block">
			<table class="w-full border-collapse text-xs">
				<thead>
					<tr class="border-b border-border">
						<th class="py-2 pr-4 text-left label-caps font-medium">when</th>
						<th class="py-2 pr-4 text-left label-caps font-medium">what</th>
						<th class="py-2 pr-4 text-left label-caps font-medium">details</th>
						<th class="py-2 pr-4 text-right label-caps font-medium">amount</th>
						<th class="py-2 pr-4 text-right label-caps font-medium">fee</th>
						<th class="py-2 text-left label-caps font-medium">ledger</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as p (p.key)}
						{@const amt = signedAmount(
							p.direction === 'in' ? p.amountSat : -p.amountSat,
							unit.value
						)}
						<tr class="border-b border-border/60 last:border-0">
							<td class="py-2 pr-4 num whitespace-nowrap" title={formatIstFull(p.completedAt)}>
								{formatIstDateShort(p.completedAt)}
							</td>
							<td class="py-2 pr-4 whitespace-nowrap">
								{paymentLabel(p.direction, p.subType)}
								{#if p.direction === 'in' && p.feeSat > 0}
									<span class="block text-[11px] text-muted">bought inbound liquidity</span>
								{/if}
							</td>
							<td class="max-w-[320px] truncate py-2 pr-4">{@render who(p)}</td>
							<td class="py-2 pr-4 text-right num whitespace-nowrap {amt.cls}">
								{amt.text}
								{#if p.direction === 'in' && p.feeSat > 0 && p.requestedSat != null}
									<span class="block text-[11px] text-muted">
										payer sent {formatSats(p.requestedSat)}
									</span>
								{/if}
							</td>
							<td class="py-2 pr-4 text-right num whitespace-nowrap text-muted">
								{p.feeSat > 0 ? `${formatSats(p.feeSat)} sats` : EM}
							</td>
							<td class="py-2 num whitespace-nowrap">{@render ledgerCell(p)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<!-- mobile -->
		<ul class="mt-2 divide-y divide-border/60 md:hidden">
			{#each rows as p (p.key)}
				{@const amt = signedAmount(p.direction === 'in' ? p.amountSat : -p.amountSat, unit.value)}
				<li class="py-2.5 text-xs">
					<div class="flex items-baseline justify-between gap-3">
						<span>{paymentLabel(p.direction, p.subType)}</span>
						<span class="num {amt.cls}">{amt.text}</span>
					</div>
					<div class="mt-0.5 truncate text-muted">{@render who(p)}</div>
					<div class="mt-0.5 flex justify-between gap-3 num text-[11px] text-muted">
						<span>
							{formatIstDateShort(p.completedAt)}{p.feeSat > 0
								? ` · fee ${formatSats(p.feeSat)}`
								: ''}
						</span>
						<span>{@render ledgerCell(p)}</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<div class="flex flex-wrap items-baseline justify-between gap-3">
	<h1 class="label-caps">lightning</h1>
	{#if data.configured}
		<form
			method="POST"
			action="?/sync"
			use:enhance={() => {
				syncing = true;
				return async ({ update }) => {
					await update({ reset: false });
					syncing = false;
				};
			}}
		>
			<button
				type="submit"
				disabled={syncing}
				class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted transition-colors duration-100 hover:text-text disabled:opacity-60"
			>
				<RefreshCw size={12} class={syncing ? 'animate-spin' : ''} aria-hidden="true" />
				{syncing ? 'Syncing…' : 'Sync now'}
			</button>
		</form>
	{/if}
</div>

{#if !data.configured}
	<div class="mt-3 rounded-md border border-loss/40 bg-surface p-4 text-xs leading-relaxed">
		<p class="flex items-center gap-1.5 text-loss">
			<TriangleAlert size={13} aria-hidden="true" /> The Lightning module is misconfigured
		</p>
		<p class="mt-1.5 text-muted">{data.problem}. See docs/lightning.md for the settings.</p>
	</div>
{:else}
	{#if form?.syncError}
		<p role="alert" class="mt-2 text-xs text-loss">Sync failed: {form.syncError}</p>
	{:else if form?.synced}
		<p class="mt-2 text-xs text-muted">
			Synced{form.added ? ` — ${form.added} new payment${form.added === 1 ? '' : 's'}` : ''}.
			{#if form.warning}<span class="text-loss">{form.warning}</span>{/if}
		</p>
	{/if}

	{#if !data.wallet}
		<div class="mt-3 rounded-md border border-border bg-surface p-3 text-xs text-muted">
			No wallet stands for this node yet, so nothing can be checked against the ledger.
			<a href="/settings#lightning" class="text-text underline">Choose or create one in Settings</a
			>.
		</div>
	{/if}

	{#await data.live}
		<div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
			{#each [0, 1, 2, 3] as i (i)}
				<div class="h-[92px] skeleton rounded-md border border-border bg-surface"></div>
			{/each}
		</div>
		<section class="mt-8" aria-label="activity">
			<h2 class="label-caps">activity</h2>
			{@render activity(data.stored)}
		</section>
	{:then live}
		{#if 'failed' in live}
			<p role="alert" class="mt-3 text-xs text-loss">Could not load the node: {live.failed}</p>
		{:else}
			{#if !live.status.ok}
				<div class="mt-3 rounded-md border border-loss/40 bg-surface p-3 text-xs">
					<span class="text-loss">The node is unavailable:</span>
					<span class="text-muted">{live.status.error}.</span>
					{#if data.lastSync}
						<span class="text-muted">
							Showing payments as of {formatRelative(data.lastSync.at, data.now)}.
						</span>
					{/if}
				</div>
			{:else}
				{@const s = live.status.status}
				{#if !s.mainnet}
					<div class="mt-3 rounded-md border border-border bg-surface-2 p-3 text-xs">
						<span class="font-medium">Test network ({s.info.chain}).</span>
						<span class="text-muted"
							>These are test sats with no value; keep them out of the ledger.</span
						>
					</div>
				{/if}

				<div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<Tile label="balance" value={formatAmount(s.balance.balanceSat, unit.value)}>
						{#snippet subline()}
							{inr(s.balance.balanceSat) ?? EM}
							{#if s.balance.feeCreditSat > 0}
								<span class="block">+ {formatSats(s.balance.feeCreditSat)} sats fee credit</span>
							{/if}
							{#if s.balance.swapInSat > 0}
								<span class="block">{formatSats(s.balance.swapInSat)} sats arriving on-chain</span>
							{/if}
						{/snippet}
					</Tile>
					<Tile label="receivable" value={formatAmount(s.channels.inboundSat, unit.value)}>
						{#snippet subline()}
							before the next liquidity purchase
						{/snippet}
					</Tile>
					<Tile
						label="next top-up"
						value={s.topUpFee
							? `${formatSats(s.topUpFee.miningFeeSat + s.topUpFee.serviceFeeSat)} sats`
							: EM}
					>
						{#snippet subline()}
							{#if s.topUpFee}
								{formatSats(s.topUpFee.serviceFeeSat)} service + {formatSats(
									s.topUpFee.miningFeeSat
								)} mining, for {formatSats(data.topUpSat)} sats of inbound
							{:else}
								no quote from the node
							{/if}
						{/snippet}
					</Tile>
					{#if data.wallet && live.ledgerSats != null}
						{@const nodeSats = s.balance.balanceSat + s.balance.feeCreditSat}
						{@const diff = live.ledgerSats - nodeSats}
						<Tile
							label="ledger · {data.wallet.name}"
							value={formatAmount(live.ledgerSats, unit.value)}
							valueClass={diff === 0 ? '' : 'text-loss'}
						>
							{#snippet subline()}
								{#if diff === 0}
									<span class="inline-flex items-center gap-1 text-gain">
										<Check size={11} aria-hidden="true" /> matches the node
									</span>
								{:else}
									{diff > 0
										? `${formatSats(diff)} sats more than`
										: `${formatSats(-diff)} sats less than`}
									the node{s.balance.feeCreditSat > 0 ? ' (balance + fee credit)' : ''}
								{/if}
							{/snippet}
						</Tile>
					{:else}
						<Tile label="channels" value={String(s.channels.count)}>
							{#snippet subline()}
								{s.info.version} · block {s.info.blockHeight}
							{/snippet}
						</Tile>
					{/if}
				</div>

				{#if s.channels.capacitySat > 0}
					<div class="mt-3 rounded-md border border-border bg-surface p-4">
						<div class="flex justify-between gap-3 text-[11px] text-muted">
							<span>yours · {formatAmount(s.channels.balanceSat, unit.value)}</span>
							<span>receivable · {formatAmount(s.channels.inboundSat, unit.value)}</span>
						</div>
						<div
							class="mt-1.5 flex h-2 overflow-hidden rounded-full bg-surface-2"
							role="img"
							aria-label="channel capacity: {formatSats(
								s.channels.balanceSat
							)} sats yours, {formatSats(s.channels.inboundSat)} sats receivable"
						>
							<div
								class="bg-accent"
								style:width={pct(s.channels.balanceSat, s.channels.capacitySat)}
							></div>
						</div>
						<p class="mt-1.5 num text-[11px] text-muted">
							{s.channels.count} channel{s.channels.count === 1 ? '' : 's'} · capacity
							{formatAmount(s.channels.capacitySat, unit.value)} · phoenixd {s.info.version}
						</p>
					</div>
				{/if}
			{/if}

			{#if live.sync.warning}
				<p class="mt-2 text-xs text-muted">
					{live.sync.warning}; comments and zaps may be missing.
				</p>
			{/if}

			<section class="mt-8" aria-label="activity">
				<div class="flex items-baseline justify-between gap-3">
					<h2 class="label-caps">activity</h2>
					{#if live.sync.ok}
						<span class="num text-[11px] text-muted"
							>synced {formatRelative(live.sync.at, data.now)}</span
						>
					{:else}
						<span class="text-[11px] text-loss">last sync failed: {live.sync.error}</span>
					{/if}
				</div>
				{@render activity(live.payments.length ? live.payments : data.stored)}
			</section>
		{/if}
	{/await}

	{#if data.address}
		<section class="mt-8" aria-label="lightning address">
			<h2 class="label-caps">lightning address</h2>
			<div
				class="mt-2 flex flex-wrap items-center gap-4 rounded-md border border-border bg-surface p-4"
			>
				<div class="size-32 shrink-0 overflow-hidden rounded bg-white p-1">
					<!-- an SVG rendered on the server from the configured address, never from payer input -->
					{@html data.address.qr}
				</div>
				<div class="min-w-0">
					<p class="num text-sm break-all">{data.address.text}</p>
					<button
						type="button"
						onclick={() => copyAddress(data.address!.text)}
						class="mt-2 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:text-text"
					>
						{#if copied}<Check size={11} aria-hidden="true" /> Copied{:else}<Copy
								size={11}
								aria-hidden="true"
							/> Copy{/if}
					</button>
					<p class="mt-2 text-[11px] text-muted">
						Payments to it {data.lnbits
							? 'arrive through LNbits, with their comments and zaps'
							: 'arrive at this node'}.
					</p>
				</div>
			</div>
		</section>
	{/if}
{/if}
