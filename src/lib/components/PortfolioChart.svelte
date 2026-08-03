<script lang="ts">
	// Hand-rolled SVG chart — portfolio value vs net invested (spec §2, §7).
	// Self-contained: no props, fetches /api/chart itself; dashboard mount is
	// unchanged. All amounts are integer paise; formatting happens at render.
	import type { ChartPayload } from '$lib/types';
	import { niceYDomain, timeTicks, valueSegments } from '$lib/utils/chart';
	import { formatInr, formatInrCompact } from '$lib/utils/money';
	import { formatIstDateShort } from '$lib/utils/time';
	import { fyOf, fyRange } from '$lib/utils/fy';

	const MINUS = '−';
	const DAY = 86400;
	const MAX_BACKFILL_TRIES = 12;
	const uid = Math.random().toString(36).slice(2, 8);

	// --- data ----------------------------------------------------------------

	let payload = $state<ChartPayload | null>(null);
	let failed = $state(false);
	let tries = 0; // backfill re-fetches consumed (not reactive on purpose)
	let gaveUp = $state(false);
	let pollNonce = $state(0);

	async function load() {
		failed = false;
		payload = null;
		gaveUp = false;
		tries = 0;
		try {
			const res = await fetch('/api/chart');
			if (!res.ok) throw new Error(String(res.status));
			payload = (await res.json()) as ChartPayload;
		} catch {
			failed = true;
		}
	}

	$effect(() => {
		void load();
	});

	// While candles backfill: keep the frame, re-fetch every 5s, cap at ~12
	// tries then settle on "some history unavailable".
	$effect(() => {
		void pollNonce;
		if (!payload?.backfilling || gaveUp || failed) return;
		const t = setTimeout(async () => {
			if (tries >= MAX_BACKFILL_TRIES) {
				gaveUp = true;
				return;
			}
			tries += 1;
			try {
				const res = await fetch('/api/chart');
				if (res.ok) payload = (await res.json()) as ChartPayload;
			} catch {
				// keep the current frame; next tick retries
			}
			pollNonce += 1;
		}, 5000);
		return () => clearTimeout(t);
	});

	// --- range chips ---------------------------------------------------------

	const RANGES = ['1M', '3M', '6M', '1Y', 'FY', 'All'] as const;
	type Range = (typeof RANGES)[number];
	let range = $state<Range>('All');

	function setRange(r: Range) {
		range = r;
		hover = null;
	}

	const pts = $derived(
		(payload?.points ?? []).map((p) => ({
			...p,
			ts: Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10)) / 1000
		}))
	);

	const cutoff = $derived.by(() => {
		if (range === 'All' || pts.length === 0) return -Infinity;
		const last = pts[pts.length - 1].ts;
		if (range === 'FY') return fyRange(fyOf(last)).startTs;
		const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[range];
		const d = new Date(last * 1000);
		d.setUTCMonth(d.getUTCMonth() - months);
		return d.getTime() / 1000;
	});

	const filtered = $derived(pts.filter((p) => p.ts >= cutoff));

	// --- geometry ------------------------------------------------------------

	let plotW = $state(0);
	let plotH = $state(0);
	let svgEl: SVGSVGElement | undefined = $state();

	const PAD = { t: 12, r: 12, b: 22, l: 52 };

	const geom = $derived.by(() => {
		const n = filtered.length;
		if (plotW < 80 || plotH < 80 || n === 0) return null;
		let min = Infinity;
		let max = -Infinity;
		for (const p of filtered) {
			if (p.investedMinor < min) min = p.investedMinor;
			if (p.investedMinor > max) max = p.investedMinor;
			if (p.valueMinor != null) {
				if (p.valueMinor < min) min = p.valueMinor;
				if (p.valueMinor > max) max = p.valueMinor;
			}
		}
		const yd = niceYDomain(min, max);
		const t0 = filtered[0].ts;
		const t1 = n > 1 ? filtered[n - 1].ts : t0 + DAY;
		const iw = plotW - PAD.l - PAD.r;
		const ih = plotH - PAD.t - PAD.b;
		const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * iw;
		const y = (v: number) => PAD.t + (1 - (v - yd.lo) / (yd.hi - yd.lo)) * ih;
		return { t0, t1, x, y, yd, bottom: PAD.t + ih };
	});

	const r2 = (v: number) => Math.round(v * 100) / 100;

	const paths = $derived.by(() => {
		const g = geom;
		if (!g) return null;
		const n = filtered.length;

		// value line + gradient area + "above the value line" mask (per segment;
		// gaps stay unmasked-black so the wash never paints across missing candles)
		let line = '';
		let area = '';
		let maskAbove = '';
		for (const [s, e] of valueSegments(filtered)) {
			const xs = r2(g.x(filtered[s].ts));
			const ys = r2(g.y(filtered[s].valueMinor!));
			if (e === s) {
				line += `M${r2(xs - 0.5)} ${ys}L${r2(xs + 0.5)} ${ys}`;
				continue;
			}
			let d = `M${xs} ${ys}`;
			for (let i = s + 1; i <= e; i++)
				d += `L${r2(g.x(filtered[i].ts))} ${r2(g.y(filtered[i].valueMinor!))}`;
			line += d;
			const xe = r2(g.x(filtered[e].ts));
			area += `${d}V${r2(g.bottom)}H${xs}Z`;
			let rev = '';
			for (let i = e; i >= s; i--)
				rev += `L${r2(g.x(filtered[i].ts))} ${r2(g.y(filtered[i].valueMinor!))}`;
			maskAbove += `M${xs} 0H${xe}${rev}Z`;
		}

		// net invested: step-after
		const x0 = r2(g.x(filtered[0].ts));
		const y0 = r2(g.y(filtered[0].investedMinor));
		let inv = `M${x0} ${y0}`;
		for (let i = 1; i < n; i++)
			inv += `H${r2(g.x(filtered[i].ts))}V${r2(g.y(filtered[i].investedMinor))}`;
		if (n === 1) inv += `H${r2(x0 + 0.5)}`;

		// area under the invested step (red drawdown wash, masked to value<invested)
		const invArea = maskAbove
			? `${inv.replace('M', `M${x0} ${r2(g.bottom)}L`)}V${r2(g.bottom)}Z`
			: '';

		return { line, area, maskAbove, inv, invArea };
	});

	const yTicks = $derived(geom ? geom.yd.ticks : []);
	const xTicks = $derived.by(() => {
		const g = geom;
		if (!g) return [];
		return timeTicks(g.t0, g.t1)
			.map((t) => ({ ...t, x: g.x(t.ts) }))
			.filter((t) => t.x >= PAD.l && t.x <= plotW - 24);
	});

	const zeroY = $derived(geom && geom.yd.lo <= 0 && 0 <= geom.yd.hi ? geom.y(0) : null);

	// break-even level = current net invested (last point of the FULL series)
	const breakEven = $derived.by(() => {
		const g = geom;
		if (!g || pts.length === 0) return null;
		const be = pts[pts.length - 1].investedMinor;
		if (be <= 0 || be <= g.yd.lo || be >= g.yd.hi) return null;
		return { v: be, y: g.y(be) };
	});

	// --- crosshair + tooltip -------------------------------------------------

	let hover = $state<number | null>(null);

	function pointAt(clientX: number): number | null {
		const g = geom;
		if (!g || !svgEl) return null;
		const n = filtered.length;
		if (n === 1) return 0;
		const px = clientX - svgEl.getBoundingClientRect().left;
		const frac = (px - PAD.l) / (plotW - PAD.l - PAD.r);
		return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
	}

	function onPointer(e: PointerEvent) {
		hover = pointAt(e.clientX);
	}

	function onKeydown(e: KeyboardEvent) {
		if (filtered.length === 0) return;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			const cur = hover ?? filtered.length - 1;
			const next = cur + (e.key === 'ArrowRight' ? 1 : -1);
			hover = Math.max(0, Math.min(filtered.length - 1, next));
		} else if (e.key === 'Escape') {
			hover = null;
		}
	}

	const TIP_W = 176; // w-44

	const tip = $derived.by(() => {
		const g = geom;
		if (!g || hover == null) return null;
		const p = filtered[hover];
		if (!p) return null;
		const pl = p.valueMinor != null ? p.valueMinor - p.investedMinor : null;
		const pct = pl != null && p.investedMinor > 0 ? (pl / p.investedMinor) * 100 : null;
		const cx = g.x(p.ts);
		const raw = cx > plotW / 2 ? cx - 10 - TIP_W : cx + 10;
		return {
			p,
			cx,
			vy: p.valueMinor != null ? g.y(p.valueMinor) : null,
			iy: g.y(p.investedMinor),
			pl,
			pct,
			left: Math.max(4, Math.min(raw, plotW - TIP_W - 4))
		};
	});

	// --- status note ---------------------------------------------------------

	const note = $derived.by(() => {
		if (!payload || payload.points.length === 0) return null;
		if (payload.backfilling) return gaveUp ? 'Some history unavailable' : 'Price history loading…';
		if (payload.points.every((p) => p.valueMinor == null)) return 'Price history unavailable';
		return null;
	});
</script>

<section
	class="relative flex h-[300px] flex-col rounded-md border border-border bg-surface p-4 sm:h-[340px] lg:h-full lg:min-h-[340px]"
	aria-label="portfolio value vs invested chart"
>
	<header class="flex flex-wrap items-center gap-x-4 gap-y-2">
		<h2 class="label-caps">portfolio value vs invested</h2>
		{#if payload !== null && payload.points.length > 0}
			<div class="flex items-center gap-3" aria-hidden="true">
				<span class="flex items-center gap-1.5 text-[10px] text-muted">
					<span class="h-0 w-3.5 border-t-2 border-accent"></span>
					value
				</span>
				<span class="flex items-center gap-1.5 text-[10px] text-muted">
					<span class="h-0 w-3.5" style="border-top: 1.5px dashed var(--color-muted)"></span>
					invested
				</span>
			</div>
			{#if note}
				<span class="num text-[10px] text-muted {note.endsWith('…') ? 'animate-pulse' : ''}">
					{note}
				</span>
			{/if}
			<div
				class="ml-auto flex rounded-md border border-border p-0.5"
				role="group"
				aria-label="chart range"
			>
				{#each RANGES as r (r)}
					<button
						type="button"
						class="rounded-[4px] px-1.5 py-0.5 num text-[11px] transition-colors duration-100 {range ===
						r
							? 'bg-surface-2 text-text'
							: 'text-muted hover:text-text'}"
						aria-pressed={range === r}
						onclick={() => setRange(r)}
					>
						{r}
					</button>
				{/each}
			</div>
		{/if}
	</header>

	<div class="relative mt-2 min-h-0 flex-1" bind:clientWidth={plotW} bind:clientHeight={plotH}>
		{#if failed}
			<div class="flex h-full flex-col items-center justify-center gap-2">
				<p class="num text-xs text-muted">Chart data failed to load</p>
				<button
					type="button"
					class="rounded-md border border-border px-2.5 py-1 num text-xs text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-text"
					onclick={load}
				>
					Retry
				</button>
			</div>
		{:else if payload === null}
			<div class="h-full w-full skeleton" aria-hidden="true"></div>
			<p class="sr-only">chart loading</p>
		{:else if payload.points.length === 0}
			<p class="flex h-full flex-wrap items-center justify-center gap-x-1 num text-xs text-muted">
				— No entries — press <kbd class="rounded border border-border bg-surface-2 px-1">n</kbd> to
				add, or
				<a class="underline transition-colors duration-100 hover:text-text" href="/settings">
					import your sheet in Settings
				</a>
			</p>
		{:else if geom && paths}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<svg
				bind:this={svgEl}
				class="block h-full w-full"
				viewBox="0 0 {plotW} {plotH}"
				role="img"
				aria-label="portfolio value vs net invested, {filtered.length} days — hover or use arrow keys to read values"
				tabindex="0"
				style="touch-action: pan-y"
				onpointermove={onPointer}
				onpointerdown={onPointer}
				onpointerleave={() => (hover = null)}
				onpointercancel={() => (hover = null)}
				onkeydown={onKeydown}
				onblur={() => (hover = null)}
			>
				<defs>
					<linearGradient id="grad-{uid}" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stop-color="var(--color-accent)" stop-opacity="0.08" />
						<stop offset="1" stop-color="var(--color-accent)" stop-opacity="0" />
					</linearGradient>
					{#if paths.maskAbove}
						<mask
							id="wash-{uid}"
							maskUnits="userSpaceOnUse"
							x="0"
							y="0"
							width={plotW}
							height={plotH}
						>
							<path d={paths.maskAbove} fill="white" />
						</mask>
					{/if}
				</defs>

				<!-- fills -->
				{#if paths.area}
					<path class="fade" d={paths.area} fill="url(#grad-{uid})" />
				{/if}
				{#if paths.invArea}
					<path
						class="fade"
						d={paths.invArea}
						fill="var(--color-loss)"
						fill-opacity="0.07"
						mask="url(#wash-{uid})"
					/>
				{/if}

				<!-- hairlines: zero + current break-even only -->
				{#if zeroY != null}
					<line x1={PAD.l} x2={plotW - PAD.r} y1={zeroY} y2={zeroY} stroke="var(--color-border)" />
				{/if}
				{#if breakEven}
					<line
						x1={PAD.l}
						x2={plotW - PAD.r}
						y1={breakEven.y}
						y2={breakEven.y}
						stroke="var(--color-border)"
					/>
					<text x={plotW - PAD.r} y={breakEven.y - 4} text-anchor="end" font-size="10">
						break-even {formatInrCompact(breakEven.v)}
					</text>
				{/if}

				<!-- axes: labels only, mono 11px muted -->
				{#each yTicks as v (v)}
					<text x={PAD.l - 8} y={geom.y(v) + 3.5} text-anchor="end" font-size="11">
						{formatInrCompact(v)}
					</text>
				{/each}
				{#each xTicks as t (t.ts)}
					<text x={t.x} y={plotH - 6} text-anchor="middle" font-size="11">{t.label}</text>
				{/each}

				<!-- series -->
				<path
					class="fade"
					d={paths.inv}
					fill="none"
					stroke="var(--color-muted)"
					stroke-width="1.5"
					stroke-dasharray="4 3"
					opacity="0.9"
				/>
				<path
					class="draw"
					d={paths.line}
					pathLength="1"
					fill="none"
					stroke="var(--color-accent)"
					stroke-width="2"
					stroke-linejoin="round"
					stroke-linecap="round"
				/>

				<!-- crosshair -->
				{#if tip}
					<line
						x1={tip.cx}
						x2={tip.cx}
						y1={PAD.t}
						y2={geom.bottom}
						stroke="var(--color-muted)"
						stroke-opacity="0.35"
					/>
					<circle
						cx={tip.cx}
						cy={tip.iy}
						r="2.5"
						fill="var(--color-muted)"
						stroke="var(--color-surface)"
						stroke-width="1.5"
					/>
					{#if tip.vy != null}
						<circle
							cx={tip.cx}
							cy={tip.vy}
							r="3"
							fill="var(--color-accent)"
							stroke="var(--color-surface)"
							stroke-width="1.5"
						/>
					{/if}
				{/if}
			</svg>

			<!-- tooltip card — same surface/hairline tokens as everything else -->
			{#if tip}
				<div
					class="pointer-events-none absolute top-2 z-10 w-44 rounded-md border border-border bg-surface px-3 py-2"
					style="left: {r2(tip.left)}px"
				>
					<p class="num text-[11px] text-muted">{formatIstDateShort(tip.p.ts)}</p>
					<dl class="mt-1.5 space-y-1 num text-xs">
						<div class="flex items-center justify-between gap-4">
							<dt class="flex items-center gap-1.5 text-muted">
								<span class="h-0 w-3 border-t-2 border-accent"></span>
								value
							</dt>
							<dd>{tip.p.valueMinor != null ? formatInr(tip.p.valueMinor) : '—'}</dd>
						</div>
						<div class="flex items-center justify-between gap-4">
							<dt class="flex items-center gap-1.5 text-muted">
								<span class="h-0 w-3" style="border-top: 1.5px dashed var(--color-muted)"></span>
								invested
							</dt>
							<dd>{formatInr(tip.p.investedMinor)}</dd>
						</div>
						<div class="flex items-center justify-between gap-4">
							<dt class="text-muted">p/l</dt>
							<dd
								class={tip.pl == null
									? 'text-muted'
									: tip.pl > 0
										? 'text-gain'
										: tip.pl < 0
											? 'text-loss'
											: ''}
							>
								{#if tip.pl == null}
									—
								{:else}
									{formatInr(tip.pl, { explicitPlus: true })}{#if tip.pct != null}
										· {tip.pct >= 0 ? '+' : MINUS}{Math.abs(tip.pct).toFixed(1)}%{/if}
								{/if}
							</dd>
						</div>
					</dl>
				</div>
			{/if}
		{/if}
	</div>
</section>

<style>
	svg text {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums lining-nums;
		fill: var(--color-muted);
		user-select: none;
	}

	/* 300ms draw-in entrance; the global reduced-motion rule zeroes it out. */
	@media (prefers-reduced-motion: no-preference) {
		.draw {
			stroke-dasharray: 1;
			stroke-dashoffset: 1;
			animation: draw-in 300ms ease-out forwards;
		}
		.fade {
			animation: fade-in 300ms ease-out backwards;
			animation-delay: 100ms;
		}
	}

	@keyframes draw-in {
		to {
			stroke-dashoffset: 0;
		}
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}
	}
</style>
