import { error, fail } from '@sveltejs/kit';
import { getPortfolio } from '$lib/server/ledger';
import { lightningConfigState } from '$lib/server/lightning/config';
import { lightningWallet, listPayments, nodeStatus, TOP_UP_SAT } from '$lib/server/lightning/node';
import { pendingCount } from '$lib/server/lightning/review';
import { lastSync, syncLightning } from '$lib/server/lightning/sync';
import { getLivePrice } from '$lib/server/rates';
import { renderSVG } from 'uqr';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const st = lightningConfigState();
  if (st.state === 'off') error(404, 'Lightning is not configured');
  if (st.state === 'invalid') return { configured: false as const, problem: st.problem };
  const cfg = st.config;

  const wallet = lightningWallet();
  const last = lastSync();

  let btcInr: number | null = null;
  try {
    btcInr = (await getLivePrice()).btcInr;
  } catch {
    btcInr = null;
  }

  // What is already stored renders at once; the sync and the node's live
  // numbers stream in after, so a slow or offline node never blocks the page.
  const live = (async () => {
    try {
      const sync = await syncLightning();
      const status = await nodeStatus(cfg);
      const nodeId = status.ok ? status.status.info.nodeId : (sync.nodeId ?? last?.nodeId);
      return {
        sync,
        status,
        pending: pendingCount(),
        payments: nodeId ? listPayments(nodeId) : [],
        ledgerSats: wallet ? (getPortfolio().walletBalancesSats[wallet.id] ?? 0) : null
      };
    } catch (e) {
      return { failed: e instanceof Error ? e.message : String(e) };
    }
  })();

  return {
    configured: true as const,
    wallet,
    ledgerSats: wallet ? (getPortfolio().walletBalancesSats[wallet.id] ?? 0) : null,
    lnbits: cfg.lnbitsUrl != null,
    address: cfg.lightningAddress
      ? {
          text: cfg.lightningAddress,
          qr: renderSVG(`lightning:${cfg.lightningAddress}`, { border: 1 })
        }
      : null,
    lastSync: last,
    stored: last?.nodeId ? listPayments(last.nodeId) : [],
    topUpSat: TOP_UP_SAT,
    btcInr,
    now: Math.floor(Date.now() / 1000),
    live
  };
};

export const actions: Actions = {
  sync: async ({ request }) => {
    if (lightningConfigState().state !== 'on')
      return fail(400, { syncError: 'Lightning is not configured' });
    const full = (await request.formData()).get('full') === '1';
    const s = await syncLightning({ force: true, full });
    if (!s.ok) return fail(502, { syncError: s.error ?? 'sync failed' });
    return { synced: true, added: s.added ?? 0, warning: s.warning ?? null };
  }
};
