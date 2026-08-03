// FIFO engine — pure and deterministic: same ledger → byte-identical output.
// No DB, no IO, no clock; issues are collected, never thrown, and the output
// stays well-formed (integer, no NaN) even when the ledger is invalid.
//
// Network fees (TRANSFER, SELL, SPEND) consume sats from the FIFO queue but are
// never taxable events and never deductible — s.115BBH allows only cost of
// acquisition, and moving your own coins is not a "transfer" under s.2(47).

import type {
	DisposalBreakdown,
	DisposalKind,
	LotSlice,
	OpenLot,
	Portfolio,
	Tx,
	TxType,
	ValidationIssue,
	VdaRow
} from '../../types';
import { fyOf } from '../../utils/fy';
import { mulDivRound } from '../../utils/money';

// Acquisitions rank before disposals so a same-second buy+sell always works.
const TYPE_RANK: Record<TxType, number> = { INCOME: 0, BUY: 1, TRANSFER: 2, SELL: 3, SPEND: 4 };

export function computePortfolio(txs: Tx[]): Portfolio {
	const sorted = [...txs].sort(
		(a, b) =>
			a.ts - b.ts ||
			(a.seq ?? 0) - (b.seq ?? 0) ||
			TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
			a.id - b.id
	);

	// Global FIFO queue across all wallets; `head` skips exhausted lots.
	const lots: OpenLot[] = [];
	let head = 0;
	const disposals: DisposalBreakdown[] = [];
	const vdaRows: VdaRow[] = [];
	const walletBalancesSats: Record<number, number> = {};
	const issues: ValidationIssue[] = [];
	let netInvestedMinor = 0;

	const credit = (walletId: number, sats: number) => {
		walletBalancesSats[walletId] = (walletBalancesSats[walletId] ?? 0) + sats;
	};
	const debit = (walletId: number, sats: number, txId: number) => {
		const after = (walletBalancesSats[walletId] = (walletBalancesSats[walletId] ?? 0) - sats);
		if (after < 0)
			issues.push({
				txId,
				code: 'NEGATIVE_WALLET_BALANCE',
				detail: `wallet ${walletId} balance would be ${after} sats`
			});
	};

	// Consume `satsToConsume` from the queue head, pro-rating `considerationMinor`
	// across the resulting slices. Cost per slice: exact remaining cost on full
	// lot exhaustion (no dust), else mulDivRound share. Consideration: mulDivRound
	// share with a running sum; the slice COMPLETING the disposal takes the
	// unallocated remainder, so slice considerations always sum to the total.
	const consumeLots = (
		tx: Tx,
		kind: DisposalKind,
		satsToConsume: number,
		considerationMinor: number
	): LotSlice[] => {
		const slices: LotSlice[] = [];
		let remaining = satsToConsume;
		let allocatedConsideration = 0;
		while (remaining > 0 && head < lots.length) {
			const lot = lots[head];
			const k = Math.min(remaining, lot.remainingSats);
			const costMinor =
				k === lot.remainingSats
					? lot.remainingCostMinor
					: mulDivRound(lot.remainingCostMinor, k, lot.remainingSats);
			lot.remainingSats -= k;
			lot.remainingCostMinor -= costMinor;
			const considerationSlice =
				k === remaining
					? considerationMinor - allocatedConsideration
					: Math.min(
							mulDivRound(considerationMinor, k, satsToConsume),
							considerationMinor - allocatedConsideration
						);
			allocatedConsideration += considerationSlice;
			slices.push({
				lotTxId: lot.lotTxId,
				acquiredTs: lot.acquiredTs,
				satsConsumed: k,
				costMinor,
				considerationMinor: considerationSlice,
				incomeMinor: Math.max(0, considerationSlice - costMinor)
			});
			remaining -= k;
			if (lot.remainingSats === 0) head++;
		}
		if (remaining > 0)
			issues.push({
				txId: tx.id,
				code: 'INSUFFICIENT_LOTS',
				detail: `${kind} needs ${satsToConsume} sats but queue held ${satsToConsume - remaining}; short ${remaining} sats`
			});
		return slices;
	};

	// satsDisposed stays the REQUESTED size even under INSUFFICIENT_LOTS; the
	// slices reflect what was actually consumed.
	const recordDisposal = (
		tx: Tx,
		kind: DisposalKind,
		satsDisposed: number,
		considerationMinor: number
	) => {
		const slices = consumeLots(tx, kind, satsDisposed, considerationMinor);
		const fy = fyOf(tx.ts);
		let totalCostMinor = 0;
		let taxableConservativeMinor = 0;
		for (const s of slices) {
			totalCostMinor += s.costMinor;
			taxableConservativeMinor += s.incomeMinor;
			vdaRows.push({
				disposalTxId: tx.id,
				disposalKind: kind,
				acquiredTs: s.acquiredTs,
				transferTs: tx.ts,
				satsConsumed: s.satsConsumed,
				costMinor: s.costMinor,
				considerationMinor: s.considerationMinor,
				incomeMinor: s.incomeMinor,
				fy
			});
		}
		disposals.push({
			txId: tx.id,
			kind,
			ts: tx.ts,
			fy,
			satsDisposed,
			considerationMinor,
			totalCostMinor,
			taxableConservativeMinor,
			netGainMinor: considerationMinor - totalCostMinor,
			slices
		});
	};

	for (const tx of sorted) {
		switch (tx.type) {
			case 'INCOME':
			case 'BUY': {
				const inr = tx.inrValueMinor ?? 0;
				lots.push({
					lotTxId: tx.id,
					acquiredTs: tx.ts,
					originalSats: tx.amountSats,
					remainingSats: tx.amountSats,
					remainingCostMinor: inr
				});
				credit(tx.walletId!, tx.amountSats);
				netInvestedMinor += inr;
				break;
			}
			case 'SELL':
			case 'SPEND': {
				const inr = tx.inrValueMinor ?? 0;
				// amountSats is what the counterparty received; the network fee is
				// additional sats leaving the wallet, consumed untaxed after the
				// disposal so the disposal's own basis is unaffected by its fee.
				debit(tx.walletId!, tx.amountSats + tx.feeSats, tx.id);
				netInvestedMinor -= inr;
				recordDisposal(tx, tx.type, tx.amountSats, inr);
				if (tx.feeSats > 0) consumeLots(tx, 'FEE', tx.feeSats, 0);
				break;
			}
			case 'TRANSFER': {
				debit(tx.fromWalletId!, tx.amountSats + tx.feeSats, tx.id);
				credit(tx.toWalletId!, tx.amountSats);
				// Moved sats never touch the queue (global FIFO); only the fee does —
				// basis shrinks silently, no disposal, no VDA row.
				if (tx.feeSats > 0) consumeLots(tx, 'FEE', tx.feeSats, 0);
				break;
			}
		}
	}

	const openLots = lots.filter((l) => l.remainingSats > 0);
	const holdingsSats = openLots.reduce((s, l) => s + l.remainingSats, 0);

	return {
		openLots,
		disposals,
		vdaRows,
		walletBalancesSats,
		holdingsSats,
		netInvestedMinor,
		issues
	};
}
