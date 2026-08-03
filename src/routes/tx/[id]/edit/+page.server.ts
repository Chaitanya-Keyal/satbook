import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { draftFromFormData } from '$lib/components/tx-form/draft';
import { db, schema } from '$lib/server/db';
import { getLedger, updateTx } from '$lib/server/ledger';
import { getLivePrice } from '$lib/server/rates';
import type { Actions, PageServerLoad } from './$types';

function findTx(idRaw: string) {
	if (!/^\d+$/.test(idRaw)) return undefined;
	const id = parseInt(idRaw, 10);
	return getLedger().find((t) => t.id === id);
}

export const load: PageServerLoad = async ({ params }) => {
	const tx = findTx(params.id);
	if (!tx) error(404, 'transaction not found');

	const wallets = db
		.select()
		.from(schema.wallets)
		.all()
		.filter((w) => w.archivedAt == null)
		.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
		.map((w) => ({ id: w.id, name: w.name, kind: w.kind }));

	// A tx referencing a since-archived wallet must still render its selects
	// (updateTx will reject the save with a specific message anyway).
	for (const wid of [tx.walletId, tx.fromWalletId, tx.toWalletId]) {
		if (wid != null && !wallets.some((w) => w.id === wid)) {
			const w = db.select().from(schema.wallets).where(eq(schema.wallets.id, wid)).get();
			if (w) wallets.push({ id: w.id, name: `${w.name} (archived)`, kind: w.kind });
		}
	}

	let live: { btcInr: number; btcUsd: number } | null = null;
	try {
		const p = await getLivePrice();
		live = { btcInr: p.btcInr, btcUsd: p.btcUsd };
	} catch {
		live = null;
	}

	return { tx, wallets, live };
};

export const actions: Actions = {
	default: async ({ params, request }) => {
		const tx = findTx(params.id);
		if (!tx) error(404, 'transaction not found');
		const form = await request.formData();
		const res = updateTx(tx.id, draftFromFormData(form));
		if (!res.ok) return fail(400, { errors: res.errors });
		redirect(303, `/tx?flash=${tx.id}`);
	}
};
