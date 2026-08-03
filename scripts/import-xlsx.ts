// One-time Excel importer: bun scripts/import-xlsx.ts <path.xlsx> [--commit] [--force]
// Default is a dry-run that prints the planned rows + a full engine
// reconciliation report. The mapping pipeline is pure and exported for tests;
// DB and rate-service modules are imported dynamically inside main() so that
// importing this module has no side effects.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { computePortfolio } from '../src/lib/server/engine/fifo';
import type { FiatCurrency, Tx, TxType } from '../src/lib/types';
import {
	btcToSats,
	formatInr,
	formatSats,
	mulDivRound,
	SATS_PER_BTC,
	toMinor
} from '../src/lib/utils/money';
import { formatIstFull } from '../src/lib/utils/time';

// Excel serials count days since 1899-12-30 UTC; 25569 days to the unix epoch.
const EXCEL_EPOCH_DAYS = 25569;
const IST_OFFSET_SEC = 19800;
const IST_TOLERANCE_SEC = 90;
const ORPHAN_WINDOW_SEC = 900;
const FIAT_NOTES_RE = /\b(USD|EUR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i;

const TX_TYPES: readonly TxType[] = ['INCOME', 'BUY', 'SELL', 'SPEND', 'TRANSFER'];

export type SheetColumn =
	| 'Time (UTC)'
	| 'Time (IST)'
	| 'Type'
	| 'Wallet'
	| 'BTC Amount'
	| 'INR Value'
	| 'BTC/INR Rate'
	| 'BTC/USD Rate'
	| 'Transaction ID'
	| 'Notes';

export type SheetRow = Partial<Record<SheetColumn, string | number | null>>;

// A fully-mapped ledger row ready to insert (walletName kept for keys/report).
export interface ImportRow {
	sheetRowNums: number[];
	type: TxType;
	ts: number;
	walletId: number | null;
	walletName: string | null;
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
	importKey: string;
}

interface ParsedRow {
	sheetRowNum: number; // 1-based including the header row
	type: TxType;
	ts: number;
	walletName: string;
	signedBtc: number;
	sats: number;
	inrValueMinor: number | null;
	btcInrRate: number | null;
	btcUsdRate: number | null;
	txid: string | null;
	notes: string | null;
}

/** Raw Excel date serial (days since 1899-12-30 UTC) → unix sec, rounded to the minute. */
export function excelSerialToUnixSec(serial: number): number {
	return Math.round(((serial - EXCEL_EPOCH_DAYS) * 86400) / 60) * 60;
}

/** Fiat capture from Notes ('… - USD 1200'); no match → INR at fx 1. */
export function parseNotesFiat(
	notes: string | null,
	inrValueMinor: number
): { fiatCurrency: FiatCurrency; fiatAmountMinor: number; fxRateToInr: number } {
	const m = notes ? FIAT_NOTES_RE.exec(notes) : null;
	if (m) {
		const fiatAmountMinor = toMinor(parseFloat(m[2].replace(/,/g, '')));
		if (fiatAmountMinor <= 0)
			return { fiatCurrency: 'INR', fiatAmountMinor: inrValueMinor, fxRateToInr: 1 };
		return {
			fiatCurrency: m[1].toUpperCase() as FiatCurrency,
			fiatAmountMinor,
			fxRateToInr: inrValueMinor / fiatAmountMinor
		};
	}
	return { fiatCurrency: 'INR', fiatAmountMinor: inrValueMinor, fxRateToInr: 1 };
}

function sha256Hex(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}

function numOrNull(v: string | number | null | undefined): number | null {
	return typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null;
}

function strOrNull(v: string | number | null | undefined): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t === '' ? null : t;
}

/**
 * Pure mapping pipeline: sheet rows → insertable ledger rows in sheet order
 * (merged transfers sit at their earliest member's position). All problems are
 * collected into `errors`; any error means the import must not proceed.
 */
export function buildImport(
	sheetRows: SheetRow[],
	walletIdsByName: Record<string, number>
): { rows: ImportRow[]; errors: string[] } {
	const errors: string[] = [];
	const parsed: ParsedRow[] = [];

	sheetRows.forEach((raw, i) => {
		const rowNum = i + 2; // row 1 is the header
		const fail = (msg: string) => errors.push(`row ${rowNum}: ${msg}`);

		const type = raw['Type'];
		if (typeof type !== 'string' || !TX_TYPES.includes(type as TxType)) {
			fail(`unknown Type '${type}'`);
			return;
		}
		const utc = raw['Time (UTC)'];
		if (typeof utc !== 'number' || !Number.isFinite(utc)) {
			fail(`missing/non-numeric 'Time (UTC)' (${utc})`);
			return;
		}
		const ist = raw['Time (IST)'];
		if (typeof ist === 'number' && Number.isFinite(ist)) {
			const diffSec = (ist - utc) * 86400;
			if (Math.abs(diffSec - IST_OFFSET_SEC) > IST_TOLERANCE_SEC) {
				fail(
					`IST−UTC is ${Math.round(diffSec)}s, expected ${IST_OFFSET_SEC}±${IST_TOLERANCE_SEC}s`
				);
				return;
			}
		}
		const ts = excelSerialToUnixSec(utc);

		const btc = raw['BTC Amount'];
		if (typeof btc !== 'number' || !Number.isFinite(btc) || btc === 0) {
			fail(`missing/zero 'BTC Amount' (${btc})`);
			return;
		}
		if ((type === 'INCOME' || type === 'BUY') && btc < 0) {
			fail(`${type} must have a positive BTC Amount, got ${btc}`);
			return;
		}
		if ((type === 'SELL' || type === 'SPEND') && btc > 0) {
			fail(`${type} must have a negative BTC Amount, got ${btc}`);
			return;
		}
		const sats = btcToSats(Math.abs(btc).toFixed(8));

		const walletName = raw['Wallet'];
		if (typeof walletName !== 'string' || walletIdsByName[walletName] == null) {
			fail(`unknown wallet '${walletName}'`);
			return;
		}

		let inrValueMinor: number | null = null;
		if (type !== 'TRANSFER') {
			const inr = raw['INR Value'];
			if (typeof inr !== 'number' || !Number.isFinite(inr)) {
				fail(`missing/non-numeric 'INR Value' (${inr}) for ${type}`);
				return;
			}
			inrValueMinor = toMinor(Math.abs(inr));
		}

		parsed.push({
			sheetRowNum: rowNum,
			type: type as TxType,
			ts,
			walletName,
			signedBtc: btc,
			sats,
			inrValueMinor,
			btcInrRate: numOrNull(raw['BTC/INR Rate']),
			btcUsdRate: numOrNull(raw['BTC/USD Rate']),
			txid: strOrNull(raw['Transaction ID']),
			notes: strOrNull(raw['Notes'])
		});
	});

	// ---- TRANSFER grouping ------------------------------------------------
	const groups = new Map<string, ParsedRow[]>();
	const orphans: ParsedRow[] = [];
	for (const r of parsed) {
		if (r.type !== 'TRANSFER') continue;
		if (r.txid) {
			const g = groups.get(r.txid) ?? [];
			g.push(r);
			groups.set(r.txid, g);
		} else orphans.push(r);
	}

	// Orphan negatives (no txid, e.g. a separate fee row) attach to the nearest
	// group with the same source wallet within ±15 min; anything else is fatal.
	for (const o of orphans) {
		if (o.signedBtc >= 0) {
			errors.push(`row ${o.sheetRowNum}: positive TRANSFER row has no Transaction ID`);
			continue;
		}
		let best: { members: ParsedRow[]; diff: number } | null = null;
		for (const members of groups.values()) {
			const negs = members.filter((m) => m.signedBtc < 0);
			if (negs.length === 0 || !negs.some((n) => n.walletName === o.walletName)) continue;
			const diff = Math.min(...members.map((m) => Math.abs(m.ts - o.ts)));
			if (diff <= ORPHAN_WINDOW_SEC && (!best || diff < best.diff)) best = { members, diff };
		}
		if (best) best.members.push(o);
		else
			errors.push(
				`row ${o.sheetRowNum}: TRANSFER row without txid matches no transfer group ` +
					`(wallet ${o.walletName}, ±${ORPHAN_WINDOW_SEC / 60} min)`
			);
	}

	const mergedByTxid = new Map<string, ImportRow>();
	for (const [txid, members] of groups) {
		const rowsRef = members
			.map((m) => m.sheetRowNum)
			.sort((a, b) => a - b)
			.join(',');
		const fail = (msg: string) => errors.push(`transfer ${txid} (rows ${rowsRef}): ${msg}`);
		const positives = members.filter((m) => m.signedBtc > 0);
		const negatives = members.filter((m) => m.signedBtc < 0);
		if (positives.length !== 1) {
			fail(`expected exactly 1 positive row, got ${positives.length}`);
			continue;
		}
		if (negatives.length === 0) {
			fail('no negative (source) rows');
			continue;
		}
		const fromNames = [...new Set(negatives.map((n) => n.walletName))];
		if (fromNames.length > 1) {
			fail(`negative rows span multiple source wallets: ${fromNames.join(', ')}`);
			continue;
		}
		const pos = positives[0];
		if (fromNames[0] === pos.walletName) {
			fail(`source and destination are both '${pos.walletName}'`);
			continue;
		}
		const totalNegSats = negatives.reduce((s, n) => s + n.sats, 0);
		const feeSats = totalNegSats - pos.sats;
		if (feeSats < 0) {
			fail(`debits ${totalNegSats} sats < credited ${pos.sats} sats`);
			continue;
		}
		mergedByTxid.set(txid, {
			sheetRowNums: members.map((m) => m.sheetRowNum).sort((a, b) => a - b),
			type: 'TRANSFER',
			ts: Math.min(...members.map((m) => m.ts)),
			walletId: null,
			walletName: null,
			fromWalletId: walletIdsByName[fromNames[0]],
			toWalletId: walletIdsByName[pos.walletName],
			amountSats: pos.sats,
			feeSats,
			fiatCurrency: null,
			fiatAmountMinor: null,
			fxRateToInr: null,
			inrValueMinor: null,
			feeInrValueMinor: null, // backfilled via rate service when feeSats > 0
			btcUsdRate: null,
			enteredRate: null,
			rateSource: null,
			txid,
			notes: pos.notes ?? negatives[0].notes,
			importKey: ''
		});
	}

	// ---- Emit in sheet order (merged transfer at first member position) ----
	const rows: ImportRow[] = [];
	const emittedTxids = new Set<string>();
	for (const r of parsed) {
		if (r.type === 'TRANSFER') {
			if (!r.txid || emittedTxids.has(r.txid)) continue;
			emittedTxids.add(r.txid);
			const merged = mergedByTxid.get(r.txid);
			if (merged) rows.push(merged);
			continue;
		}
		const fiat = parseNotesFiat(r.notes, r.inrValueMinor!);
		rows.push({
			sheetRowNums: [r.sheetRowNum],
			type: r.type,
			ts: r.ts,
			walletId: walletIdsByName[r.walletName],
			walletName: r.walletName,
			fromWalletId: null,
			toWalletId: null,
			amountSats: r.sats,
			feeSats: 0,
			fiatCurrency: fiat.fiatCurrency,
			fiatAmountMinor: fiat.fiatAmountMinor,
			fxRateToInr: fiat.fxRateToInr,
			inrValueMinor: r.inrValueMinor,
			feeInrValueMinor: null,
			btcUsdRate: r.btcUsdRate,
			enteredRate: r.btcInrRate,
			rateSource: 'sheet-import',
			txid: r.txid,
			notes: r.notes,
			importKey: ''
		});
	}

	// ---- Idempotency keys (content key + per-duplicate occurrence suffix) --
	const seen = new Map<string, number>();
	for (const row of rows) {
		const material =
			row.type === 'TRANSFER'
				? `TRANSFER|${row.txid}`
				: `${row.type}|${row.ts}|${row.amountSats}|${row.walletName}|${row.txid ?? ''}|${row.inrValueMinor ?? ''}`;
		const n = seen.get(material) ?? 0;
		seen.set(material, n + 1);
		row.importKey = sha256Hex(n === 0 ? material : `${material}|${n}`);
	}

	return { rows, errors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const commit = args.includes('--commit');
	const force = args.includes('--force');
	const xlsxPath = args.find((a) => !a.startsWith('--'));
	if (!xlsxPath) {
		console.error('usage: bun scripts/import-xlsx.ts <path.xlsx> [--commit] [--force]');
		process.exit(1);
	}

	const wb = XLSX.read(readFileSync(xlsxPath), { cellDates: false });
	if (wb.Workbook?.WBProps?.date1904) {
		console.error('workbook uses the 1904 date system — serial conversion assumes 1900; aborting');
		process.exit(1);
	}
	const ws = wb.Sheets['Transactions'];
	if (!ws) {
		console.error(`sheet 'Transactions' not found (sheets: ${wb.SheetNames.join(', ')})`);
		process.exit(1);
	}
	const sheetRows = XLSX.utils.sheet_to_json<SheetRow>(ws, { raw: true, defval: null });

	// Deferred so that importing this module (tests) never touches the DB.
	const { db, schema } = await import('../src/lib/server/db');
	const { getBtcInrAt } = await import('../src/lib/server/rates');
	const { eq } = await import('drizzle-orm');

	const existingImportRows = db
		.select({
			id: schema.transactions.id,
			createdAt: schema.transactions.createdAt,
			updatedAt: schema.transactions.updatedAt
		})
		.from(schema.transactions)
		.where(eq(schema.transactions.source, 'import'))
		.all();
	if (existingImportRows.length > 0 && !force) {
		console.error(
			`${existingImportRows.length} rows with source='import' already exist — ` +
				're-run with --force to delete and replace them'
		);
		process.exit(1);
	}
	// --force replaces import rows with fresh sheet values; refuse when any of
	// them were edited in the app, or those corrections would be silently lost.
	const editedImportRows = existingImportRows.filter((r) => r.updatedAt !== r.createdAt);
	if (force && editedImportRows.length > 0) {
		console.error(
			`refusing --force: ${editedImportRows.length} imported row(s) were edited in the app ` +
				`(ids ${editedImportRows.map((r) => r.id).join(', ')}). ` +
				'Revert or delete them in the app first, or update the sheet to match.'
		);
		process.exit(1);
	}

	// Wallet map; missing seed wallets get explicit provisional ids so the dry
	// run writes nothing and a commit inserts exactly what was reported.
	const walletRows = db.select().from(schema.wallets).all();
	const walletIds: Record<string, number> = {};
	const walletNamesById: Record<number, string> = {};
	for (const w of walletRows) {
		walletIds[w.name] = w.id;
		walletNamesById[w.id] = w.name;
	}
	let nextWalletId = Math.max(0, ...walletRows.map((w) => w.id)) + 1;
	const walletsToCreate: {
		id: number;
		name: string;
		kind: 'hot' | 'cold' | 'exchange';
		sortOrder: number;
	}[] = [];
	// Wallets are created from the sheet's own Wallet column (kind defaults to
	// 'hot' — adjust kinds in the app's Wallets screen after importing).
	const sheetWalletNames = [
		...new Set(
			sheetRows
				.map((r) => r['Wallet'])
				.filter((w): w is string => typeof w === 'string' && w.trim() !== '')
		)
	];
	sheetWalletNames.forEach((name, i) => {
		if (walletIds[name] == null) {
			const id = nextWalletId++;
			walletIds[name] = id;
			walletNamesById[id] = name;
			walletsToCreate.push({ id, name, kind: 'hot', sortOrder: i });
		}
	});

	const { rows: importRows, errors } = buildImport(sheetRows, walletIds);
	if (errors.length > 0) {
		console.error(`${errors.length} mapping error(s):`);
		for (const e of errors) console.error(`  - ${e}`);
		process.exit(1);
	}

	// Fee INR backfill via the rate service (warn + null on failure).
	const warnings: string[] = [];
	for (const row of importRows) {
		if (row.type !== 'TRANSFER' || row.feeSats === 0) continue;
		try {
			const hit = await getBtcInrAt(row.ts);
			if (hit == null) throw new Error('all providers returned null');
			row.feeInrValueMinor = mulDivRound(Math.round(hit.rate * 100), row.feeSats, SATS_PER_BTC);
		} catch (e) {
			warnings.push(
				`fee INR backfill failed for transfer ${row.txid} at ${formatIstFull(row.ts)} ` +
					`(${e instanceof Error ? e.message : e}) — storing null`
			);
		}
	}

	// Proposed ledger = kept existing rows + new rows with provisional ids.
	const keptExisting = db
		.select()
		.from(schema.transactions)
		.all()
		.filter((t) => !(force && t.source === 'import'));
	const maxTxId = Math.max(0, ...keptExisting.map((t) => t.id));
	const proposed: Tx[] = [
		...keptExisting,
		...importRows.map((r, i) => ({
			id: maxTxId + 1 + i,
			type: r.type,
			ts: r.ts,
			seq: null,
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
			source: 'import' as const
		}))
	];
	const portfolio = computePortfolio(proposed);

	// ---- Report -----------------------------------------------------------
	const transfers = importRows.filter((r) => r.type === 'TRANSFER');
	console.log(`\nbtc-manager import — ${xlsxPath} (${commit ? 'COMMIT' : 'dry-run'})`);
	console.log(
		`sheet rows: ${sheetRows.length} → ${importRows.length - transfers.length} non-transfer + ` +
			`${transfers.length} merged transfers = ${importRows.length} ledger rows; ` +
			`existing rows kept: ${keptExisting.length}` +
			(force && existingImportRows.length > 0
				? `; replacing ${existingImportRows.length} prior import rows`
				: '')
	);

	console.log('\nplanned rows:');
	importRows.forEach((r, i) => {
		const where =
			r.type === 'TRANSFER'
				? `${walletNamesById[r.fromWalletId!]} → ${walletNamesById[r.toWalletId!]}`
				: r.walletName;
		const fee = r.feeSats > 0 ? ` fee ${formatSats(r.feeSats)}` : '';
		const inr =
			r.inrValueMinor != null
				? ` ${formatInr(r.inrValueMinor, { paise: 'always' })}` +
					(r.fiatCurrency !== 'INR' ? ` (${r.fiatCurrency} ${r.fiatAmountMinor! / 100})` : '')
				: r.feeInrValueMinor != null
					? ` feeINR ${formatInr(r.feeInrValueMinor, { paise: 'always' })}`
					: '';
		console.log(
			`  #${(i + 1).toString().padStart(2)} ${r.type.padEnd(8)} ${formatIstFull(r.ts)}  ` +
				`${where}  ${formatSats(r.amountSats)} sats${fee}${inr}`
		);
	});

	if (walletsToCreate.length > 0)
		console.log(
			`\nwallets to create: ${walletsToCreate.map((w) => `${w.name}(${w.kind})`).join(', ')}`
		);
	for (const w of warnings) console.log(`WARNING: ${w}`);

	console.log('\nreconciliation:');
	const balanceIds = Object.keys(portfolio.walletBalancesSats).map(Number);
	for (const id of balanceIds.sort((a, b) => a - b))
		console.log(
			`  ${(walletNamesById[id] ?? `wallet ${id}`).padEnd(10)} ${formatSats(portfolio.walletBalancesSats[id])} sats`
		);
	console.log(`  holdings     ${formatSats(portfolio.holdingsSats)} sats`);
	console.log(`  net invested ${formatInr(portfolio.netInvestedMinor, { paise: 'always' })}`);

	const fyAgg = new Map<string, { conservative: number; net: number }>();
	for (const d of portfolio.disposals) {
		const a = fyAgg.get(d.fy) ?? { conservative: 0, net: 0 };
		a.conservative += d.taxableConservativeMinor;
		a.net += d.netGainMinor;
		fyAgg.set(d.fy, a);
	}
	for (const fy of [...fyAgg.keys()].sort()) {
		const a = fyAgg.get(fy)!;
		console.log(
			`  ${fy}: conservative ${formatInr(a.conservative, { paise: 'always' })}  ` +
				`net ${formatInr(a.net, { paise: 'always' })}`
		);
	}

	if (portfolio.issues.length > 0) {
		console.log(`\n${portfolio.issues.length} validation issue(s):`);
		for (const i of portfolio.issues) console.log(`  - tx ${i.txId} ${i.code}: ${i.detail}`);
	} else console.log('\nvalidation issues: none');

	if (!commit) {
		console.log('\ndry-run — nothing written. Re-run with --commit to write.');
		return;
	}
	if (portfolio.issues.length > 0) {
		console.error('\nrefusing to commit: resolve the validation issues above first');
		process.exit(1);
	}

	const now = Math.floor(Date.now() / 1000);
	db.transaction((tx) => {
		for (const w of walletsToCreate)
			tx.insert(schema.wallets)
				.values({ id: w.id, name: w.name, kind: w.kind, sortOrder: w.sortOrder, createdAt: now })
				.run();
		if (force) tx.delete(schema.transactions).where(eq(schema.transactions.source, 'import')).run();
		for (const r of importRows)
			tx.insert(schema.transactions)
				.values({
					type: r.type,
					ts: r.ts,
					seq: null,
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
					source: 'import',
					importKey: r.importKey,
					createdAt: now,
					updatedAt: now
				})
				.run();
	});
	console.log(
		`\ncommitted ${importRows.length} rows` +
			(walletsToCreate.length > 0 ? `, created ${walletsToCreate.length} wallets` : '') +
			(force && existingImportRows.length > 0
				? `, replaced ${existingImportRows.length} prior import rows`
				: '')
	);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
