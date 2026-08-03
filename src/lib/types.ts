// Shared, client-safe types. All BTC quantities are integer satoshis (positive
// magnitudes unless stated), all fiat quantities are integer minor units
// (paise/cents), all timestamps unix seconds UTC.

export type TxType = 'INCOME' | 'BUY' | 'SELL' | 'SPEND' | 'TRANSFER';
export type FiatCurrency = 'INR' | 'USD' | 'EUR';
export type WalletKind = 'hot' | 'cold' | 'exchange';
export type RateSource =
	'manual' | 'live' | 'coindcx-1h' | 'coindcx-1d' | 'coinbase-1d' | 'coingecko-1d' | 'sheet-import';

export interface Wallet {
	id: number;
	name: string;
	kind: WalletKind;
	sortOrder: number;
	archivedAt: number | null;
	createdAt: number;
}

export interface WalletAddress {
	id: number;
	walletId: number;
	label: string | null;
	address: string;
}

export interface Tx {
	id: number;
	type: TxType;
	ts: number;
	seq: number | null;
	walletId: number | null;
	fromWalletId: number | null;
	toWalletId: number | null;
	amountSats: number;
	feeSats: number;
	fiatCurrency: FiatCurrency | null;
	fiatAmountMinor: number | null;
	fxRateToInr: number | null;
	inrValueMinor: number | null;
	feeInrValueMinor: number | null;
	btcUsdRate: number | null;
	enteredRate: number | null;
	rateSource: string | null;
	txid: string | null;
	notes: string | null;
	source: 'manual' | 'import';
}

// A draft transaction being previewed before save (no id yet; id null means "new").
export type DraftTx = Omit<Tx, 'id' | 'source'> & { id: number | null };

// ---------------------------------------------------------------------------
// FIFO engine output shapes
// ---------------------------------------------------------------------------

export interface OpenLot {
	lotTxId: number;
	acquiredTs: number;
	originalSats: number;
	remainingSats: number;
	remainingCostMinor: number;
}

// One (disposal, lot) pairing — also exactly one Schedule VDA row.
export interface LotSlice {
	lotTxId: number;
	acquiredTs: number;
	satsConsumed: number;
	costMinor: number;
	considerationMinor: number;
	incomeMinor: number; // max(0, consideration − cost) — the conservative filing figure
}

export type DisposalKind = 'SELL' | 'SPEND' | 'FEE';

export interface DisposalBreakdown {
	txId: number;
	kind: DisposalKind;
	ts: number;
	fy: string;
	satsDisposed: number;
	considerationMinor: number;
	totalCostMinor: number;
	taxableConservativeMinor: number; // Σ slice incomeMinor
	netGainMinor: number; // consideration − totalCost (can be negative)
	slices: LotSlice[];
}

export interface VdaRow {
	disposalTxId: number;
	disposalKind: DisposalKind;
	acquiredTs: number;
	transferTs: number;
	satsConsumed: number;
	costMinor: number;
	considerationMinor: number;
	incomeMinor: number;
	fy: string;
}

export type IssueCode = 'INSUFFICIENT_LOTS' | 'NEGATIVE_WALLET_BALANCE';

export interface ValidationIssue {
	txId: number;
	code: IssueCode;
	detail: string;
}

export interface Portfolio {
	openLots: OpenLot[];
	disposals: DisposalBreakdown[];
	vdaRows: VdaRow[];
	walletBalancesSats: Record<number, number>;
	holdingsSats: number;
	netInvestedMinor: number;
	issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// API payload shapes
// ---------------------------------------------------------------------------

export interface LivePricePayload {
	btcInr: number;
	btcUsd: number;
	source: string;
	fetchedAt: number;
	stale: boolean;
}

export interface RateLookupPayload {
	btcInr: number | null;
	btcInrSource: RateSource | null;
	fxToInr: number | null;
	fxSource: string | null;
	fxDate: string | null;
}

export interface EsploraOutput {
	index: number;
	address: string | null;
	valueSats: number;
	isOwn: boolean;
	ownWalletId: number | null;
}

export interface EsploraTxPayload {
	txid: string;
	confirmed: boolean;
	blockTime: number | null;
	feeSats: number;
	outputs: EsploraOutput[];
	host: string;
}

export interface ChartPoint {
	date: string; // 'YYYY-MM-DD' (UTC day)
	valueMinor: number | null; // null while candles are backfilling
	investedMinor: number;
}

export interface ChartPayload {
	points: ChartPoint[];
	backfilling: boolean;
}

export interface PreviewPayload {
	issues: ValidationIssue[];
	disposal: DisposalBreakdown | null; // breakdown of the draft when it disposes sats
	ok: boolean;
}
