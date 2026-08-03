import { json } from '@sveltejs/kit';
import { db, schema } from '$lib/server/db';
import { fetchTx } from '$lib/server/esplora';
import type { EsploraTxPayload } from '$lib/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const txid = params.txid.toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid))
		return json({ error: 'txid must be 64 hex characters' }, { status: 400 });

	const raw = await fetchTx(txid);
	if (!raw) return json({ error: 'transaction not found' }, { status: 404 });

	const ownedByAddress = new Map(
		db
			.select()
			.from(schema.walletAddresses)
			.all()
			.map((a) => [a.address, a.walletId])
	);

	const payload: EsploraTxPayload = {
		txid: raw.txid,
		confirmed: raw.confirmed,
		blockTime: raw.blockTime,
		feeSats: raw.feeSats,
		host: raw.host,
		outputs: raw.outputs.map((o) => ({
			index: o.index,
			address: o.address,
			valueSats: o.valueSats,
			isOwn: o.address != null && ownedByAddress.has(o.address),
			ownWalletId: (o.address != null && ownedByAddress.get(o.address)) || null
		}))
	};
	return json(payload);
};
