import { error, json } from '@sveltejs/kit';
import { lightningConfigState } from '$lib/server/lightning/config';
import { phoenixd } from '$lib/server/lightning/phoenixd';
import { syncLightning } from '$lib/server/lightning/sync';
import type { RequestHandler } from './$types';

/** Has the invoice been paid? The dashboard polls this while it shows the QR. */
export const GET: RequestHandler = async ({ params }) => {
  const st = lightningConfigState();
  if (st.state !== 'on') error(404, 'Lightning is not configured');
  if (!/^[0-9a-f]{64}$/.test(params.hash)) error(400, 'not a payment hash');
  const res = await phoenixd(st.config).getIncoming(params.hash);
  if (!res.ok) return json({ paid: false, error: res.error });
  const p = res.data;
  // Paid: pull it into satbook now, so it shows in the activity and the
  // review inbox right away instead of at the next sync.
  if (p.isPaid) await syncLightning({ force: true });
  return json({ paid: p.isPaid, receivedSat: p.receivedSat, feeMsat: p.feesMsat });
};
