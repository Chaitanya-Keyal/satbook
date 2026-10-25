import { json } from '@sveltejs/kit';
import { setUnit } from '$lib/server/settings';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  // JSON only: SvelteKit's origin check covers form posts, and a cross-site page
  // cannot send application/json without a CORS preflight, which this never answers.
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return json({ error: 'send application/json' }, { status: 415 });
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
