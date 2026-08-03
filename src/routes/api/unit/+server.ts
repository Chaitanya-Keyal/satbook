import { json } from '@sveltejs/kit';
import { setUnit } from '$lib/server/settings';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown = null;
	try {
		body = await request.json();
	} catch {
		// fall through — junk body 400s below
	}
	const unit =
		typeof body === 'object' && body !== null ? (body as Record<string, unknown>).unit : undefined;
	if (unit !== 'sats' && unit !== 'btc')
		return json({ error: "unit must be 'sats' or 'btc'" }, { status: 400 });
	setUnit(unit);
	return json({ ok: true, unit });
};
