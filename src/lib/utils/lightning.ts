// Display helpers for the Lightning dashboard (client-safe, no server imports).

/** What a synced phoenixd payment was, in words. */
export function paymentLabel(direction: 'in' | 'out', subType: string): string {
  if (direction === 'in') return 'Received';
  switch (subType) {
    case 'lightning':
      return 'Sent';
    case 'splice_out':
      return 'Sent on-chain';
    case 'auto_liquidity':
    case 'manual_liquidity':
      return 'Liquidity purchase';
    case 'splice_cpfp':
      return 'Fee bump';
    case 'channel_close':
      return 'Channel closed';
    default:
      return subType.replaceAll('_', ' ');
  }
}

/** 'npub1abcdef…uvwxyz' */
export function shortNpub(npub: string): string {
  return npub.length > 20 ? `${npub.slice(0, 10)}…${npub.slice(-6)}` : npub;
}

/** The share of a channel bar, as a CSS percentage, never NaN. */
export function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.max(0, Math.min(100, (part / whole) * 100)).toFixed(2)}%` : '0%';
}

/**
 * Lightning moves millisatoshis, but the ledger, phoenixd's balance and its
 * payment amounts are whole sats, each rounded on its own. A gap this small
 * between the ledger and the node is rounding, not a missing payment.
 */
export const ROUNDING_TOLERANCE_SAT = 1;

/** How the ledger's balance for the node's wallet compares with the node's own. */
export function ledgerCheck(ledgerSats: number, nodeSats: number): 'match' | 'rounding' | 'gap' {
  const gap = Math.abs(ledgerSats - nodeSats);
  return gap === 0 ? 'match' : gap <= ROUNDING_TOLERANCE_SAT ? 'rounding' : 'gap';
}

/**
 * phoenixd quotes a liquidity fee's mining part at the current feerate, but the
 * purchase pays a raised one (lightning-kmp's adjustFeerate; the lower the
 * feerate, the bigger the raise): 1.6–2.5× to open a channel, and up to 3.8×
 * to splice into one whose balance cannot cover the fees. 3.8× is also the
 * feerate it tests a payment against before taking all of it as fee credit.
 * A splice also pays the node's own share of the splice transaction's mining
 * fee, which phoenixd's quote leaves out and these ranges do not cover.
 */
export const FEERATE_RAISE = { open: [1.6, 2.5], splice: [1, 3.8] } as const;

/** What the LSP adds to the service fee when a purchase opens a channel (ACINQ: 1,000). */
export const CHANNEL_CREATION_FEE_SAT = 1_000;

export type ReceiveQuote =
  /** Fits in the inbound capacity: no fee. */
  | { kind: 'fits'; inboundSat: number }
  /** Sets off a purchase of the block plus the payment; the fee comes out of the payment. */
  | {
      kind: 'purchase';
      inboundSat: number;
      /** The inbound liquidity it buys: the block plus the payment. */
      purchaseSat: number;
      /** Opens the node's first channel, rather than splicing into one. */
      opensChannel: boolean;
      /** phoenixd's quote, at the current feerate. */
      quotedFeeSat: number;
      serviceSat: number;
      /** The mining part, at the smallest and the biggest raise of the feerate. */
      miningSat: [number, number];
      /** Fee credit, which pays the fee first. */
      feeCreditSat: number;
      /** What it adds to the balance, at the highest and the lowest fee. */
      keepSat: [number, number];
    }
  /** Too small to pay for a purchase: phoenixd may take all of it as fee credit. */
  | { kind: 'fee-credit'; inboundSat: number; thresholdSat: number };

/**
 * What a payment that does not fit in the inbound capacity costs. `fee` must be
 * phoenixd's quote for the block plus the payment, estimateliquidityfees(block
 * + amount): phoenixd buys both, and its 1% applies to the payment too.
 */
export function purchaseQuote(
  amountSat: number,
  node: { inboundSat: number; feeCreditSat: number; hasChannel: boolean },
  blockSat: number,
  fee: { miningFeeSat: number; serviceFeeSat: number }
): Exclude<ReceiveQuote, { kind: 'fits' }> {
  const { inboundSat, feeCreditSat } = node;
  const mining = (factor: number) => Math.ceil(fee.miningFeeSat * factor);
  // phoenixd keeps a payment as fee credit while it, plus the credit so far,
  // is at most what opening a channel could cost at the most raised feerate.
  const thresholdSat =
    fee.serviceFeeSat +
    (node.hasChannel ? CHANNEL_CREATION_FEE_SAT : 0) +
    mining(FEERATE_RAISE.splice[1]);
  if (amountSat + feeCreditSat <= thresholdSat)
    return { kind: 'fee-credit', inboundSat, thresholdSat };

  const [lo, hi] = node.hasChannel ? FEERATE_RAISE.splice : FEERATE_RAISE.open;
  // Fee credit pays the fee first; the payment covers the rest.
  const keep = (miningSat: number) =>
    amountSat - Math.max(0, fee.serviceFeeSat + miningSat - feeCreditSat);
  return {
    kind: 'purchase',
    inboundSat,
    purchaseSat: blockSat + amountSat,
    opensChannel: !node.hasChannel,
    quotedFeeSat: fee.serviceFeeSat + fee.miningFeeSat,
    serviceSat: fee.serviceFeeSat,
    miningSat: [mining(lo), mining(hi)],
    feeCreditSat,
    keepSat: [keep(mining(hi)), keep(mining(lo))]
  };
}
