import { fail, redirect } from '@sveltejs/kit';
import { draftFromFormData, withdrawalFromFormData } from '$lib/components/tx-form/draft';
import { db, schema } from '$lib/server/db';
import { createTx, createTxPair } from '$lib/server/ledger';
import { getLivePrice } from '$lib/server/rates';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const wallets = db
		.select()
		.from(schema.wallets)
		.all()
		.filter((w) => w.archivedAt == null)
		.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
		.map((w) => ({ id: w.id, name: w.name, kind: w.kind }));

	// Seed for the triad's initial rate prefill — decoration, never blocking.
	let live: { btcInr: number; btcUsd: number } | null = null;
	try {
		const p = await getLivePrice();
		live = { btcInr: p.btcInr, btcUsd: p.btcUsd };
	} catch {
		live = null;
	}

	return { wallets, live };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		// Composite exchange buy: the BUY plus its self-custody withdrawal
		// TRANSFER, validated together and inserted atomically.
		if (form.get('withdrawal') === '1') {
			const res = createTxPair(draftFromFormData(form), withdrawalFromFormData(form));
			if (!res.ok) return fail(400, { errors: res.errors });
			redirect(303, `/tx?flash=${res.transferId}`);
		}
		const res = createTx(draftFromFormData(form));
		if (!res.ok) return fail(400, { errors: res.errors });
		if (form.get('intent') === 'again') return { saved: true, id: res.id };
		redirect(303, `/tx?flash=${res.id}`);
	}
};
