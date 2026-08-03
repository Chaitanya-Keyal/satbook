import { json } from '@sveltejs/kit';
import { getLivePrice } from '$lib/server/rates';
import type { LivePricePayload } from '$lib/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		const payload: LivePricePayload = await getLivePrice();
		return json(payload);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'live price unavailable';
		return json({ error: message }, { status: 503 });
	}
};
