import { fail } from '@sveltejs/kit';
import { db, schema } from '$lib/server/db';
import { deleteTx, getLedger, getPortfolio } from '$lib/server/ledger';
import type { DisposalBreakdown, OpenLot, TxType } from '$lib/types';
import { fySpan } from '$lib/utils/fy';
import type { Actions, PageServerLoad } from './$types';

const TX_TYPES: TxType[] = ['INCOME', 'BUY', 'SELL', 'SPEND', 'TRANSFER'];

export const load: PageServerLoad = ({ url }) => {
	const ledger = getLedger(); // ascending — reversed below for default sort desc
	const portfolio = getPortfolio();

	const wallets = db
		.select()
		.from(schema.wallets)
		.all()
		.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
		.map((w) => ({ id: w.id, name: w.name, archived: w.archivedAt != null }));

	// Per-tx expansion data: disposal breakdowns (SELL/SPEND, and TRANSFER fees
	// when the micro-disposal toggle is on) and open-lot remainders (INCOME/BUY).
	const disposals: Record<number, DisposalBreakdown> = {};
	for (const d of portfolio.disposals) disposals[d.txId] = d;
	const openLots: Record<number, OpenLot> = {};
	for (const l of portfolio.openLots) openLots[l.lotTxId] = l;

	const fys = ledger.length > 0 ? fySpan(ledger[0].ts, ledger[ledger.length - 1].ts).reverse() : [];

	// Deep-linkable filters (?type=BUY,SELL&wallet=2&fy=FY2023-24&q=stipend);
	// the client owns them as state after init and syncs back via replaceState.
	const types = (url.searchParams.get('type') ?? '')
		.split(',')
		.map((t) => t.trim().toUpperCase())
		.filter((t): t is TxType => TX_TYPES.includes(t as TxType));
	const walletRaw = url.searchParams.get('wallet') ?? '';
	const wallet =
		/^\d+$/.test(walletRaw) && wallets.some((w) => w.id === +walletRaw) ? walletRaw : '';
	const fyRaw = url.searchParams.get('fy') ?? '';
	const fy = fys.includes(fyRaw) ? fyRaw : '';
	const q = url.searchParams.get('q') ?? '';

	const flashRaw = url.searchParams.get('flash') ?? '';
	const flash = /^\d+$/.test(flashRaw) ? +flashRaw : null;

	return {
		txs: [...ledger].reverse(),
		wallets,
		disposals,
		openLots,
		fys,
		filters: { types, wallet, fy, q },
		flash,
		now: Math.floor(Date.now() / 1000)
	};
};

export const actions: Actions = {
	delete: async ({ request }) => {
		const form = await request.formData();
		const idRaw = String(form.get('id') ?? '');
		if (!/^\d+$/.test(idRaw))
			return fail(400, { deleteId: null as number | null, deleteError: 'invalid transaction id' });
		const id = +idRaw;
		const res = deleteTx(id);
		if (!res.ok) return fail(400, { deleteId: id, deleteError: res.errors.join(' · ') });
		return { deleted: true };
	}
};
