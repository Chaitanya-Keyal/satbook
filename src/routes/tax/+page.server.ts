import { getLedger, getPortfolio } from '$lib/server/ledger';
import { fyOf, fySpan, fyStartYear } from '$lib/utils/fy';
import { mulDivRound } from '$lib/utils/money';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const portfolio = getPortfolio();
	const ledger = getLedger();
	const now = Math.floor(Date.now() / 1000);
	const currentFy = fyOf(now);

	// Selected FY: ?fy= when it parses, else current. An unknown-but-valid label
	// still renders (as an empty FY) so old bookmarks never 404.
	const requested = url.searchParams.get('fy');
	let fy = currentFy;
	if (requested != null) {
		try {
			fyStartYear(requested);
			fy = requested;
		} catch {
			fy = currentFy;
		}
	}

	// FY chips: every FY the ledger touches plus always the current (and the
	// selected, so a deep link always has an active chip). Newest first.
	const chipSet = new Set<string>([currentFy, fy]);
	if (ledger.length > 0)
		for (const label of fySpan(ledger[0].ts, Math.max(ledger[ledger.length - 1].ts, now)))
			chipSet.add(label);
	const chips = [...chipSet].sort((a, b) => fyStartYear(b) - fyStartYear(a));

	// Per-FY aggregates. Conservative = Σ per-(disposal,lot) floored income (the
	// filing number); net = Σ disposal netGain (informational, can be negative).
	const disposals = portfolio.disposals.filter((d) => d.fy === fy);
	const conservativeMinor = portfolio.vdaRows
		.filter((r) => r.fy === fy)
		.reduce((sum, r) => sum + r.incomeMinor, 0);
	const netMinor = disposals.reduce((sum, d) => sum + d.netGainMinor, 0);
	const considerationMinor = disposals.reduce((sum, d) => sum + d.considerationMinor, 0);

	// Remaining lot queue (FY-independent), oldest first, annotated with the
	// source tx's type and effective acquisition rate for the queue viz.
	const txById = new Map(ledger.map((t) => [t.id, t]));
	const queue = portfolio.openLots.map((lot) => {
		const tx = txById.get(lot.lotTxId);
		return {
			lotTxId: lot.lotTxId,
			acquiredTs: lot.acquiredTs,
			originalSats: lot.originalSats,
			remainingSats: lot.remainingSats,
			sourceType: tx?.type ?? null,
			// ₹/BTC = (inrValueMinor/100) / (amountSats/1e8) = inrValueMinor·1e6/sats
			rateInrPerBtc:
				tx != null && tx.inrValueMinor != null && tx.amountSats > 0
					? mulDivRound(tx.inrValueMinor, 1_000_000, tx.amountSats)
					: null
		};
	});

	// Reconciliation: queue total (== portfolio.holdingsSats by construction)
	// vs the sum of wallet balances — these diverge only on a broken ledger.
	const walletTotalSats = Object.values(portfolio.walletBalancesSats).reduce((s, v) => s + v, 0);

	return {
		fy,
		currentFy,
		chips,
		conservativeMinor,
		netMinor,
		deltaMinor: netMinor - conservativeMinor,
		disposalCount: disposals.length,
		considerationMinor,
		disposals,
		queue,
		holdingsSats: portfolio.holdingsSats,
		walletTotalSats,
		now
	};
};
