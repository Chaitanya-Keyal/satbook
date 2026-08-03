// Ledger CRUD over the transactions table. Every write dry-runs the FIFO
// engine on the proposed ledger and is rejected when the result would carry
// issues — the DB never holds a ledger the engine cannot cleanly replay.
// Validation here is primary; the schema CHECK constraints are only a backstop.

import { eq } from 'drizzle-orm';
import type {
	DraftTx,
	FiatCurrency,
	Portfolio,
	PreviewPayload,
	Tx,
	TxType,
	ValidationIssue
} from '../types';
import { formatIstDateShort } from '../utils/time';
import { db, schema } from './db';
import { computePortfolio } from './engine/fifo';

const TX_TYPES: TxType[] = ['INCOME', 'BUY', 'SELL', 'SPEND', 'TRANSFER'];
const FIATS: FiatCurrency[] = ['INR', 'USD', 'EUR'];
const FUTURE_SLACK_SEC = 300;

const nowSec = () => Math.floor(Date.now() / 1000);

export function getLedger(): Tx[] {
	return db
		.select()
		.from(schema.transactions)
		.all()
		.map((r): Tx => ({
			id: r.id,
			type: r.type,
			ts: r.ts,
			seq: r.seq,
			walletId: r.walletId,
			fromWalletId: r.fromWalletId,
			toWalletId: r.toWalletId,
			amountSats: r.amountSats,
			feeSats: r.feeSats,
			fiatCurrency: r.fiatCurrency,
			fiatAmountMinor: r.fiatAmountMinor,
			fxRateToInr: r.fxRateToInr,
			inrValueMinor: r.inrValueMinor,
			feeInrValueMinor: r.feeInrValueMinor,
			btcUsdRate: r.btcUsdRate,
			enteredRate: r.enteredRate,
			rateSource: r.rateSource,
			txid: r.txid,
			notes: r.notes,
			source: r.source
		}))
		.sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0) || a.id - b.id);
}

export function getPortfolio(): Portfolio {
	return computePortfolio(getLedger());
}

export function previewDraft(draft: DraftTx): PreviewPayload {
	const parsed = parseDraft(draft);
	// PreviewPayload has no field for shape errors; a shape-invalid draft simply
	// previews as not-ok (the form's own field validation reports the details).
	if (!parsed.ok) return { issues: [], disposal: null, ok: false };

	const ledger = getLedger();
	const rawId = (draft as { id?: unknown }).id;
	const id = typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : null;
	const existing = id != null ? ledger.find((t) => t.id === id) : undefined;
	const draftId = existing ? existing.id : nextId(ledger);
	const row: Tx = { ...parsed.draft, id: draftId, source: existing?.source ?? 'manual' };
	const proposed = existing ? ledger.map((t) => (t.id === draftId ? row : t)) : [...ledger, row];

	const portfolio = computePortfolio(proposed);
	const disposal = portfolio.disposals.find((d) => d.txId === draftId) ?? null;
	return { issues: portfolio.issues, disposal, ok: portfolio.issues.length === 0 };
}

export function createTx(
	input: unknown
): { ok: true; id: number } | { ok: false; errors: string[] } {
	const parsed = parseDraft(input);
	if (!parsed.ok) return { ok: false, errors: parsed.errors };

	const ledger = getLedger();
	const proposed: Tx[] = [...ledger, { ...parsed.draft, id: nextId(ledger), source: 'manual' }];
	const errors = renderIssues(computePortfolio(proposed).issues, proposed);
	if (errors.length > 0) return { ok: false, errors };

	const now = nowSec();
	const row = db
		.insert(schema.transactions)
		.values({ ...parsed.draft, source: 'manual', createdAt: now, updatedAt: now })
		.returning({ id: schema.transactions.id })
		.get();
	return { ok: true, id: row.id };
}

/**
 * Composite exchange-buy: a BUY into an exchange wallet plus the withdrawal
 * TRANSFER to self custody, validated together and inserted atomically. Errors
 * from the withdrawal leg are prefixed 'withdrawal: '.
 */
export function createTxPair(
	buyInput: unknown,
	transferInput: unknown
): { ok: true; buyId: number; transferId: number } | { ok: false; errors: string[] } {
	const buyParsed = parseDraft(buyInput);
	const transferParsed = parseDraft(transferInput);
	const shapeErrors = [
		...(buyParsed.ok ? [] : buyParsed.errors),
		...(transferParsed.ok ? [] : transferParsed.errors.map((e) => `withdrawal: ${e}`))
	];
	if (buyParsed.ok && buyParsed.draft.type !== 'BUY')
		shapeErrors.push('the first leg of a pair must be a BUY');
	if (transferParsed.ok && transferParsed.draft.type !== 'TRANSFER')
		shapeErrors.push('withdrawal: the second leg of a pair must be a TRANSFER');
	if (shapeErrors.length > 0 || !buyParsed.ok || !transferParsed.ok)
		return { ok: false, errors: shapeErrors };

	const ledger = getLedger();
	const buyDraftId = nextId(ledger);
	const transferDraftId = buyDraftId + 1;
	const proposed: Tx[] = [
		...ledger,
		{ ...buyParsed.draft, id: buyDraftId, source: 'manual' },
		{ ...transferParsed.draft, id: transferDraftId, source: 'manual' }
	];
	const issues = computePortfolio(proposed).issues;
	if (issues.length > 0) {
		// renderIssues maps 1:1 over issues — prefix the ones on the withdrawal leg.
		const errors = renderIssues(issues, proposed).map((msg, i) =>
			issues[i].txId === transferDraftId ? `withdrawal: ${msg}` : msg
		);
		return { ok: false, errors };
	}

	const now = nowSec();
	return db.transaction((tdb) => {
		const buyRow = tdb
			.insert(schema.transactions)
			.values({ ...buyParsed.draft, source: 'manual', createdAt: now, updatedAt: now })
			.returning({ id: schema.transactions.id })
			.get();
		const transferRow = tdb
			.insert(schema.transactions)
			.values({ ...transferParsed.draft, source: 'manual', createdAt: now, updatedAt: now })
			.returning({ id: schema.transactions.id })
			.get();
		return { ok: true as const, buyId: buyRow.id, transferId: transferRow.id };
	});
}

export function updateTx(
	id: number,
	input: unknown
): { ok: true } | { ok: false; errors: string[] } {
	const ledger = getLedger();
	const existing = ledger.find((t) => t.id === id);
	if (!existing) return { ok: false, errors: [`transaction ${id} not found`] };

	const parsed = parseDraft(input);
	if (!parsed.ok) return { ok: false, errors: parsed.errors };

	const proposed = ledger.map((t) =>
		t.id === id ? { ...parsed.draft, id, source: existing.source } : t
	);
	const errors = renderIssues(computePortfolio(proposed).issues, proposed);
	if (errors.length > 0) return { ok: false, errors };

	db.update(schema.transactions)
		.set({ ...parsed.draft, updatedAt: nowSec() })
		.where(eq(schema.transactions.id, id))
		.run();
	return { ok: true };
}

export function deleteTx(id: number): { ok: true } | { ok: false; errors: string[] } {
	const ledger = getLedger();
	if (!ledger.some((t) => t.id === id))
		return { ok: false, errors: [`transaction ${id} not found`] };

	const proposed = ledger.filter((t) => t.id !== id);
	const errors = renderIssues(computePortfolio(proposed).issues, proposed);
	if (errors.length > 0) return { ok: false, errors };

	db.delete(schema.transactions).where(eq(schema.transactions.id, id)).run();
	return { ok: true };
}

// --- validation ------------------------------------------------------------

type ParsedDraft = Omit<DraftTx, 'id'>;
type ParseResult = { ok: true; draft: ParsedDraft } | { ok: false; errors: string[] };

function parseDraft(input: unknown): ParseResult {
	if (typeof input !== 'object' || input === null)
		return { ok: false, errors: ['request body must be a JSON object'] };
	const o = input as Record<string, unknown>;
	const errors: string[] = [];

	const typeRaw = typeof o.type === 'string' ? o.type.toUpperCase() : '';
	if (!TX_TYPES.includes(typeRaw as TxType))
		return { ok: false, errors: [`type must be one of ${TX_TYPES.join(', ')}`] };
	const type = typeRaw as TxType;

	const ts = toInt(o.ts);
	if (ts == null || ts <= 0) errors.push('ts must be a positive unix-seconds integer');
	else if (ts > nowSec() + FUTURE_SLACK_SEC) errors.push('timestamp is in the future');

	const seq = isNullish(o.seq) ? null : toInt(o.seq);
	if (!isNullish(o.seq) && seq == null) errors.push('seq must be an integer when set');

	const amountSats = toInt(o.amountSats);
	if (amountSats == null || amountSats <= 0)
		errors.push('amountSats must be a positive integer (satoshis)');

	let feeSats = isNullish(o.feeSats) ? 0 : toInt(o.feeSats);
	if (feeSats == null || feeSats < 0) {
		errors.push('feeSats must be a non-negative integer (satoshis)');
		feeSats = 0;
	}

	// Fields not meaningful for the type are normalized to null (a stale field
	// left over from a type switch in the form must not block the save).
	let walletId: number | null = null;
	let fromWalletId: number | null = null;
	let toWalletId: number | null = null;
	let fiatCurrency: FiatCurrency | null = null;
	let fiatAmountMinor: number | null = null;
	let fxRateToInr: number | null = null;
	let inrValueMinor: number | null = null;
	let feeInrValueMinor: number | null = null;

	if (type === 'TRANSFER') {
		fromWalletId = toInt(o.fromWalletId);
		toWalletId = toInt(o.toWalletId);
		if (fromWalletId == null) errors.push('TRANSFER requires fromWalletId');
		if (toWalletId == null) errors.push('TRANSFER requires toWalletId');
		if (fromWalletId != null && fromWalletId === toWalletId)
			errors.push('TRANSFER source and destination wallets must differ');
	} else {
		walletId = toInt(o.walletId);
		if (walletId == null) errors.push(`${type} requires walletId`);
		if (feeSats !== 0 && type !== 'SELL' && type !== 'SPEND')
			errors.push(`${type} must have feeSats = 0 (fees exist on TRANSFER, SELL and SPEND)`);
		const cur = typeof o.fiatCurrency === 'string' ? o.fiatCurrency.toUpperCase() : '';
		if (FIATS.includes(cur as FiatCurrency)) fiatCurrency = cur as FiatCurrency;
		else errors.push(`${type} requires fiatCurrency (INR, USD or EUR)`);
		fiatAmountMinor = toInt(o.fiatAmountMinor);
		if (fiatAmountMinor == null || fiatAmountMinor < 0)
			errors.push(`${type} requires fiatAmountMinor ≥ 0 (minor units)`);
		fxRateToInr = toNum(o.fxRateToInr);
		if (fxRateToInr == null || fxRateToInr <= 0) errors.push(`${type} requires fxRateToInr > 0`);
		inrValueMinor = toInt(o.inrValueMinor);
		if (inrValueMinor == null || inrValueMinor < 0)
			errors.push(`${type} requires inrValueMinor ≥ 0 (paise)`);
	}

	// Fee FMV rides along on the fee-bearing types (TRANSFER/SELL/SPEND); it is
	// informational display data, never part of any tax computation, so feeSats
	// > 0 with feeInrValueMinor absent is fine.
	if (type === 'TRANSFER' || type === 'SELL' || type === 'SPEND') {
		if (!isNullish(o.feeInrValueMinor)) {
			feeInrValueMinor = toInt(o.feeInrValueMinor);
			if (feeInrValueMinor == null || feeInrValueMinor < 0) {
				errors.push('feeInrValueMinor must be a non-negative integer (paise) when set');
				feeInrValueMinor = null;
			}
		}
	}

	for (const wid of [walletId, fromWalletId, toWalletId]) {
		if (wid == null) continue;
		const w = db.select().from(schema.wallets).where(eq(schema.wallets.id, wid)).get();
		if (!w) errors.push(`wallet ${wid} does not exist`);
		else if (w.archivedAt != null) errors.push(`wallet "${w.name}" is archived`);
	}

	const btcUsdRate = isNullish(o.btcUsdRate) ? null : toNum(o.btcUsdRate);
	if (!isNullish(o.btcUsdRate) && btcUsdRate == null)
		errors.push('btcUsdRate must be a number when set');
	const enteredRate = isNullish(o.enteredRate) ? null : toNum(o.enteredRate);
	if (!isNullish(o.enteredRate) && enteredRate == null)
		errors.push('enteredRate must be a number when set');

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		draft: {
			type,
			ts: ts!,
			seq,
			walletId,
			fromWalletId,
			toWalletId,
			amountSats: amountSats!,
			feeSats,
			fiatCurrency,
			fiatAmountMinor,
			fxRateToInr,
			inrValueMinor,
			feeInrValueMinor,
			btcUsdRate,
			enteredRate,
			rateSource: toStr(o.rateSource),
			txid: toStr(o.txid),
			notes: toStr(o.notes)
		}
	};
}

// --- engine-issue rendering ------------------------------------------------

function renderIssues(issues: ValidationIssue[], ledger: Tx[]): string[] {
	if (issues.length === 0) return [];
	const names = new Map(
		db
			.select()
			.from(schema.wallets)
			.all()
			.map((w) => [w.id, w.name])
	);
	const nameOf = (id: number | null) => (id != null && names.get(id)) || `wallet ${id}`;

	return issues.map((issue) => {
		const tx = ledger.find((t) => t.id === issue.txId);
		if (!tx) return issue.detail;
		const when = formatIstDateShort(tx.ts);
		if (issue.code === 'NEGATIVE_WALLET_BALANCE') {
			const m = /wallet (\d+) balance would be (-?\d+) sats/.exec(issue.detail);
			const wname = m ? nameOf(parseInt(m[1], 10)) : nameOf(tx.walletId ?? tx.fromWalletId);
			const balance = m ? `${m[2]} sats` : 'negative';
			return `${tx.type} on ${when} would take wallet "${wname}" below zero (balance ${balance})`;
		}
		// INSUFFICIENT_LOTS — detail reads '<kind> needs N sats but queue held M;
		// short K sats'; strip the leading kind word (the tx type already says it).
		const wname = nameOf(tx.walletId ?? tx.fromWalletId);
		return `${tx.type} on ${when} in "${wname}": ${issue.detail.replace(/^\S+ /, '')}`;
	});
}

// --- small coercers --------------------------------------------------------

const isNullish = (v: unknown) => v === null || v === undefined || v === '';

function nextId(ledger: Tx[]): number {
	return ledger.reduce((m, t) => Math.max(m, t.id), 0) + 1;
}

function toInt(v: unknown): number | null {
	if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
	if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) {
		const n = parseInt(v.trim(), 10);
		return Number.isSafeInteger(n) ? n : null;
	}
	return null;
}

function toNum(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function toStr(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const s = v.trim();
	return s === '' ? null : s;
}
