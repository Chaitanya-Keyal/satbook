import { error, json } from '@sveltejs/kit';
import { lightningState } from '$lib/server/lightning/credentials';
import { describeError } from '$lib/server/lightning/http';
import { nodeStatus, TOP_UP_SAT } from '$lib/server/lightning/node';
import { phoenixd } from '$lib/server/lightning/phoenixd';
import { purchaseQuote, type ReceiveQuote } from '$lib/utils/lightning';
import type { RequestHandler } from './$types';

/**
 * What receiving an amount would cost right now: nothing if it fits in the
 * inbound capacity, otherwise the fee phoenixd quotes for the block plus the
 * payment.
 */
export const GET: RequestHandler = async ({ url }) => {
  const st = await lightningState();
  if (st.state !== 'on') error(404, 'Lightning is not configured');
  const raw = (url.searchParams.get('amountSat') ?? '').replace(/[\s,]/g, '');
  const amountSat = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(amountSat > 0 && amountSat <= 100_000_000))
    error(400, 'amountSat must be whole sats, at most 1 BTC');

  const status = await nodeStatus(st.config);
  if (!status.ok) return json({ error: status.error }, { status: 502 });
  const s = status.status;
  const node = {
    inboundSat: s.channels.inboundSat,
    feeCreditSat: s.balance.feeCreditSat,
    // phoenixd's own test for whether a purchase opens a channel or splices.
    hasChannel: s.info.channels.length > 0
  };
  if (amountSat <= node.inboundSat)
    return json({ quote: { kind: 'fits', inboundSat: node.inboundSat } satisfies ReceiveQuote });

  const fee = await phoenixd(st.config).estimateLiquidityFees(TOP_UP_SAT + amountSat);
  if (!fee.ok) return json({ error: `phoenixd ${describeError(fee)}` }, { status: 502 });
  return json({ quote: purchaseQuote(amountSat, node, TOP_UP_SAT, fee.data) });
};
