import { json } from '@sveltejs/kit';
import { getBtcInrAt, getFxToInrAt } from '$lib/server/rates';
import type { RateLookupPayload } from '$lib/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const tsRaw = url.searchParams.get('ts') ?? '';
	if (!/^\d+$/.test(tsRaw))
		return json({ error: 'ts must be a unix-seconds integer' }, { status: 400 });
	const ts = parseInt(tsRaw, 10);

	const fiat = (url.searchParams.get('fiat') ?? 'INR').toUpperCase();
	if (fiat !== 'INR' && fiat !== 'USD' && fiat !== 'EUR')
		return json({ error: 'fiat must be INR, USD or EUR' }, { status: 400 });

	let btc: Awaited<ReturnType<typeof getBtcInrAt>> = null;
	try {
		btc = await getBtcInrAt(ts);
	} catch {
		return json({ error: 'timestamp is in the future' }, { status: 400 });
	}

	const fx = fiat === 'INR' ? null : await getFxToInrAt(fiat, ts);
	const payload: RateLookupPayload = {
		btcInr: btc?.rate ?? null,
		btcInrSource: btc?.source ?? null,
		fxToInr: fx?.rate ?? null,
		fxSource: fx?.source ?? null,
		fxDate: fx?.date ?? null
	};
	return json(payload);
};
