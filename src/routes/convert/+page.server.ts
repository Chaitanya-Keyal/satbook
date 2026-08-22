import { getLivePrice, getUsdInrNow } from '$lib/server/rates';
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
	// The FX field seeds from the real ECB rate; the BTC prices come from the
	// live global quote. Both are editable.
	let usdInr: number | null = null;
	try {
		usdInr = await getUsdInrNow();
	} catch {
		usdInr = null;
	}
	return { price, usdInr, now: Math.floor(Date.now() / 1000) };
};
