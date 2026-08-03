import { db, schema } from '$lib/server/db';
import { getLedger, getPortfolio } from '$lib/server/ledger';
import { getLivePrice } from '$lib/server/rates';
import type { LivePricePayload, TxType } from '$lib/types';
import { fyOf } from '$lib/utils/fy';
import type { PageServerLoad } from './$types';

interface RecentRow {
	id: number;
	type: TxType;
	ts: number;
	amountSats: number;
	inrValueMinor: number | null;
	notes: string | null;
	walletName: string | null;
	fromName: string | null;
	toName: string | null;
}

export const load: PageServerLoad = async () => {
	const portfolio = getPortfolio();
	const ledger = getLedger();

	// Never block the dashboard on price failure; null means no price row has
	// EVER existed (getLivePrice falls back to the last cached row as stale).
	let price: LivePricePayload | null = null;
	try {
		price = await getLivePrice();
	} catch {
		price = null;
	}

	const walletRows = db.select().from(schema.wallets).all();
	const names = new Map(walletRows.map((w) => [w.id, w.name]));
	const wallets = walletRows
		.filter((w) => w.archivedAt == null)
		.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
		.map((w) => ({ id: w.id, name: w.name, sats: portfolio.walletBalancesSats[w.id] ?? 0 }));

	const recent: RecentRow[] = ledger
		.slice(-6)
		.reverse()
		.map((t) => ({
			id: t.id,
			type: t.type,
			ts: t.ts,
			amountSats: t.amountSats,
			inrValueMinor: t.inrValueMinor,
			notes: t.notes,
			walletName: t.walletId != null ? (names.get(t.walletId) ?? null) : null,
			fromName: t.fromWalletId != null ? (names.get(t.fromWalletId) ?? null) : null,
			toName: t.toWalletId != null ? (names.get(t.toWalletId) ?? null) : null
		}));

	const now = Math.floor(Date.now() / 1000);
	const currentFy = fyOf(now);
	const fyTaxableMinor = portfolio.vdaRows
		.filter((r) => r.fy === currentFy)
		.reduce((sum, r) => sum + r.incomeMinor, 0);
	const fyDisposals = portfolio.disposals.filter((d) => d.fy === currentFy).length;

	// "across N transactions since …" counts the rows that carry INR value.
	const valueTxs = ledger.filter((t) => t.type !== 'TRANSFER');

	return {
		holdingsSats: portfolio.holdingsSats,
		netInvestedMinor: portfolio.netInvestedMinor,
		wallets,
		price,
		recent,
		totalTx: ledger.length,
		txCount: valueTxs.length,
		sinceTs: valueTxs.length > 0 ? valueTxs[0].ts : null,
		fy: { label: currentFy, taxableMinor: fyTaxableMinor, disposals: fyDisposals },
		now
	};
};
