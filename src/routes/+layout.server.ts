import { lightningConfigState } from '$lib/server/lightning/config';
import { pendingCount } from '$lib/server/lightning/review';
import { getUnit } from '$lib/server/settings';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
  const lightning = lightningConfigState().state;
  return {
    authed: locals.authed,
    unit: getUnit(),
    // Shown when configured, and when misconfigured so the page can say why.
    lightning: lightning !== 'off',
    // Synced payments not yet in the ledger (from the last sync; no node call).
    lightningPending: lightning === 'on' && locals.authed ? pendingCount() : 0
  };
};
