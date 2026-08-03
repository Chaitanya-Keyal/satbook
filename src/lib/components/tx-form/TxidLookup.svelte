<script lang="ts">
	// Txid paste box + autofill flow (spec §3.5). On a 64-hex paste it queries
	// /api/tx/{txid} (the server walks blockstream → emzy → mempool.space; the
	// progress line rotates host names on the same cadence), then renders the
	// found card: chain facts + output picker. Selections and chain facts are
	// reported up via callbacks; everything stays editable in the parent.
	import type { EsploraTxPayload } from '$lib/types';
	import { formatSats } from '$lib/utils/money';
	import { formatIstFull } from '$lib/utils/time';

	let {
		txid = $bindable(''),
		id = 'txid-paste',
		highlight = false,
		wallets,
		onchain,
		onpick
	}: {
		txid?: string;
		/** Input id — must be unique when two lookups render in one form. */
		id?: string;
		/** TRANSFER with empty txid — nudge per spec §3.4. */
		highlight?: boolean;
		wallets: { id: number; name: string }[];
		onchain: (data: { blockTime: number | null; feeSats: number; confirmed: boolean }) => void;
		onpick: (sel: { sats: number; walletId: number | null }) => void;
	} = $props();

	const HOST_LABELS = ['blockstream.info', 'mempool.emzy.de', 'mempool.space'];

	let status = $state<'idle' | 'loading' | 'found' | 'notfound' | 'error'>('idle');
	let data = $state<EsploraTxPayload | null>(null);
	let hostIdx = $state(0);
	let selected = $state<number[]>([]);
	let sumMode = $state(false);
	let seq = 0;
	let hostTimer: ReturnType<typeof setInterval> | undefined;

	const walletName = (id: number | null) =>
		id != null ? (wallets.find((w) => w.id === id)?.name ?? `wallet ${id}`) : null;

	function truncAddr(addr: string | null): string {
		if (!addr) return 'non-standard output';
		return addr.length > 20 ? `${addr.slice(0, 10)}…${addr.slice(-6)}` : addr;
	}

	// If the txid no longer matches what was fetched, drop the card.
	$effect(() => {
		const t = txid.trim().toLowerCase();
		if (data && t !== data.txid) {
			data = null;
			status = 'idle';
			selected = [];
			sumMode = false;
		}
	});

	function handleInput(e: Event) {
		txid = (e.currentTarget as HTMLInputElement).value;
		const t = txid.trim().toLowerCase();
		if (/^[0-9a-f]{64}$/.test(t) && t !== data?.txid) void lookup(t);
	}

	async function lookup(t: string) {
		const mySeq = ++seq;
		status = 'loading';
		data = null;
		selected = [];
		sumMode = false;
		hostIdx = 0;
		clearInterval(hostTimer);
		// server tries each host with a 4s timeout — rotate the label in step
		hostTimer = setInterval(() => {
			hostIdx = Math.min(hostIdx + 1, HOST_LABELS.length - 1);
		}, 4200);
		try {
			const res = await fetch(`/api/tx/${t}`);
			if (mySeq !== seq) return;
			if (res.status === 404) {
				status = 'notfound';
				return;
			}
			if (!res.ok) {
				status = 'error';
				return;
			}
			data = (await res.json()) as EsploraTxPayload;
			status = 'found';
			onchain({ blockTime: data.blockTime, feeSats: data.feeSats, confirmed: data.confirmed });
			const best = data.outputs.find((o) => o.isOwn);
			if (best) {
				selected = [best.index];
				emit();
			}
		} catch {
			if (mySeq === seq) status = 'error';
		} finally {
			if (mySeq === seq) clearInterval(hostTimer);
		}
	}

	function emit() {
		if (!data) return;
		const outs = data.outputs.filter((o) => selected.includes(o.index));
		if (outs.length === 0) return;
		const sats = outs.reduce((sum, o) => sum + o.valueSats, 0);
		const ownIds = [
			...new Set(outs.map((o) => o.ownWalletId).filter((id): id is number => id != null))
		];
		onpick({ sats, walletId: ownIds.length === 1 ? ownIds[0] : null });
	}

	function toggleOutput(index: number) {
		if (sumMode) {
			selected = selected.includes(index)
				? selected.filter((i) => i !== index)
				: [...selected, index];
		} else {
			selected = [index];
		}
		emit();
	}

	function toggleSumMode() {
		sumMode = !sumMode;
		if (!sumMode && selected.length > 1) {
			selected = [selected[0]];
			emit();
		}
	}
</script>

<div>
	<span class="flex items-center gap-1.5 text-[11px] font-medium text-muted">
		<label for={id}>Txid</label>
		{#if highlight}
			<span class="text-[10px] text-accent">Strongly encouraged for transfers</span>
		{/if}
	</span>
	<input
		{id}
		type="text"
		value={txid}
		placeholder="Paste txid to autofill…"
		autocomplete="off"
		spellcheck="false"
		class="mt-1 h-9 w-full rounded-md border bg-surface px-2.5 num text-[12px] transition-colors duration-100 placeholder:text-muted/50 hover:border-muted/50 {highlight
			? 'border-accent/50'
			: 'border-border'}"
		oninput={handleInput}
	/>

	{#if status === 'loading'}
		<p class="mt-1.5 text-xs derived" role="status">Looking up on {HOST_LABELS[hostIdx]}…</p>
	{:else if status === 'error'}
		<p class="mt-1.5 text-xs text-loss">Explorers unreachable — fill manually</p>
	{:else if status === 'notfound'}
		<p class="mt-1.5 text-xs text-loss">Transaction not found on explorers — fill manually</p>
	{:else if status === 'found' && data}
		<div class="mt-2 rounded-md border border-border bg-surface p-3">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1 num text-xs">
				<span class="rounded-full bg-surface-2 px-1.5 py-px text-[10px] derived">from chain</span>
				<span class={data.confirmed ? 'text-gain' : 'text-accent'}>
					{data.confirmed ? 'confirmed' : 'unconfirmed'}
				</span>
				{#if data.blockTime != null}
					<span class="text-muted">{formatIstFull(data.blockTime)}</span>
				{/if}
				<span class="text-muted">fee {formatSats(data.feeSats)} sats</span>
				<span class="ml-auto text-[10px] text-muted">via {data.host}</span>
			</div>

			<div class="mt-3 flex items-center justify-between gap-2">
				<span class="label-caps" id="{id}-outputs-label">outputs</span>
				<label class="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
					<input
						type="checkbox"
						checked={sumMode}
						onchange={toggleSumMode}
						class="size-3 accent-accent"
					/>
					Sum multiple outputs
				</label>
			</div>
			<ul class="mt-1 divide-y divide-border/60" role="group" aria-labelledby="{id}-outputs-label">
				{#each data.outputs as o (o.index)}
					<li>
						<label
							class="flex min-h-12 cursor-pointer items-center gap-3 px-1 py-1.5 transition-colors duration-100 hover:bg-surface-2"
						>
							<input
								type={sumMode ? 'checkbox' : 'radio'}
								name="{id}-out"
								checked={selected.includes(o.index)}
								onchange={() => toggleOutput(o.index)}
								class="size-3.5 shrink-0 accent-accent"
							/>
							<span class="num text-xs text-muted">#{o.index}</span>
							<span
								class="min-w-0 flex-1 truncate num text-xs text-muted"
								title={o.address ?? undefined}
							>
								{truncAddr(o.address)}
							</span>
							{#if o.isOwn}
								<span
									class="shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-[10px] text-accent"
								>
									{walletName(o.ownWalletId)}
								</span>
							{/if}
							<span class="shrink-0 num text-xs">{formatSats(o.valueSats)} sats</span>
						</label>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
