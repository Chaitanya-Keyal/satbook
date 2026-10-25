import { error, fail } from '@sveltejs/kit';
import { getPortfolio } from '$lib/server/ledger';
import { lightningState } from '$lib/server/lightning/credentials';
import {
  fractionalPayments,
  lightningWallet,
  listPayments,
  nodeStatus,
  TOP_UP_SAT
} from '$lib/server/lightning/node';
import { describeError } from '$lib/server/lightning/http';
import { phoenixd } from '$lib/server/lightning/phoenixd';
import { pendingCount } from '$lib/server/lightning/review';
import { lastSync, syncLightning } from '$lib/server/lightning/sync';
import { getLivePrice } from '$lib/server/rates';
import { renderSVG } from 'uqr';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const st = await lightningState();
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
        ledgerSats: wallet ? (getPortfolio().walletBalancesSats[wallet.id] ?? 0) : null,
        fractions: nodeId ? fractionalPayments(nodeId) : 0
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

/** How long a satbook invoice stays payable. */
const INVOICE_EXPIRY_SEC = 3600;

export const actions: Actions = {
  /** A BOLT11 invoice from the node: a QR to show, then the page polls for payment. */
  invoice: async ({ request }) => {
    const st = await lightningState();
    if (st.state !== 'on') return fail(400, { invoiceError: 'Lightning is not configured' });
    const form = await request.formData();
    const rawAmount = String(form.get('amountSat') ?? '').replace(/[\s,]/g, '');
    const amountSat = rawAmount === '' ? null : /^\d+$/.test(rawAmount) ? Number(rawAmount) : NaN;
    if (amountSat != null && !(amountSat > 0 && amountSat <= 100_000_000))
      return fail(400, { invoiceError: 'amount must be whole sats, at most 1 BTC (or empty)' });
    const description = String(form.get('description') ?? '').trim();
    if (description.length === 0 || description.length > 128)
      return fail(400, { invoiceError: 'say what it is for, in up to 128 characters' });
    const res = await phoenixd(st.config).createInvoice({
      amountSat,
      description,
      expirySeconds: INVOICE_EXPIRY_SEC
    });
    if (!res.ok) return fail(502, { invoiceError: `phoenixd ${describeError(res)}` });
    return {
      invoice: {
        paymentHash: res.data.paymentHash,
        serialized: res.data.serialized,
        amountSat: res.data.amountSat,
        description,
        expiresAt: Math.floor(Date.now() / 1000) + INVOICE_EXPIRY_SEC,
        // Upper case lets the QR use its compact alphanumeric mode.
        qr: renderSVG(`lightning:${res.data.serialized}`.toUpperCase(), { border: 1 })
      }
    };
  },

  sync: async ({ request }) => {
    const st = await lightningState();
    if (st.state !== 'on')
      return fail(400, {
        syncError: st.state === 'invalid' ? st.problem : 'Lightning is not configured'
      });
    const full = (await request.formData()).get('full') === '1';
    const s = await syncLightning({ force: true, full });
    if (!s.ok) return fail(502, { syncError: s.error ?? 'sync failed' });
    return { synced: true, added: s.added ?? 0, warning: s.warning ?? null };
  }
};
