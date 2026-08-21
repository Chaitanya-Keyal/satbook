import { getLivePrice } from '$lib/server/rates';
import type { LivePricePayload } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// The converter degrades to manual rates rather than failing: null price
	// just means the rate fields start empty.
	let price: LivePricePayload | null = null;
	try {
		price = await getLivePrice();
	} catch {
		price = null;
	}
	return { price, now: Math.floor(Date.now() / 1000) };
};
