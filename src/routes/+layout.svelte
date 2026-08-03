<script lang="ts">
	import '@fontsource-variable/jetbrains-mono';
	import '@fontsource-variable/inter';
	import './layout.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import List from '@lucide/svelte/icons/list';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Percent from '@lucide/svelte/icons/percent';
	import Plus from '@lucide/svelte/icons/plus';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import Wallet from '@lucide/svelte/icons/wallet';
	import favicon from '$lib/assets/favicon.svg';
	import { setUnitValue, toggleUnit, unit } from '$lib/stores/unit.svelte';
	import type { LivePricePayload } from '$lib/types';
	import { formatUsd } from '$lib/utils/display';
	import { formatInrCompact, formatRateInr } from '$lib/utils/money';
	import { formatRelative } from '$lib/utils/time';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	// Hydrate the global unit store once from the server-persisted setting —
	// deliberately non-reactive: later flips are client-driven via setUnitValue.
	// svelte-ignore state_referenced_locally
	unit.value = data.unit;

	const isLogin = $derived(page.url.pathname === '/login');
	const pathname = $derived(page.url.pathname);

	// --- live price ticker (poll every 5 min while visible) -----------------

	const POLL_MS = 5 * 60_000;
	let price = $state<LivePricePayload | null>(null);
	let priceError = $state(false);
	let now = $state(Math.floor(Date.now() / 1000));
	let lastFetch = 0;

	async function fetchPrice() {
		lastFetch = Date.now();
		try {
			const res = await fetch('/api/price');
			if (!res.ok) throw new Error(String(res.status));
			price = (await res.json()) as LivePricePayload;
			priceError = false;
		} catch {
			priceError = true;
		}
		now = Math.floor(Date.now() / 1000);
	}

	$effect(() => {
		if (isLogin) return;
		void fetchPrice();
		const poll = setInterval(() => {
			if (document.visibilityState === 'visible') void fetchPrice();
		}, POLL_MS);
		const tick = setInterval(() => (now = Math.floor(Date.now() / 1000)), 30_000);
		const onVis = () => {
			if (document.visibilityState === 'visible' && Date.now() - lastFetch > POLL_MS)
				void fetchPrice();
		};
		document.addEventListener('visibilitychange', onVis);
		return () => {
			clearInterval(poll);
			clearInterval(tick);
			document.removeEventListener('visibilitychange', onVis);
		};
	});

	const priceAge = $derived(price ? Math.max(0, now - price.fetchedAt) : null);
	const priceStatus = $derived<'green' | 'amber' | 'red'>(
		price === null || priceError || price.stale || priceAge! >= 1800
			? 'red'
			: priceAge! >= 600
				? 'amber'
				: 'green'
	);
	const DOT: Record<'green' | 'amber' | 'red', string> = {
		green: 'bg-gain',
		amber: 'bg-accent',
		red: 'bg-loss'
	};

	// --- global keyboard map -------------------------------------------------

	let pendingG = false;
	let gTimer: ReturnType<typeof setTimeout> | undefined;
	let cheatsheetOpen = $state(false);

	const GOTO: Record<string, string> = { d: '/', t: '/tx', w: '/wallets', x: '/tax' };

	function isEditable(el: EventTarget | null): boolean {
		return (
			el instanceof HTMLInputElement ||
			el instanceof HTMLTextAreaElement ||
			el instanceof HTMLSelectElement ||
			(el instanceof HTMLElement && el.isContentEditable)
		);
	}

	function onKeydown(e: KeyboardEvent) {
		if (isLogin) return;
		if (e.key === 'Escape') {
			if (cheatsheetOpen) {
				e.preventDefault();
				cheatsheetOpen = false;
			}
			return; // Esc always passes through to screens/inputs otherwise
		}
		if (isEditable(e.target)) return; // shortcuts suppressed in inputs (Cmd+Enter is the form's)
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		// Never navigate underneath an open dialog/confirm overlay.
		if (
			document.querySelector('dialog[open]') != null ||
			(e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"]'))
		)
			return;

		if (pendingG) {
			pendingG = false;
			clearTimeout(gTimer);
			const target = GOTO[e.key.toLowerCase()];
			if (target) {
				e.preventDefault();
				void goto(target);
			}
			return;
		}

		switch (e.key) {
			case 'n':
				e.preventDefault();
				void goto('/tx/new');
				break;
			case 'g':
				pendingG = true;
				gTimer = setTimeout(() => (pendingG = false), 800);
				break;
			case 'u':
				e.preventDefault();
				toggleUnit();
				break;
			case '?':
				e.preventDefault();
				cheatsheetOpen = !cheatsheetOpen;
				break;
			case '/':
				if (pathname.startsWith('/tx')) {
					e.preventDefault();
					window.dispatchEvent(new CustomEvent('ledger-search-focus'));
				}
				break;
		}
	}

	// --- nav -----------------------------------------------------------------

	const NAV = [
		{ href: '/', label: 'Dashboard', icon: LayoutDashboard, match: (p: string) => p === '/' },
		{
			href: '/tx',
			label: 'Transactions',
			icon: List,
			match: (p: string) => p === '/tx' || p.startsWith('/tx/')
		},
		{
			href: '/wallets',
			label: 'Wallets',
			icon: Wallet,
			match: (p: string) => p.startsWith('/wallets')
		},
		{ href: '/tax', label: 'Tax', icon: Percent, match: (p: string) => p.startsWith('/tax') },
		{
			href: '/settings',
			label: 'Settings',
			icon: SettingsIcon,
			match: (p: string) => p.startsWith('/settings')
		}
	];

	const SHORTCUTS: [string, string][] = [
		['n', 'New entry'],
		['g d', 'Go to dashboard'],
		['g t', 'Go to transactions'],
		['g w', 'Go to wallets'],
		['g x', 'Go to tax'],
		['u', 'Flip sats ⇄ BTC'],
		['/', 'Search ledger (on /tx)'],
		['?', 'This cheatsheet'],
		['esc', 'Close / cancel']
	];
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<svelte:window onkeydown={onKeydown} />

{#snippet ticker()}
	{#if price}
		<button
			type="button"
			class="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 num text-xs transition-colors duration-100 hover:text-text"
			onclick={fetchPrice}
			title="Source: {price.source}"
			aria-label="live BTC price — click to refresh"
		>
			<span class="size-1.5 shrink-0 rounded-full {DOT[priceStatus]}" aria-hidden="true"></span>
			<span class="truncate sm:hidden">{formatInrCompact(Math.round(price.btcInr * 100))}</span>
			<span class="hidden truncate sm:inline">
				{formatRateInr(price.btcInr)} · {formatUsd(price.btcUsd)}
			</span>
			{#if priceStatus === 'amber' && priceAge != null}
				<span class="shrink-0 text-muted">{formatRelative(price.fetchedAt, now)}</span>
			{:else if priceStatus === 'red'}
				<span class="shrink-0 text-loss">
					Stale · {formatRelative(price.fetchedAt, now)} · retry
				</span>
			{/if}
		</button>
	{:else if priceError}
		<button
			type="button"
			class="flex items-center gap-2 rounded-md px-1 py-0.5 num text-xs text-loss transition-colors duration-100"
			onclick={fetchPrice}
		>
			<span class="size-1.5 rounded-full bg-loss" aria-hidden="true"></span>
			Price unavailable · retry
		</button>
	{:else}
		<span class="flex items-center gap-2 px-1 num text-xs text-muted" aria-hidden="true">
			<span class="size-1.5 rounded-full bg-border"></span>
			— — —
		</span>
	{/if}
{/snippet}

{#if isLogin}
	{@render children()}
{:else}
	<div class="min-h-svh">
		<!-- Desktop rail -->
		<aside
			class="fixed inset-y-0 left-0 z-40 hidden w-[200px] flex-col border-r border-border bg-bg px-3 py-4 lg:flex"
			aria-label="primary"
		>
			<p class="px-1 num text-[13px] font-medium tracking-wide text-muted">satbook</p>
			<a
				href="/tx/new"
				class="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-bg transition-opacity duration-100 hover:opacity-90"
			>
				<Plus size={14} strokeWidth={2} aria-hidden="true" />
				New entry
			</a>
			<nav class="mt-6 flex flex-col gap-0.5" aria-label="sections">
				{#each NAV as item (item.href)}
					<a
						href={item.href}
						aria-current={item.match(pathname) ? 'page' : undefined}
						class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-100 {item.match(
							pathname
						)
							? 'bg-surface-2 text-text'
							: 'text-muted hover:bg-surface hover:text-text'}"
					>
						<item.icon size={16} strokeWidth={1.5} class="shrink-0" aria-hidden="true" />
						{item.label}
					</a>
				{/each}
			</nav>
		</aside>

		<div class="lg:pl-[200px]">
			<!-- Top bar: ticker · unit toggle · settings (mobile) · logout -->
			<header
				class="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-b border-border bg-bg/95 px-4 backdrop-blur"
			>
				{@render ticker()}
				<div class="flex shrink-0 items-center gap-2">
					<div
						class="hidden rounded-md border border-border p-0.5 sm:flex"
						role="group"
						aria-label="display unit"
					>
						<button
							type="button"
							class="rounded-[4px] px-2 py-0.5 num text-[11px] transition-colors duration-100 {unit.value ===
							'sats'
								? 'bg-surface-2 text-text'
								: 'text-muted hover:text-text'}"
							aria-pressed={unit.value === 'sats'}
							onclick={() => setUnitValue('sats')}
						>
							sats
						</button>
						<button
							type="button"
							class="rounded-[4px] px-2 py-0.5 num text-[11px] transition-colors duration-100 {unit.value ===
							'btc'
								? 'bg-surface-2 text-text'
								: 'text-muted hover:text-text'}"
							aria-pressed={unit.value === 'btc'}
							onclick={() => setUnitValue('btc')}
						>
							BTC
						</button>
					</div>
					<a
						href="/settings"
						class="rounded-md p-1.5 text-muted transition-colors duration-100 hover:text-text lg:hidden"
						aria-label="Settings"
					>
						<SettingsIcon size={16} strokeWidth={1.5} aria-hidden="true" />
					</a>
					<form method="POST" action="/logout">
						<button
							type="submit"
							class="rounded-md p-1.5 text-muted transition-colors duration-100 hover:text-text"
							title="Log out"
							aria-label="Log out"
						>
							<LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
						</button>
					</form>
				</div>
			</header>

			<main class="mx-auto max-w-[1200px] px-4 py-6 pb-24 lg:pb-10">
				{@render children()}
			</main>
		</div>

		<!-- Mobile bottom tab bar -->
		<nav
			class="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
			aria-label="primary"
		>
			<div class="grid h-14 grid-cols-5 items-center">
				{#each [NAV[0], NAV[1]] as item (item.href)}
					<a
						href={item.href}
						aria-current={item.match(pathname) ? 'page' : undefined}
						class="flex h-full flex-col items-center justify-center gap-0.5 text-[10px] transition-colors duration-100 {item.match(
							pathname
						)
							? 'text-text'
							: 'text-muted'}"
					>
						<item.icon size={16} strokeWidth={1.5} class="shrink-0" aria-hidden="true" />
						{item.label}
					</a>
				{/each}
				<div class="flex justify-center">
					<a
						href="/tx/new"
						class="-mt-6 flex size-12 items-center justify-center rounded-full bg-accent text-bg transition-opacity duration-100 hover:opacity-90"
						aria-label="New entry"
					>
						<Plus size={22} strokeWidth={2} aria-hidden="true" />
					</a>
				</div>
				{#each [NAV[2], NAV[3]] as item (item.href)}
					<a
						href={item.href}
						aria-current={item.match(pathname) ? 'page' : undefined}
						class="flex h-full flex-col items-center justify-center gap-0.5 text-[10px] transition-colors duration-100 {item.match(
							pathname
						)
							? 'text-text'
							: 'text-muted'}"
					>
						<item.icon size={16} strokeWidth={1.5} class="shrink-0" aria-hidden="true" />
						{item.label}
					</a>
				{/each}
			</div>
		</nav>
	</div>

	<!-- Shortcut cheatsheet overlay -->
	{#if cheatsheetOpen}
		<div class="fixed inset-0 z-50">
			<button
				type="button"
				class="absolute inset-0 bg-black/60"
				aria-label="Close shortcuts"
				onclick={() => (cheatsheetOpen = false)}
			></button>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="keyboard shortcuts"
				class="absolute top-1/2 left-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-5"
			>
				<h2 class="label-caps">keyboard shortcuts</h2>
				<dl class="mt-4 space-y-2">
					{#each SHORTCUTS as [key, desc] (key)}
						<div class="flex items-center justify-between gap-4">
							<dt>
								<kbd
									class="rounded border border-border bg-surface-2 px-1.5 py-0.5 num text-[11px]"
								>
									{key}
								</kbd>
							</dt>
							<dd class="text-xs text-muted">{desc}</dd>
						</div>
					{/each}
				</dl>
			</div>
		</div>
	{/if}
{/if}
