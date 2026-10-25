import { json } from '@sveltejs/kit';
import { previewDraft } from '$lib/server/ledger';
import type { DraftTx } from '$lib/types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  // JSON only: SvelteKit's origin check covers form posts, and a cross-site page
  // cannot send application/json without a CORS preflight, which this never answers.
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    return json({ error: 'send application/json' }, { status: 415 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'request body must be valid JSON' }, { status: 400 });
  }
  // previewDraft validates the draft defensively — the cast is just for the signature.
  return json(previewDraft(body as DraftTx));
};
