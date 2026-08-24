<script lang="ts">
	// THE entry form (spec §3) — shared by /tx/new (create) and /tx/[id]/edit.
	// Owns: type segmented control, txid autofill, IST timestamp, the 2-of-3
	// triad + currency/FX, per-type blocks, backdated rate autofill, live gain
	// preview, the optional exchange-buy withdrawal section, and the
	// save/save-&-add-another/cancel bar. All amounts cross the wire as
	// integers (sats/paise) via hidden canonical fields.
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import LotSliceTable from '$lib/components/LotSliceTable.svelte';
	import type {
		FiatCurrency,
		PreviewPayload,
		RateLookupPayload,
		RateSource,
		Tx,
		TxType,
		ValidationIssue,
		WalletKind
	} from '$lib/types';
	import { formatInr, formatSats } from '$lib/utils/money';
	import {
		formatIstDateShort,
		formatIstFull,
		formatUtcFull,
		istInputToUtcSec,
		utcSecToIstInput
	} from '$lib/utils/time';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { onMount } from 'svelte';
	import BtcAmountInput from './BtcAmountInput.svelte';
	import TriInput from './TriInput.svelte';
	import TxidLookup from './TxidLookup.svelte';
	import {
		clearAmounts,
		derivedField,
		editField,
		initialTriad,
		rateEdited,
		setPrefilledRate,
		type TriadState,
		type TriField
	} from './triad';

	let {
		mode,
		tx: txProp = null,
		wallets,
		live: liveProp = null,
		form = null
	}: {
		mode: 'create' | 'edit';
		tx?: Tx | null;
		wallets: { id: number; name: string; kind: WalletKind }[];
		live?: { btcInr: number; btcUsd: number } | null;
		form?: { errors?: string[]; saved?: boolean; id?: number } | null;
	} = $props();

	// The form seeds once from its initial data and owns the state afterwards —
	// later prop changes must never clobber in-progress edits.
	// svelte-ignore state_referenced_locally
	const tx = txProp;
	// svelte-ignore state_referenced_locally
	const live = liveProp;

	// --- constants -----------------------------------------------------------

	const TYPES: { t: TxType; label: string }[] = [
		{ t: 'INCOME', label: 'Income' },
		{ t: 'BUY', label: 'Buy' },
		{ t: 'SELL', label: 'Sell' },
		{ t: 'SPEND', label: 'Spend' },
		{ t: 'TRANSFER', label: 'Transfer' }
	];
	const DEFAULT_CURRENCY: Record<TxType, FiatCurrency> = {
		INCOME: 'USD',
		BUY: 'INR',
		SELL: 'INR',
		SPEND: 'INR',
		TRANSFER: 'INR'
	};
	const LS_CUR = 'satbook.txform.currency';
	const LS_PAIR = 'satbook.txform.transfer-pair';
	const TAX_RATE = 0.312; // 30% + 4% cess
	const FUTURE_SLACK_SEC = 300;
	const nowSec = () => Math.floor(Date.now() / 1000);

	// --- wallet / currency defaults (by wallet kind, never by name) ----------

	const nameOf = (id: number | null) => wallets.find((w) => w.id === id)?.name ?? '—';
	const kindOf = (id: number | null) => wallets.find((w) => w.id === id)?.kind ?? null;

	function defaultWalletId(t: TxType): number | null {
		// BUY usually happens on an exchange; everything else in self custody.
		const preferred =
			t === 'BUY'
				? wallets.find((w) => w.kind === 'exchange')?.id
				: wallets.find((w) => w.kind !== 'exchange')?.id;
		return preferred ?? wallets[0]?.id ?? null;
	}

	function defaultPair(): [number | null, number | null] {
		const from = wallets.find((w) => w.kind !== 'exchange')?.id ?? wallets[0]?.id ?? null;
		const to =
			wallets.find((w) => w.kind === 'cold' && w.id !== from)?.id ??
			wallets.find((w) => w.id !== from)?.id ??
			null;
		return [from, to];
	}

	function savedPair(): [number, number] | null {
		try {
			const raw = localStorage.getItem(LS_PAIR);
			if (!raw) return null;
			const [f, t] = JSON.parse(raw) as [number, number];
			if (wallets.some((w) => w.id === f) && wallets.some((w) => w.id === t) && f !== t)
				return [f, t];
		} catch {
			/* corrupt/absent — fall back to defaults */
		}
		return null;
	}

	function savedCurrency(t: TxType): FiatCurrency {
		try {
			const raw = localStorage.getItem(LS_CUR);
			if (raw) {
				const c = (JSON.parse(raw) as Partial<Record<TxType, string>>)[t];
				if (c === 'INR' || c === 'USD' || c === 'EUR') return c;
			}
		} catch {
			/* corrupt/absent — fall back to defaults */
		}
		return DEFAULT_CURRENCY[t];
	}

	function rememberCurrency(t: TxType, c: FiatCurrency) {
		try {
			const raw = localStorage.getItem(LS_CUR);
			const m = raw ? (JSON.parse(raw) as Record<string, string>) : {};
			m[t] = c;
			localStorage.setItem(LS_CUR, JSON.stringify(m));
		} catch {
			/* private mode etc. — memory is best-effort */
		}
	}

	// --- core state ----------------------------------------------------------

	const initialType: TxType = tx?.type ?? 'BUY';
	const initialCurrency: FiatCurrency = tx?.fiatCurrency ?? DEFAULT_CURRENCY[initialType];
	const [initialFrom, initialTo] =
		tx != null ? [tx.fromWalletId ?? null, tx.toWalletId ?? null] : defaultPair();

	let type = $state<TxType>(initialType);
	let ts = $state<number>(tx?.ts ?? nowSec());
	let tsFromChain = $state(false);
	let txid = $state(tx?.txid ?? '');
	let note = $state(tx?.notes ?? '');
	let currency = $state<FiatCurrency>(initialCurrency);
	let walletId = $state<number | null>(
		tx != null ? (tx.type !== 'TRANSFER' ? tx.walletId : null) : defaultWalletId(initialType)
	);
	let fromWalletId = $state<number | null>(initialFrom);
	let toWalletId = $state<number | null>(initialTo);
	let feeSats = $state<number | null>(tx && tx.feeSats > 0 ? tx.feeSats : null);
	let feeFromChain = $state(false);
	let btcFromChain = $state(false);
	let triadDirty = $state(false);

	const disposalType = $derived(type === 'SELL' || type === 'SPEND');
	/** Network fees exist on TRANSFER, SELL and SPEND. */
	const feeType = $derived(type === 'TRANSFER' || disposalType);

	function initTriad(): TriadState {
		const s = initialTriad();
		if (tx) {
			s.sats = tx.amountSats;
			if (tx.type === 'TRANSFER') {
				s.manual = ['btc'];
			} else {
				s.fiatMinor = tx.fiatAmountMinor;
				// The stored integers are authoritative — the displayed rate always
				// derives from them. enteredRate is only a last resort (it can go
				// stale when amounts are later corrected, e.g. a fee split).
				s.rate =
					tx.fiatAmountMinor != null && tx.amountSats > 0
						? (tx.fiatAmountMinor * 1e6) / tx.amountSats
						: (tx.enteredRate ?? null);
				s.manual = ['btc', 'fiat'];
			}
			return s;
		}
		const seed =
			live == null
				? null
				: currency === 'INR'
					? live.btcInr
					: currency === 'USD'
						? live.btcUsd
						: null;
		if (seed != null) {
			s.rate = seed;
			s.ratePrefilled = true;
		}
		return s;
	}
	const tri = $state<TriadState>(initTriad());

	// Session memory: returning to a type restores its wallet/currency choice.
	const walletMemo: Partial<Record<TxType, number | null>> = {};
	const currencyMemo: Partial<Record<TxType, FiatCurrency>> = {};
	if (tx && tx.type !== 'TRANSFER') {
		walletMemo[tx.type] = tx.walletId;
		if (tx.fiatCurrency) currencyMemo[tx.type] = tx.fiatCurrency;
	}

	// --- exchange-buy withdrawal section (create-only, spec: composite flow) --
	// A BUY into an exchange wallet can record its self-custody withdrawal in
	// the same save: the server inserts BUY + TRANSFER atomically. Timestamp and
	// amount follow the buy until touched (withdrawals often settle hours to
	// days later, and exchanges may deduct a withdrawal amount).

	let withdrawOpen = $state(false);
	// svelte-ignore state_referenced_locally
	let wdToWalletId = $state<number | null>(wallets.find((w) => w.kind !== 'exchange')?.id ?? null);
	let wdTs = $state<number | null>(null); // null → follows the buy timestamp
	let wdTsFromChain = $state(false);
	let wdTxid = $state('');
	let wdSats = $state<number | null>(null);
	let wdSatsTouched = $state(false); // untouched → follows the buy amount
	let wdSatsFromChain = $state(false);
	let wdFeeSats = $state<number | null>(null);
	let wdFeeFromChain = $state(false);

	const composeEligible = $derived(
		mode === 'create' && type === 'BUY' && kindOf(walletId) === 'exchange'
	);
	const withdrawActive = $derived(composeEligible && withdrawOpen);
	const selfCustodyWallets = $derived(wallets.filter((w) => w.kind !== 'exchange'));
	const wdEffTs = $derived(wdTs ?? ts);
	const wdEffSats = $derived(wdSatsTouched ? wdSats : tri.sats);

	function resetWithdrawal() {
		withdrawOpen = false;
		wdTs = null;
		wdTsFromChain = false;
		wdTxid = '';
		wdSats = null;
		wdSatsTouched = false;
		wdSatsFromChain = false;
		wdFeeSats = null;
		wdFeeFromChain = false;
	}

	function onWdTsInput(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value;
		wdTsFromChain = false;
		if (!v) return;
		try {
			wdTs = istInputToUtcSec(v);
		} catch {
			/* partially-typed value — keep the last good timestamp */
		}
	}

	function onWdChain(d: { blockTime: number | null; feeSats: number; confirmed: boolean }) {
		if (d.blockTime != null) {
			wdTs = d.blockTime;
			wdTsFromChain = true;
		}
		if (d.feeSats > 0) {
			wdFeeSats = d.feeSats;
			wdFeeFromChain = true;
		}
	}

	function onWdPick(sel: { sats: number; walletId: number | null }) {
		wdSats = sel.sats;
		wdSatsTouched = true;
		wdSatsFromChain = true;
		if (sel.walletId != null && kindOf(sel.walletId) !== 'exchange') wdToWalletId = sel.walletId;
	}

	// --- FX + rate provenance ------------------------------------------------

	interface FxView {
		rate: number | null;
		state: 'idle' | 'pending' | 'fetched' | 'manual' | 'failed' | 'saved';
		label: string | null;
	}
	let fx = $state<FxView>(
		tx && tx.fiatCurrency && tx.fiatCurrency !== 'INR' && tx.fxRateToInr != null
			? { rate: tx.fxRateToInr, state: 'saved', label: null }
			: { rate: null, state: 'idle', label: null }
	);
	// Edit mode treats the saved FX as user-owned — never auto-clobbered.
	let fxTouched = tx != null && tx.fiatCurrency != null && tx.fiatCurrency !== 'INR';

	function sourceName(src: string | null): string | null {
		switch (src) {
			case 'live':
				return 'live price';
			case 'binance-1h':
				return 'Binance 1h close';
			case 'binance-1d':
				return 'Binance 1d close';
			case 'coinbase-1d':
				return 'Coinbase daily close';
			case 'coingecko-1d':
				return 'CoinGecko daily';
			case 'sheet-import':
				return 'imported from sheet';
			default:
				return src;
		}
	}

	let rateChip = $state<string | null>(
		tx
			? tx.rateSource
				? tx.rateSource === 'manual'
					? 'manual'
					: `${sourceName(tx.rateSource)} · saved`
				: null
			: live != null && (initialCurrency === 'INR' || initialCurrency === 'USD')
				? 'live price'
				: null
	);
	let rateProvenance = $state<RateSource | null>(
		tx
			? tx.rateSource && tx.rateSource !== 'manual'
				? (tx.rateSource as RateSource)
				: null
			: live != null && (initialCurrency === 'INR' || initialCurrency === 'USD')
				? 'live'
				: null
	);
	let rateFailed = $state(false);
	let ratePending = $state(false);
	/** ₹/BTC at the current timestamp — feeds TRANSFER fee valuation. */
	let inrPerBtc = $state<number | null>(live?.btcInr ?? null);

	function chipFor(src: RateSource | null, forTs: number): string | null {
		switch (src) {
			case 'live':
				return 'live price';
			case 'binance-1h':
				return `Binance 1h close · ${formatIstFull(forTs)}`;
			case 'binance-1d':
				return `Binance 1d close · ${formatIstDateShort(forTs)}`;
			case 'coinbase-1d':
				return `Coinbase daily · ${formatIstDateShort(forTs)}`;
			case 'coingecko-1d':
				return `CoinGecko daily · ${formatIstDateShort(forTs)}`;
			default:
				return src;
		}
	}

	// --- rate/FX fetch (mount, currency change immediate; ts change debounced 600ms)

	let ratesSeq = 0;
	async function refreshRates() {
		const mySeq = ++ratesSeq;
		const forTs = ts;
		const cur = currency;
		const wantFx = cur !== 'INR';
		const fxUntouched = wantFx && !fxTouched;
		ratePending = true;
		if (fxUntouched) fx.state = 'pending';
		try {
			const res = await fetch(`/api/rates?ts=${forTs}&fiat=${cur}`);
			if (mySeq !== ratesSeq) return;
			if (!res.ok) throw new Error(String(res.status));
			const p = (await res.json()) as RateLookupPayload;
			if (mySeq !== ratesSeq) return;
			inrPerBtc = p.btcInr;
			if (fxUntouched) {
				if (p.fxToInr != null) {
					fx.rate = p.fxToInr;
					fx.state = 'fetched';
					fx.label = `${p.fxSource === 'fawaz' ? 'fawaz' : 'ECB'} ${p.fxDate ?? ''}`.trim();
				} else {
					fx.rate = null;
					fx.state = 'failed';
					fx.label = null;
				}
			}
			if (!rateEdited(tri) && derivedField(tri) !== 'rate') {
				const fxRate = cur === 'INR' ? 1 : fx.rate;
				const r = p.btcInr != null && fxRate != null && fxRate > 0 ? p.btcInr / fxRate : null;
				setPrefilledRate(tri, r);
				if (r != null) {
					rateProvenance = p.btcInrSource;
					rateChip = chipFor(p.btcInrSource, forTs);
					rateFailed = false;
				} else {
					rateProvenance = null;
					rateChip = null;
					rateFailed = true;
				}
			}
		} catch {
			if (mySeq !== ratesSeq) return;
			inrPerBtc = null;
			if (fxUntouched) {
				fx.rate = null;
				fx.state = 'failed';
				fx.label = null;
			}
			if (!rateEdited(tri) && derivedField(tri) !== 'rate') {
				setPrefilledRate(tri, null);
				rateProvenance = null;
				rateChip = null;
				rateFailed = true;
			}
		} finally {
			if (mySeq === ratesSeq) ratePending = false;
		}
	}

	let ratesTimer: ReturnType<typeof setTimeout> | undefined;
	let prevRateKey: string | null = null;
	$effect(() => {
		const key = `${ts}|${currency}`;
		if (key === prevRateKey) return;
		const tsOnly = prevRateKey != null && prevRateKey.endsWith(`|${currency}`);
		prevRateKey = key;
		clearTimeout(ratesTimer);
		ratesTimer = setTimeout(() => void refreshRates(), tsOnly ? 600 : 0);
		return () => clearTimeout(ratesTimer);
	});

	// --- currency + type switching ------------------------------------------

	function applyCurrency(c: FiatCurrency, userPicked: boolean) {
		if (c === currency) return;
		currency = c;
		currencyMemo[type] = c;
		if (userPicked) rememberCurrency(type, c);
		fxTouched = false;
		fx = { rate: null, state: c === 'INR' ? 'idle' : 'pending', label: null };
		// An untouched prefill now denominates the wrong fiat — clear; the rates
		// effect refetches immediately on the currency change.
		if (!rateEdited(tri) && derivedField(tri) !== 'rate') {
			setPrefilledRate(tri, null);
			rateChip = null;
			rateProvenance = null;
		}
	}

	function switchType(t: TxType) {
		if (t === type) return;
		if (type !== 'TRANSFER') walletMemo[type] = walletId;
		type = t;
		if (t === 'TRANSFER') {
			if (fromWalletId == null || toWalletId == null) {
				[fromWalletId, toWalletId] = savedPair() ?? defaultPair();
			}
		} else {
			walletId = walletMemo[t] ?? defaultWalletId(t);
			applyCurrency(currencyMemo[t] ?? savedCurrency(t), false);
		}
	}

	// --- transfer wallets: never equal, picking the same auto-swaps ----------

	function rememberPair() {
		if (fromWalletId == null || toWalletId == null) return;
		try {
			localStorage.setItem(LS_PAIR, JSON.stringify([fromWalletId, toWalletId]));
		} catch {
			/* best-effort */
		}
	}
	function setFrom(id: number) {
		if (toWalletId === id) toWalletId = fromWalletId;
		fromWalletId = id;
		rememberPair();
	}
	function setTo(id: number) {
		if (fromWalletId === id) fromWalletId = toWalletId;
		toWalletId = id;
		rememberPair();
	}

	// --- timestamp -----------------------------------------------------------

	function onTsInput(e: Event) {
		const v = (e.currentTarget as HTMLInputElement).value;
		tsFromChain = false;
		if (!v) return;
		try {
			ts = istInputToUtcSec(v);
		} catch {
			/* partially-typed value — keep the last good timestamp */
		}
	}
	function setTs(v: number) {
		ts = v;
		tsFromChain = false;
	}

	// --- txid autofill -------------------------------------------------------

	function onChain(d: { blockTime: number | null; feeSats: number; confirmed: boolean }) {
		if (d.blockTime != null) {
			ts = d.blockTime;
			tsFromChain = true;
		}
		if (feeType && d.feeSats > 0) {
			feeSats = d.feeSats;
			feeFromChain = true;
		}
	}
	function onPick(sel: { sats: number; walletId: number | null }) {
		triadDirty = true;
		editField(tri, 'btc', sel.sats);
		btcFromChain = true;
		if (type === 'TRANSFER' && sel.walletId != null && sel.walletId !== fromWalletId)
			toWalletId = sel.walletId;
	}

	function onTriEdit(field: TriField) {
		triadDirty = true;
		if (field === 'btc') btcFromChain = false;
		if (field === 'rate') {
			rateChip = 'manual';
			rateProvenance = null;
			rateFailed = false;
		}
	}

	// --- canonical record (hidden fields) ------------------------------------

	const feeInrMinor = $derived.by(() => {
		if (!feeType || feeSats == null || feeSats <= 0) return null;
		// Editing an unchanged fee: the FMV stored at transaction time is the
		// truth; only an edited fee is revalued at the current/backdated rate.
		if (tx?.type === type && feeSats === tx.feeSats && tx.feeInrValueMinor != null)
			return tx.feeInrValueMinor;
		if (inrPerBtc != null) return Math.round((feeSats * inrPerBtc) / 1e6);
		return tx?.type === type ? (tx.feeInrValueMinor ?? null) : null;
	});
	// Informational FMV of the withdrawal fee; the buy-time rate is close enough.
	const wdFeeInrMinor = $derived(
		wdFeeSats != null && wdFeeSats > 0 && inrPerBtc != null
			? Math.round((wdFeeSats * inrPerBtc) / 1e6)
			: null
	);
	const recordInrMinor = $derived(
		tri.fiatMinor == null
			? null
			: currency === 'INR'
				? tri.fiatMinor
				: fx.rate != null
					? Math.round(tri.fiatMinor * fx.rate)
					: null
	);
	const submittedFx = $derived(currency === 'INR' ? 1 : fx.rate);
	const submittedRateSource = $derived(
		mode === 'edit' && !triadDirty && tx?.rateSource
			? tx.rateSource
			: rateEdited(tri) || derivedField(tri) === 'rate'
				? 'manual'
				: (rateProvenance ?? 'manual')
	);
	const submittedBtcUsd = $derived(
		currency === 'USD' ? tri.rate : mode === 'edit' && !triadDirty ? (tx?.btcUsdRate ?? null) : null
	);

	// --- validation (inline on blur, never a modal) --------------------------

	let attempted = $state(false);
	let touched = $state<Record<string, boolean>>({});
	const touch = (k: string) => (touched[k] = true);

	const tsFuture = $derived(ts > nowSec() + FUTURE_SLACK_SEC);
	const fieldErrors = $derived.by(() => {
		const e: Record<string, string> = {};
		if (tsFuture) e.ts = 'Timestamp is in the future';
		if (tri.sats == null || tri.sats <= 0) e.amount = 'Enter an amount';
		if (type === 'TRANSFER') {
			if (fromWalletId == null) e.from = 'Pick the source wallet';
			if (toWalletId == null) e.to = 'Pick the destination wallet';
			else if (fromWalletId === toWalletId) e.to = 'Wallets must differ';
		} else {
			if (walletId == null) e.wallet = 'Pick a wallet';
			if (tri.rate == null || tri.rate <= 0) e.rate = 'Enter a rate';
			if (tri.fiatMinor == null) e.fiat = `Enter the ${currency} amount`;
			if (currency !== 'INR' && (fx.rate == null || fx.rate <= 0))
				e.fx = 'FX rate required — the record stores ₹';
		}
		if (withdrawActive) {
			if (wdToWalletId == null) e.wdTo = 'Pick the destination wallet';
			if (wdEffSats == null || wdEffSats <= 0) e.wdAmount = 'Enter the amount received';
			if (wdEffTs > nowSec() + FUTURE_SLACK_SEC) e.wdTs = 'Timestamp is in the future';
			else if (wdEffTs < ts) e.wdTs = 'Withdrawal cannot precede the buy';
		}
		return e;
	});
	const clientValid = $derived(Object.keys(fieldErrors).length === 0);
	const fxBlocked = $derived(type !== 'TRANSFER' && currency !== 'INR' && fx.rate == null);
	const showErr = (k: string): string | null =>
		attempted || touched[k] ? (fieldErrors[k] ?? null) : null;

	// --- gain preview (debounced dry-run of the FIFO engine) -----------------

	let preview = $state<PreviewPayload | null>(null);
	let previewPending = $state(false);
	let previewOpen = $state(false);
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	let previewSeq = 0;

	function buildDraft(): Record<string, unknown> | null {
		if (tri.sats == null || tri.sats <= 0 || tsFuture) return null;
		const base = {
			id: tx?.id ?? null,
			type,
			ts,
			seq: tx?.seq ?? null,
			txid: txid.trim() || null,
			notes: note.trim() || null
		};
		if (type === 'TRANSFER') {
			if (fromWalletId == null || toWalletId == null || fromWalletId === toWalletId) return null;
			return {
				...base,
				fromWalletId,
				toWalletId,
				amountSats: tri.sats,
				feeSats: feeSats ?? 0,
				feeInrValueMinor: feeInrMinor
			};
		}
		if (
			walletId == null ||
			tri.fiatMinor == null ||
			tri.rate == null ||
			submittedFx == null ||
			submittedFx <= 0 ||
			recordInrMinor == null
		)
			return null;
		return {
			...base,
			walletId,
			amountSats: tri.sats,
			// The preview draft carries the fee so INSUFFICIENT_LOTS accounts for it.
			feeSats: disposalType ? (feeSats ?? 0) : 0,
			feeInrValueMinor: disposalType ? feeInrMinor : null,
			fiatCurrency: currency,
			fiatAmountMinor: tri.fiatMinor,
			fxRateToInr: submittedFx,
			inrValueMinor: recordInrMinor,
			btcUsdRate: submittedBtcUsd,
			enteredRate: tri.rate,
			rateSource: submittedRateSource
		};
	}

	$effect(() => {
		clearTimeout(previewTimer);
		// SELL/SPEND for the gain preview; TRANSFER too, so oversized transfers
		// surface the negative-balance issue before save.
		if (type === 'INCOME' || type === 'BUY') {
			preview = null;
			previewPending = false;
			return;
		}
		const draft = buildDraft();
		if (!draft) {
			preview = null;
			previewPending = false;
			return;
		}
		const body = JSON.stringify(draft);
		previewTimer = setTimeout(async () => {
			const mySeq = ++previewSeq;
			previewPending = true;
			try {
				const res = await fetch('/api/preview', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body
				});
				if (mySeq !== previewSeq) return;
				preview = res.ok ? ((await res.json()) as PreviewPayload) : null;
			} catch {
				if (mySeq === previewSeq) preview = null;
			} finally {
				if (mySeq === previewSeq) previewPending = false;
			}
		}, 400);
		return () => clearTimeout(previewTimer);
	});

	const previewVisible = $derived(
		(preview != null && (preview.disposal != null || preview.issues.length > 0)) ||
			(previewPending && disposalType)
	);

	// The engine reports one issue per downstream transaction the draft would
	// break; the user only needs the verdict — coalesce to a single line with
	// the worst shortfall.
	function summarizeIssues(issues: ValidationIssue[]): string {
		let worstShort = 0;
		let walletName: string | null = null;
		for (const i of issues) {
			const short =
				i.code === 'INSUFFICIENT_LOTS'
					? +(/short (\d+) sats/.exec(i.detail)?.[1] ?? 0)
					: -+(/balance would be (-\d+) sats/.exec(i.detail)?.[1] ?? 0);
			if (short > worstShort) worstShort = short;
			const wid = /wallet (\d+)/.exec(i.detail)?.[1];
			if (wid && walletName == null) walletName = wallets.find((x) => x.id === +wid)?.name ?? null;
		}
		const where = walletName ? ` in "${walletName}"` : '';
		const by = worstShort > 0 ? ` — short ${formatSats(worstShort)} sats` : '';
		return `Not enough sats${where} at this time${by}. Reduce the amount or check the timestamp.`;
	}

	// --- save / keyboard -----------------------------------------------------

	let formEl = $state<HTMLFormElement | null>(null);
	let intentEl = $state<HTMLInputElement | null>(null);
	let typeGroupEl = $state<HTMLDivElement | null>(null);
	let submitting = $state(false);
	let toastMsg = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function submitWith(intent: 'save' | 'again') {
		if (!formEl || submitting) return;
		if (intentEl) intentEl.value = intent;
		formEl.requestSubmit();
	}

	const submitEnhance: SubmitFunction = ({ cancel }) => {
		attempted = true;
		if (!clientValid || fxBlocked) {
			cancel();
			return;
		}
		submitting = true;
		return async ({ result, update }) => {
			submitting = false;
			if (intentEl) intentEl.value = 'save';
			if (result.type === 'success' && (result.data as { saved?: boolean } | undefined)?.saved) {
				await update({ reset: false });
				// Save & add another: keep type/wallet/currency/timestamp (and the
				// rate + its provenance), clear amounts/txid/note/fee/chain chips.
				clearAmounts(tri);
				txid = '';
				note = '';
				feeSats = null;
				btcFromChain = false;
				feeFromChain = false;
				tsFromChain = false;
				resetWithdrawal();
				preview = null;
				previewOpen = false;
				attempted = false;
				touched = {};
				toastMsg = 'Saved. Balances, lots and tax recomputed.';
				clearTimeout(toastTimer);
				toastTimer = setTimeout(() => (toastMsg = null), 3500);
			} else {
				await update();
			}
		};
	};

	function cancelForm() {
		if (history.length > 1) history.back();
		else void goto('/tx');
	}

	// Ctrl/Cmd+Enter saves (+Shift: save & add another); Escape cancels.
	function onFormKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			cancelForm();
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			submitWith(e.shiftKey && mode === 'create' ? 'again' : 'save');
		}
	}

	onMount(() => {
		if (mode === 'create') {
			// localStorage prefs can't be read during SSR — apply once on mount.
			const c = savedCurrency(type);
			if (c !== currency) applyCurrency(c, false);
			const pair = savedPair();
			if (pair) [fromWalletId, toWalletId] = pair;
			typeGroupEl?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
		}
	});

	// --- shared classes ------------------------------------------------------

	const inputCls =
		'h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] transition-colors duration-100 placeholder:text-muted/50 hover:border-muted/50';
	const selectCls =
		'select-field mt-1 h-9 w-full rounded-md border border-border bg-surface pl-2.5 text-[13px] transition-colors duration-100 hover:border-muted/50';
	const chipBtn =
		'rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-text';
	const chainChip = 'rounded-full bg-surface-2 px-1.5 py-px derived text-[10px]';
	const labelCls = 'text-[11px] font-medium text-muted';
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- form-wide save/cancel keys -->
<form
	method="POST"
	bind:this={formEl}
	use:enhance={submitEnhance}
	onkeydown={onFormKeydown}
	novalidate
	class="mt-5 space-y-6"
>
	<!-- canonical record: integers only cross the wire -->
	<input type="hidden" name="intent" value="save" bind:this={intentEl} />
	<input type="hidden" name="type" value={type} />
	<input type="hidden" name="ts" value={ts} />
	{#if mode === 'edit' && tx?.seq != null}
		<input type="hidden" name="seq" value={tx.seq} />
	{/if}
	<input type="hidden" name="amountSats" value={tri.sats ?? ''} />
	<input type="hidden" name="txid" value={txid.trim()} />
	<input type="hidden" name="notes" value={note} />
	{#if type === 'TRANSFER'}
		<input type="hidden" name="fromWalletId" value={fromWalletId ?? ''} />
		<input type="hidden" name="toWalletId" value={toWalletId ?? ''} />
		<input type="hidden" name="feeSats" value={feeSats ?? 0} />
		<input type="hidden" name="feeInrValueMinor" value={feeInrMinor ?? ''} />
	{:else}
		<input type="hidden" name="walletId" value={walletId ?? ''} />
		{#if disposalType}
			<input type="hidden" name="feeSats" value={feeSats ?? 0} />
			<input type="hidden" name="feeInrValueMinor" value={feeInrMinor ?? ''} />
		{/if}
		<input type="hidden" name="fiatCurrency" value={currency} />
		<input type="hidden" name="fiatAmountMinor" value={tri.fiatMinor ?? ''} />
		<input type="hidden" name="fxRateToInr" value={submittedFx ?? ''} />
		<input type="hidden" name="inrValueMinor" value={recordInrMinor ?? ''} />
		<input type="hidden" name="btcUsdRate" value={submittedBtcUsd ?? ''} />
		<input type="hidden" name="enteredRate" value={tri.rate ?? ''} />
		<input type="hidden" name="rateSource" value={submittedRateSource} />
	{/if}
	{#if withdrawActive}
		<!-- withdrawal leg of a composite exchange buy (server: createTxPair) -->
		<input type="hidden" name="withdrawal" value="1" />
		<input type="hidden" name="wdToWalletId" value={wdToWalletId ?? ''} />
		<input type="hidden" name="wdTs" value={wdEffTs} />
		<input type="hidden" name="wdAmountSats" value={wdEffSats ?? ''} />
		<input type="hidden" name="wdFeeSats" value={wdFeeSats ?? 0} />
		<input type="hidden" name="wdFeeInrValueMinor" value={wdFeeInrMinor ?? ''} />
		<input type="hidden" name="wdTxid" value={wdTxid.trim()} />
	{/if}

	<!-- type segmented control -->
	<div>
		<span class={labelCls} id="type-label">Type</span>
		<div
			bind:this={typeGroupEl}
			class="mt-1.5 flex w-fit max-w-full overflow-x-auto rounded-md border border-border p-0.5"
			role="group"
			aria-labelledby="type-label"
		>
			{#each TYPES as { t, label } (t)}
				<button
					type="button"
					aria-pressed={type === t}
					class="shrink-0 rounded-[4px] px-2.5 py-1 num text-[12px] transition-colors duration-100 {type ===
					t
						? 'bg-surface-2 text-text'
						: 'text-muted hover:text-text'}"
					onclick={() => switchType(t)}
				>
					{label}
				</button>
			{/each}
		</div>
	</div>

	<!-- txid paste box + found card (spec §3.5) -->
	<TxidLookup
		bind:txid
		highlight={type === 'TRANSFER' && txid.trim() === ''}
		{wallets}
		onchain={onChain}
		onpick={onPick}
	/>

	<!-- timestamp (IST wall time) -->
	<div>
		<span class="flex items-center gap-1.5 {labelCls}">
			<label for="tx-ts">Timestamp (IST)</label>
			{#if tsFromChain}<span class={chainChip}>from chain</span>{/if}
		</span>
		<div class="mt-1 flex flex-wrap items-center gap-2">
			<input
				id="tx-ts"
				type="datetime-local"
				value={utcSecToIstInput(ts)}
				oninput={onTsInput}
				onblur={() => touch('ts')}
				class="h-9 rounded-md border bg-surface px-2.5 num text-[13px] transition-colors duration-100 {showErr(
					'ts'
				)
					? 'border-loss'
					: 'border-border hover:border-muted/50'}"
			/>
			<button type="button" class={chipBtn} onclick={() => setTs(nowSec())}>Now</button>
			<button type="button" class={chipBtn} onclick={() => setTs(nowSec() - 86400)}>
				Yesterday
			</button>
		</div>
		{#if showErr('ts')}
			<p class="mt-1 text-[11px] text-loss">{showErr('ts')}</p>
		{:else}
			<p class="mt-1 num text-[11px] text-muted">= {formatUtcFull(ts)}</p>
		{/if}
	</div>

	{#if type === 'TRANSFER'}
		<!-- TRANSFER block: from → to, BTC-only amount, network fee -->
		<div class="grid gap-4 sm:grid-cols-2">
			<div>
				<label class={labelCls} for="tx-from">From wallet</label>
				<select
					id="tx-from"
					value={fromWalletId != null ? String(fromWalletId) : ''}
					onchange={(e) => setFrom(parseInt(e.currentTarget.value, 10))}
					onblur={() => touch('from')}
					class={selectCls}
				>
					{#if fromWalletId == null}<option value="" disabled selected>—</option>{/if}
					{#each wallets as w (w.id)}<option value={String(w.id)}>{w.name}</option>{/each}
				</select>
				{#if showErr('from')}<p class="mt-1 text-[11px] text-loss">{showErr('from')}</p>{/if}
			</div>
			<div>
				<label class={labelCls} for="tx-to">To wallet</label>
				<select
					id="tx-to"
					value={toWalletId != null ? String(toWalletId) : ''}
					onchange={(e) => setTo(parseInt(e.currentTarget.value, 10))}
					onblur={() => touch('to')}
					class={selectCls}
				>
					{#if toWalletId == null}<option value="" disabled selected>—</option>{/if}
					{#each wallets as w (w.id)}<option value={String(w.id)}>{w.name}</option>{/each}
				</select>
				{#if showErr('to')}<p class="mt-1 text-[11px] text-loss">{showErr('to')}</p>{/if}
			</div>
		</div>

		<div>
			<span class="flex items-center gap-1.5 {labelCls}">
				<label for="tx-amount">Amount</label>
				{#if btcFromChain}<span class={chainChip}>from chain</span>{/if}
			</span>
			<div class="mt-1 max-w-xs">
				<BtcAmountInput
					id="tx-amount"
					sats={tri.sats}
					invalid={!!showErr('amount')}
					oninput={(v) => {
						onTriEdit('btc');
						editField(tri, 'btc', v);
					}}
					onblur={() => touch('amount')}
				/>
			</div>
			{#if showErr('amount')}<p class="mt-1 text-[11px] text-loss">{showErr('amount')}</p>{/if}
			<p class="mt-1 text-[11px] text-muted">
				Amount received by {nameOf(toWalletId)}; fee is additional sats leaving
				{nameOf(fromWalletId)}.
			</p>
		</div>

		<div>
			<span class="flex items-center gap-1.5 {labelCls}">
				<label for="tx-fee">Network fee</label>
				{#if feeFromChain}<span class={chainChip}>from chain</span>{/if}
			</span>
			<div class="mt-1 max-w-xs">
				<BtcAmountInput
					id="tx-fee"
					sats={feeSats}
					satsOnly
					placeholder="0"
					oninput={(v) => {
						feeSats = v;
						feeFromChain = false;
					}}
				/>
			</div>
			<p class="mt-1 text-[11px] text-muted">Fee reduces holdings; never taxed, never deductible</p>
			{#if feeInrMinor != null}
				<p class="mt-0.5 num text-[11px] text-muted">
					≈ {formatInr(feeInrMinor)}
				</p>
			{/if}
		</div>
	{:else}
		<!-- INCOME / BUY / SELL / SPEND: wallet + triad -->
		<div class="grid gap-4 sm:grid-cols-2">
			<div>
				<label class={labelCls} for="tx-wallet">Wallet</label>
				<select
					id="tx-wallet"
					value={walletId != null ? String(walletId) : ''}
					onchange={(e) => {
						const v = parseInt(e.currentTarget.value, 10);
						walletId = Number.isInteger(v) ? v : null;
						walletMemo[type] = walletId;
					}}
					onblur={() => touch('wallet')}
					class={selectCls}
				>
					{#if walletId == null}<option value="" disabled selected>—</option>{/if}
					{#each wallets as w (w.id)}<option value={String(w.id)}>{w.name}</option>{/each}
				</select>
				{#if showErr('wallet')}<p class="mt-1 text-[11px] text-loss">{showErr('wallet')}</p>{/if}
			</div>
		</div>

		<div>
			<TriInput
				{tri}
				{currency}
				oncurrencychange={(c) => applyCurrency(c, true)}
				{fx}
				onfxinput={(rate) => {
					fxTouched = true;
					fx.rate = rate;
					fx.state = 'manual';
					fx.label = null;
				}}
				rateChip={ratePending ? null : rateChip}
				rateError={showErr('rate') ??
					(rateFailed && tri.rate == null ? 'No rate found — enter manually' : null)}
				{ratePending}
				btcLabel={disposalType ? 'BTC sold' : 'BTC received'}
				fiatLabel={type === 'BUY'
					? currency === 'INR'
						? 'INR paid'
						: 'Value paid'
					: type === 'SPEND'
						? 'Value paid'
						: currency === 'INR'
							? 'INR received'
							: 'Value received'}
				btcChip={btcFromChain ? 'from chain' : null}
				onedit={onTriEdit}
				onfieldblur={(f) => touch(f === 'btc' ? 'amount' : f)}
				amountError={showErr('amount')}
				fiatError={showErr('fiat')}
				fxError={showErr('fx')}
			/>
			{#if type === 'INCOME'}
				<p class="mt-2 text-[11px] text-muted">
					INR value at receipt becomes this lot's cost basis.
				</p>
			{/if}
		</div>

		{#if disposalType}
			<!-- SELL/SPEND network fee: extra sats leaving the wallet on-chain -->
			<div>
				<span class="flex items-center gap-1.5 {labelCls}">
					<label for="tx-fee">Network fee</label>
					{#if feeFromChain}<span class={chainChip}>from chain</span>{/if}
				</span>
				<div class="mt-1 max-w-xs">
					<BtcAmountInput
						id="tx-fee"
						sats={feeSats}
						satsOnly
						placeholder="0"
						oninput={(v) => {
							feeSats = v;
							feeFromChain = false;
						}}
					/>
				</div>
				<p class="mt-1 text-[11px] text-muted">
					Fee reduces holdings; never taxed, never deductible
				</p>
				{#if feeInrMinor != null}
					<p class="mt-0.5 num text-[11px] text-muted">
						≈ {formatInr(feeInrMinor)}
					</p>
				{/if}
			</div>
		{/if}

		{#if composeEligible}
			<!-- composite exchange buy: optional withdrawal to self custody -->
			<div class="rounded-md border border-border">
				<label class="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-[13px]">
					<input type="checkbox" bind:checked={withdrawOpen} class="size-3.5 accent-accent" />
					Withdrawn to self custody
					<span class="text-[11px] text-muted">optional — saves the buy plus its transfer</span>
				</label>
				{#if withdrawOpen}
					<div class="space-y-5 border-t border-border/60 p-3">
						<TxidLookup
							id="wd-txid"
							bind:txid={wdTxid}
							{wallets}
							onchain={onWdChain}
							onpick={onWdPick}
						/>

						<div class="grid gap-4 sm:grid-cols-2">
							<div>
								<label class={labelCls} for="wd-to">Destination wallet</label>
								<select
									id="wd-to"
									value={wdToWalletId != null ? String(wdToWalletId) : ''}
									onchange={(e) => {
										const v = parseInt(e.currentTarget.value, 10);
										wdToWalletId = Number.isInteger(v) ? v : null;
									}}
									onblur={() => touch('wdTo')}
									class={selectCls}
								>
									{#if wdToWalletId == null}<option value="" disabled selected>—</option>{/if}
									{#each selfCustodyWallets as w (w.id)}
										<option value={String(w.id)}>{w.name}</option>
									{/each}
								</select>
								{#if showErr('wdTo')}
									<p class="mt-1 text-[11px] text-loss">{showErr('wdTo')}</p>
								{/if}
							</div>
							<div>
								<span class="flex items-center gap-1.5 {labelCls}">
									<label for="wd-ts">Withdrawal time (IST)</label>
									{#if wdTsFromChain}<span class={chainChip}>from chain</span>{/if}
								</span>
								<input
									id="wd-ts"
									type="datetime-local"
									value={utcSecToIstInput(wdEffTs)}
									oninput={onWdTsInput}
									onblur={() => touch('wdTs')}
									class="mt-1 h-9 w-full rounded-md border bg-surface px-2.5 num text-[13px] transition-colors duration-100 {showErr(
										'wdTs'
									)
										? 'border-loss'
										: 'border-border hover:border-muted/50'}"
								/>
								{#if showErr('wdTs')}
									<p class="mt-1 text-[11px] text-loss">{showErr('wdTs')}</p>
								{:else}
									<p class="mt-1 text-[11px] text-muted">
										Defaults to the buy time; withdrawals can settle hours to days later.
									</p>
								{/if}
							</div>
						</div>

						<div class="grid gap-4 sm:grid-cols-2">
							<div>
								<span class="flex items-center gap-1.5 {labelCls}">
									<label for="wd-amount">Amount received</label>
									{#if wdSatsFromChain}<span class={chainChip}>from chain</span>{/if}
								</span>
								<div class="mt-1">
									<BtcAmountInput
										id="wd-amount"
										sats={wdEffSats}
										invalid={!!showErr('wdAmount')}
										oninput={(v) => {
											wdSats = v;
											wdSatsTouched = true;
											wdSatsFromChain = false;
										}}
										onblur={() => touch('wdAmount')}
									/>
								</div>
								{#if showErr('wdAmount')}
									<p class="mt-1 text-[11px] text-loss">{showErr('wdAmount')}</p>
								{:else}
									<p class="mt-1 text-[11px] text-muted">
										Defaults to the full buy amount; lower it if the exchange deducted anything.
									</p>
								{/if}
							</div>
							<div>
								<span class="flex items-center gap-1.5 {labelCls}">
									<label for="wd-fee">Network fee</label>
									{#if wdFeeFromChain}<span class={chainChip}>from chain</span>{/if}
								</span>
								<div class="mt-1">
									<BtcAmountInput
										id="wd-fee"
										sats={wdFeeSats}
										satsOnly
										placeholder="0"
										oninput={(v) => {
											wdFeeSats = v;
											wdFeeFromChain = false;
										}}
									/>
								</div>
								<p class="mt-1 text-[11px] text-muted">
									Usually 0 — exchanges typically pay the withdrawal fee.
								</p>
								{#if wdFeeInrMinor != null}
									<p class="mt-0.5 num text-[11px] text-muted">≈ {formatInr(wdFeeInrMinor)}</p>
								{/if}
							</div>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	{/if}

	<!-- note -->
	<div>
		<label class={labelCls} for="tx-note">Note</label>
		<input
			id="tx-note"
			type="text"
			bind:value={note}
			placeholder="optional"
			autocomplete="off"
			class="mt-1 {inputCls}"
		/>
	</div>

	<!-- gain preview (spec §3.4/§3.7) — dry-run of the FIFO engine -->
	{#if previewVisible}
		<div class="rounded-md border border-border bg-surface">
			{#if preview != null && preview.issues.length > 0}
				<div class="border-b border-border/60 p-3 last:border-0">
					<p class="text-xs text-loss">{summarizeIssues(preview.issues)}</p>
				</div>
			{/if}
			{#if preview?.disposal}
				{@const d = preview.disposal}
				{@const est = Math.round(d.taxableConservativeMinor * TAX_RATE)}
				<button
					type="button"
					class="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 p-3 text-left num text-xs transition-colors duration-100 hover:bg-surface-2"
					aria-expanded={previewOpen}
					onclick={() => (previewOpen = !previewOpen)}
				>
					{#if d.netGainMinor < 0}
						<span>Est. taxable gain ₹0 (loss floored)</span>
						<span class="derived">net {formatInr(d.netGainMinor)}</span>
					{:else}
						<span>Est. taxable gain {formatInr(d.taxableConservativeMinor)}</span>
					{/if}
					<span class="text-muted">· tax ≈ {formatInr(est)} (31.2%)</span>
					<span class="text-muted">
						· consumes {d.slices.length} lot{d.slices.length === 1 ? '' : 's'}
					</span>
					<ChevronRight
						size={14}
						class="ml-auto text-muted transition-transform duration-150 {previewOpen
							? 'rotate-90'
							: ''}"
						aria-hidden="true"
					/>
				</button>
				{#if previewOpen}
					<div class="border-t border-border/60 px-3 pt-1 pb-2">
						<LotSliceTable slices={d.slices} compact />
					</div>
				{/if}
			{:else if previewPending}
				<p class="p-3 text-xs derived">Computing gain preview…</p>
			{/if}
		</div>
	{/if}

	<!-- server errors -->
	{#if form?.errors && form.errors.length > 0}
		<div class="space-y-1 rounded-md border border-loss/40 bg-loss/5 p-3" role="alert">
			{#each form.errors as err, i (i)}
				<p class="text-xs text-loss">{err}</p>
			{/each}
		</div>
	{/if}

	<!-- save bar (sticky above the mobile tab bar) -->
	<div
		class="sticky bottom-14 z-20 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
	>
		<button
			type="submit"
			disabled={submitting || fxBlocked}
			onclick={() => intentEl && (intentEl.value = 'save')}
			class="rounded-md bg-accent px-3.5 py-2 text-[13px] font-medium text-bg transition-opacity duration-100 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
		>
			{submitting ? 'Saving…' : 'Save'}
		</button>
		{#if mode === 'create'}
			<button
				type="submit"
				disabled={submitting || fxBlocked}
				onclick={() => intentEl && (intentEl.value = 'again')}
				class="rounded-md border border-border px-3.5 py-2 text-[13px] text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
			>
				Save & add another
			</button>
		{/if}
		<button
			type="button"
			onclick={cancelForm}
			class="rounded-md px-3 py-2 text-[13px] text-muted transition-colors duration-100 hover:text-text"
		>
			Cancel
		</button>
		{#if fxBlocked && fx.state === 'failed'}
			<span class="text-[11px] text-loss">FX fetch failed — enter the rate to enable Save</span>
		{/if}
	</div>
</form>

{#if toastMsg}
	<div
		class="fixed right-4 bottom-20 z-50 rounded-md border border-border bg-surface px-3 py-2 text-xs lg:bottom-6"
		role="status"
	>
		{toastMsg}
	</div>
{/if}
