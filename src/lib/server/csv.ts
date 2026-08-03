// Schedule VDA CSV builder (spec docs/design-architecture.md §8). Pure — no
// DB, no IO — so tests can assert exact byte output. One row per (disposal,
// lot) pair, FY-filtered by date of transfer, sorted by transfer date then
// acquisition date, closed by a TOTAL row. income_inr is the conservative
// max(0, …) figure per row — the TOTAL of that column is the filing number.

import type { VdaRow } from '../types';
import { istDateString } from '../utils/time';

export const VDA_CSV_HEADER =
	'sl_no,date_of_acquisition,date_of_transfer,cost_of_acquisition_inr,consideration_inr,income_inr,disposal_type,disposal_txid,sats_consumed';

/** unix sec UTC → 'DD/MM/YYYY' on the IST calendar (matches FY bucketing). */
function ddmmyyyy(ts: number): string {
	const [y, m, d] = istDateString(ts).split('-');
	return `${d}/${m}/${y}`;
}

/** Integer paise → rupees with exactly 2 decimals ('7750050' → '77500.50'). */
function rupees(minor: number): string {
	const sign = minor < 0 ? '-' : '';
	const abs = Math.abs(minor);
	return `${sign}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, '0')}`;
}

/** RFC-4180 quoting, applied only when a field actually needs it. */
function esc(field: string): string {
	return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * Build the Schedule VDA CSV for one FY. `txidByDisposal` maps a disposal's
 * ledger tx id → its on-chain txid (build it from getLedger()); rows whose
 * disposal has no txid export ''.
 */
export function buildVdaCsv(
	rows: VdaRow[],
	fy: string,
	txidByDisposal?: ReadonlyMap<number, string | null>
): string {
	const inFy = rows
		.filter((r) => r.fy === fy)
		.sort((a, b) => a.transferTs - b.transferTs || a.acquiredTs - b.acquiredTs);

	const lines = [VDA_CSV_HEADER];
	let costSum = 0;
	let considerationSum = 0;
	let incomeSum = 0;
	let satsSum = 0;

	inFy.forEach((r, i) => {
		costSum += r.costMinor;
		considerationSum += r.considerationMinor;
		incomeSum += r.incomeMinor;
		satsSum += r.satsConsumed;
		lines.push(
			[
				String(i + 1),
				ddmmyyyy(r.acquiredTs),
				ddmmyyyy(r.transferTs),
				rupees(r.costMinor),
				rupees(r.considerationMinor),
				rupees(r.incomeMinor),
				r.disposalKind,
				esc(txidByDisposal?.get(r.disposalTxId) ?? ''),
				String(r.satsConsumed)
			].join(',')
		);
	});

	lines.push(
		`TOTAL,,,${rupees(costSum)},${rupees(considerationSum)},${rupees(incomeSum)},,,${satsSum}`
	);
	return lines.join('\n') + '\n';
}
