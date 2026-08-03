// Importer mapping-pipeline tests on fixture row arrays — pure functions only,
// no DB, no xlsx file. Runs under TZ=America/New_York to prove the epoch
// arithmetic ignores the runtime timezone.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
	buildImport,
	excelSerialToUnixSec,
	parseNotesFiat,
	type SheetRow
} from '../scripts/import-xlsx';

const WALLETS = { Hot: 1, Cold: 2, Exchange: 3 };
const IST_DAYS = 5.5 / 24;

/** unix sec → Excel serial (days since 1899-12-30 UTC). */
const serialOf = (ts: number) => ts / 86400 + 25569;

const T0 = 1753362240; // 2025-07-24 13:04:00 UTC — minute-aligned

function row(
	type: string,
	ts: number,
	wallet: string,
	btc: number,
	inr: number | null,
	extra: Partial<SheetRow> = {}
): SheetRow {
	return {
		'Time (UTC)': serialOf(ts),
		'Time (IST)': serialOf(ts) + IST_DAYS,
		Type: type,
		Wallet: wallet,
		'BTC Amount': btc,
		'INR Value': inr,
		'BTC/INR Rate': 10250951.9,
		'BTC/USD Rate': 107531.22,
		'Transaction ID': null,
		Notes: null,
		...extra
	};
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('excelSerialToUnixSec', () => {
	test('epoch arithmetic: serial days since 1899-12-30 UTC', () => {
		expect(excelSerialToUnixSec(25569)).toBe(0);
		expect(excelSerialToUnixSec(45862.544444444444)).toBe(1753362240);
	});

	test('rounds to the nearest minute', () => {
		expect(excelSerialToUnixSec(serialOf(T0 + 29))).toBe(T0);
		expect(excelSerialToUnixSec(serialOf(T0 + 31))).toBe(T0 + 60);
	});
});

describe('time column validation', () => {
	test('IST−UTC != 5h30m is a hard error', () => {
		const bad = row('BUY', T0, 'Exchange', 0.001, 1000);
		bad['Time (IST)'] = serialOf(T0) + 4.5 / 24;
		const { errors } = buildImport([bad], WALLETS);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('row 2');
		expect(errors[0]).toContain('IST−UTC');
	});

	test('skew inside the ±90s float tolerance passes', () => {
		const ok = row('BUY', T0, 'Exchange', 0.001, 1000);
		ok['Time (IST)'] = serialOf(T0 + 60) + IST_DAYS;
		expect(buildImport([ok], WALLETS).errors).toHaveLength(0);
	});

	test('missing IST column is tolerated (check only rows that have both)', () => {
		const noIst = row('BUY', T0, 'Exchange', 0.001, 1000, { 'Time (IST)': null });
		expect(buildImport([noIst], WALLETS).errors).toHaveLength(0);
	});

	test('missing UTC column is a hard error', () => {
		const noUtc = row('BUY', T0, 'Exchange', 0.001, 1000, { 'Time (UTC)': null });
		expect(buildImport([noUtc], WALLETS).errors[0]).toContain('Time (UTC)');
	});
});

describe('sign/type and wallet validation', () => {
	test('INCOME/BUY must be positive, SELL/SPEND negative', () => {
		const { errors } = buildImport(
			[row('INCOME', T0, 'Hot', -0.01, 1000), row('SELL', T0 + 60, 'Hot', 0.01, 1000)],
			WALLETS
		);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain('INCOME must have a positive');
		expect(errors[1]).toContain('SELL must have a negative');
	});

	test('TRANSFER rows may be either sign', () => {
		const { errors, rows } = buildImport(
			[
				row('TRANSFER', T0, 'Hot', -0.01, null, { 'Transaction ID': 'tx1' }),
				row('TRANSFER', T0, 'Cold', 0.01, null, { 'Transaction ID': 'tx1' })
			],
			WALLETS
		);
		expect(errors).toHaveLength(0);
		expect(rows).toHaveLength(1);
	});

	test('unknown wallet name and unknown type are errors', () => {
		const { errors } = buildImport(
			[row('BUY', T0, 'Ledger', 0.001, 1000), row('AIRDROP', T0, 'Hot', 0.001, 1000)],
			WALLETS
		);
		expect(errors.some((e) => e.includes("unknown wallet 'Ledger'"))).toBe(true);
		expect(errors.some((e) => e.includes("unknown Type 'AIRDROP'"))).toBe(true);
	});

	test('non-TRANSFER row without INR Value is an error', () => {
		const { errors } = buildImport([row('BUY', T0, 'Exchange', 0.001, null)], WALLETS);
		expect(errors[0]).toContain('INR Value');
	});
});

describe('BTC/INR magnitudes', () => {
	test('BTC floats → sats, INR floats → paise, sheet rates carried', () => {
		const { rows } = buildImport([row('SPEND', T0, 'Hot', -0.00171451, 18630.39)], WALLETS);
		const r = rows[0];
		expect(r.amountSats).toBe(171451);
		expect(r.inrValueMinor).toBe(1863039);
		expect(r.walletId).toBe(1);
		expect(r.enteredRate).toBe(10250951.9);
		expect(r.btcUsdRate).toBe(107531.22);
		expect(r.rateSource).toBe('sheet-import');
	});
});

describe('fiat capture from Notes', () => {
	test('USD amount + fx derived from the sheet INR value', () => {
		const f = parseNotesFiat('Contract payment - USD 1200', 10359612);
		expect(f).toEqual({ fiatCurrency: 'USD', fiatAmountMinor: 120000, fxRateToInr: 86.3301 });
	});

	test('mixed USD+INR note captures the USD amount (accepted behavior)', () => {
		const f = parseNotesFiat('Contract payment - USD 1800, Hardware refund - INR 2461', 16144456);
		expect(f.fiatCurrency).toBe('USD');
		expect(f.fiatAmountMinor).toBe(180000);
		expect(f.fxRateToInr).toBeCloseTo(89.6914, 4);
	});

	test('EUR and comma/decimal amounts', () => {
		expect(parseNotesFiat('SeedSigner+ purchase - EUR 179', 1863039).fiatAmountMinor).toBe(17900);
		expect(parseNotesFiat('bonus USD 1,200.50', 12005000).fiatAmountMinor).toBe(120050);
	});

	test('no match → INR with fiatAmountMinor = inrValueMinor and fx 1', () => {
		const f = parseNotesFiat('Exchange purchase', 100071);
		expect(f).toEqual({ fiatCurrency: 'INR', fiatAmountMinor: 100071, fxRateToInr: 1 });
	});
});

describe('TRANSFER merge', () => {
	const txid = '2e3cd2b5';

	test('3-row group (debit + fee row + credit) merges to one row with the fee as Σ|neg| − amount', () => {
		const { rows, errors } = buildImport(
			[
				row('TRANSFER', T0 + 60, 'Hot', -0.02, null, {
					'Transaction ID': txid,
					Notes: 'Transfer to Savings'
				}),
				row('TRANSFER', T0 + 120, 'Hot', -0.00000624, null, {
					'Transaction ID': txid,
					Notes: 'Transfer to Savings - Network Fees'
				}),
				row('TRANSFER', T0, 'Cold', 0.02, null, {
					'Transaction ID': txid,
					Notes: 'Transfer to Savings'
				})
			],
			WALLETS
		);
		expect(errors).toHaveLength(0);
		expect(rows).toHaveLength(1);
		const t = rows[0];
		expect(t.type).toBe('TRANSFER');
		expect(t.fromWalletId).toBe(1);
		expect(t.toWalletId).toBe(2);
		expect(t.amountSats).toBe(2_000_000);
		expect(t.feeSats).toBe(624);
		expect(t.ts).toBe(T0); // earliest of the group
		expect(t.txid).toBe(txid);
		expect(t.inrValueMinor).toBeNull();
		expect(t.importKey).toBe(sha(`TRANSFER|${txid}`));
	});

	test('plain pair with no fee row → feeSats 0', () => {
		const { rows } = buildImport(
			[
				row('TRANSFER', T0, 'Exchange', -0.00039779, null, { 'Transaction ID': 'abc' }),
				row('TRANSFER', T0, 'Hot', 0.00039779, null, { 'Transaction ID': 'abc' })
			],
			WALLETS
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].feeSats).toBe(0);
	});

	test('orphan negative without txid attaches by (source wallet, ≤15 min)', () => {
		const { rows, errors } = buildImport(
			[
				row('TRANSFER', T0, 'Hot', -0.02, null, { 'Transaction ID': 'tx9' }),
				row('TRANSFER', T0, 'Cold', 0.02, null, { 'Transaction ID': 'tx9' }),
				row('TRANSFER', T0 + 840, 'Hot', -0.00000624, null, {
					Notes: 'Transfer to Savings - Network Fees'
				})
			],
			WALLETS
		);
		expect(errors).toHaveLength(0);
		expect(rows).toHaveLength(1);
		expect(rows[0].feeSats).toBe(624);
	});

	test('orphan outside the 15-min window is a hard error listing the row', () => {
		const { errors } = buildImport(
			[
				row('TRANSFER', T0, 'Hot', -0.02, null, { 'Transaction ID': 'tx9' }),
				row('TRANSFER', T0, 'Cold', 0.02, null, { 'Transaction ID': 'tx9' }),
				row('TRANSFER', T0 + 1200, 'Hot', -0.00000624, null)
			],
			WALLETS
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('row 4');
		expect(errors[0]).toContain('matches no transfer group');
	});

	test('orphan from a different source wallet does not attach', () => {
		const { errors } = buildImport(
			[
				row('TRANSFER', T0, 'Hot', -0.02, null, { 'Transaction ID': 'tx9' }),
				row('TRANSFER', T0, 'Cold', 0.02, null, { 'Transaction ID': 'tx9' }),
				row('TRANSFER', T0, 'Exchange', -0.00000624, null)
			],
			WALLETS
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('row 4');
	});

	test('negative rows spanning two source wallets are an error', () => {
		const { errors } = buildImport(
			[
				row('TRANSFER', T0, 'Hot', -0.01, null, { 'Transaction ID': 'txm' }),
				row('TRANSFER', T0, 'Exchange', -0.01, null, { 'Transaction ID': 'txm' }),
				row('TRANSFER', T0, 'Cold', 0.02, null, { 'Transaction ID': 'txm' })
			],
			WALLETS
		);
		expect(errors[0]).toContain('multiple source wallets');
	});

	test('debits smaller than the credited amount are an error', () => {
		const { errors } = buildImport(
			[
				row('TRANSFER', T0, 'Hot', -0.01, null, { 'Transaction ID': 'txn' }),
				row('TRANSFER', T0, 'Cold', 0.02, null, { 'Transaction ID': 'txn' })
			],
			WALLETS
		);
		expect(errors[0]).toContain('debits 1000000 sats < credited 2000000 sats');
	});

	test('group without a positive row / with two positives is an error', () => {
		const { errors } = buildImport(
			[
				row('TRANSFER', T0, 'Hot', -0.01, null, { 'Transaction ID': 'txa' }),
				row('TRANSFER', T0, 'Cold', 0.01, null, { 'Transaction ID': 'txb' }),
				row('TRANSFER', T0, 'Exchange', 0.01, null, { 'Transaction ID': 'txb' })
			],
			WALLETS
		);
		expect(errors.some((e) => e.includes('txa') && e.includes('got 0'))).toBe(true);
		expect(errors.some((e) => e.includes('txb') && e.includes('got 2'))).toBe(true);
	});
});

describe('ordering and import keys', () => {
	test('rows come out in sheet order; merged transfer sits at its first member position', () => {
		const { rows } = buildImport(
			[
				row('BUY', T0, 'Exchange', 0.001, 1000),
				row('TRANSFER', T0 + 60, 'Exchange', -0.001, null, { 'Transaction ID': 'txo' }),
				row('SELL', T0 + 120, 'Hot', -0.0005, 500),
				row('TRANSFER', T0 + 60, 'Hot', 0.001, null, { 'Transaction ID': 'txo' })
			],
			WALLETS
		);
		expect(rows.map((r) => r.type)).toEqual(['BUY', 'TRANSFER', 'SELL']);
		expect(rows[1].sheetRowNums).toEqual([3, 5]);
	});

	test('content key material with duplicate-tuple occurrence suffix', () => {
		const dup = () => row('BUY', T0, 'Exchange', 0.001, 1000);
		const { rows } = buildImport([dup(), dup()], WALLETS);
		const base = `BUY|${T0}|100000|Exchange||100000`;
		expect(rows[0].importKey).toBe(sha(base));
		expect(rows[1].importKey).toBe(sha(`${base}|1`));
		expect(rows[0].importKey).not.toBe(rows[1].importKey);
	});

	test('keys are stable across runs', () => {
		const fixture = [
			row('INCOME', T0, 'Hot', 0.01, 100000, { Notes: 'USD 1200' }),
			row('TRANSFER', T0 + 60, 'Hot', -0.01, null, { 'Transaction ID': 'txs' }),
			row('TRANSFER', T0 + 60, 'Cold', 0.01, null, { 'Transaction ID': 'txs' })
		];
		const a = buildImport(fixture, WALLETS).rows.map((r) => r.importKey);
		const b = buildImport(fixture, WALLETS).rows.map((r) => r.importKey);
		expect(a).toEqual(b);
	});
});
