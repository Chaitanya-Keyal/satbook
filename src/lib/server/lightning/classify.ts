// What a synced payment can become in the ledger, what to suggest, and the
// exact ledger draft for a decision. Pure: no database, no network, so every
// rule is unit-tested. The amounts always come from the stored payment, never
// from the browser; a decision only picks the type and the descriptive fields.

import type { IncomeKind } from '../../types';
import { mulDivRound, SATS_PER_BTC } from '../../utils/money';
import type { lightningPayments } from '../db/schema';
import { npub } from './zap';

export type StoredPayment = typeof lightningPayments.$inferSelect;
export type ReviewAction = 'income' | 'transfer' | 'spend';

export interface Figures {
  /** Incoming: what the payer sent (the income). Outgoing: what left, fee excluded. */
  amountSats: number;
  /** Incoming: the liquidity fee the node kept. Outgoing: routing or mining fee. */
  feeSats: number;
  /** Incoming only: what the node's wallet gained (amount − fee). */
  creditedSats: number;
  /** False when the payer's amount had to be reconstructed (no invoice amount). */
  certain: boolean;
}

export interface Suggestion {
  /** Empty when the payment has to be recorded by hand (see `manualReason`). */
  actions: ReviewAction[];
  action: ReviewAction | null;
  kind: IncomeKind;
  counterparty: string;
  note: string;
  figures: Figures;
  manualReason: string | null;
}

export interface Decision {
  action: ReviewAction;
  kind?: IncomeKind;
  counterparty?: string;
  note?: string;
  /** Transfer: where it came from (incoming) or went (outgoing). */
  otherWalletId?: number | null;
  /** Incoming transfer: what the sending wallet paid on top, if known. */
  senderFeeSats?: number;
}

const msatToSat = (msat: number) => Math.round(msat / 1000);

export function figures(p: StoredPayment): Figures {
  const feeSats = msatToSat(p.feeMsat);
  if (p.direction === 'out') {
    // phoenixd's `sent` includes the fee.
    return { amountSats: p.amountSat - feeSats, feeSats, creditedSats: 0, certain: true };
  }
  // Incoming `amountSat` is net of a liquidity fee. The payer sent the invoice
  // amount; that is the income, and the fee is what the node kept of it.
  if (feeSats === 0)
    return { amountSats: p.amountSat, feeSats, creditedSats: p.amountSat, certain: true };
  if (p.requestedSat != null)
    return {
      amountSats: p.requestedSat,
      feeSats,
      creditedSats: p.requestedSat - feeSats,
      certain: true
    };
  return {
    amountSats: p.amountSat + feeSats,
    feeSats,
    creditedSats: p.amountSat,
    certain: false
  };
}

const RECORDABLE_OUT = new Set(['lightning', 'splice_out']);

export function suggest(p: StoredPayment): Suggestion {
  const f = figures(p);
  const base = { kind: 'income' as IncomeKind, counterparty: '', note: '', figures: f };
  if (p.direction === 'out') {
    if (!RECORDABLE_OUT.has(p.subType))
      return {
        ...base,
        actions: [],
        action: null,
        manualReason:
          p.subType === 'auto_liquidity' || p.subType === 'manual_liquidity'
            ? 'a liquidity purchase with no matching incoming payment — add its fee to the right row by hand'
            : 'record this one by hand'
      };
    if (f.amountSats <= 0)
      return { ...base, actions: [], action: null, manualReason: 'no amount left after the fee' };
    return {
      ...base,
      actions: p.subType === 'splice_out' ? ['transfer', 'spend'] : ['spend', 'transfer'],
      action: p.subType === 'splice_out' ? 'transfer' : 'spend',
      manualReason: null
    };
  }

  if (f.amountSats <= 0)
    return { ...base, actions: [], action: null, manualReason: 'the amount cannot be worked out' };
  const viaAddress = p.zapPubkey != null || p.comment != null || p.lnAddress != null;
  return {
    ...base,
    // A transfer needs something to credit; income can carry a fee larger than itself.
    actions: f.creditedSats > 0 ? ['income', 'transfer'] : ['income'],
    action: 'income',
    kind: viaAddress ? 'donation' : 'income',
    // Only a verified zap names its sender; anything else is just a claim.
    counterparty: p.zapPubkey && p.zapVerified ? npub(p.zapPubkey) : '',
    note: (p.comment ?? p.zapContent ?? p.description ?? p.payerNote ?? '').slice(0, 500),
    manualReason: null
  };
}

const inrMinor = (rate: number, sats: number) =>
  mulDivRound(Math.round(rate * 100), sats, SATS_PER_BTC);

/**
 * The ledger draft for `decision`. `rate` is INR per BTC at the payment's time.
 * Returns an error instead of a draft the ledger would reject anyway.
 */
export function draftFor(
  p: StoredPayment,
  decision: Decision,
  ctx: { nodeWalletId: number; rate: number; rateSource: string }
): { ok: true; draft: Record<string, unknown> } | { ok: false; error: string } {
  const s = suggest(p);
  if (!s.actions.includes(decision.action))
    return { ok: false, error: s.manualReason ?? `cannot record this as ${decision.action}` };
  const f = s.figures;
  const note = decision.note?.trim().slice(0, 500) || null;
  const counterparty = decision.counterparty?.trim().slice(0, 100) || null;
  const ts = p.completedAt;
  const ref =
    p.direction === 'out' && p.subType === 'splice_out'
      ? { txid: p.txId, refKind: p.txId ? 'onchain' : null }
      : { txid: p.paymentHash, refKind: p.paymentHash ? 'lightning' : null };
  const valued = (sats: number) => {
    const inr = inrMinor(ctx.rate, sats);
    return {
      fiatCurrency: 'INR',
      fiatAmountMinor: inr,
      fxRateToInr: 1,
      inrValueMinor: inr,
      enteredRate: ctx.rate,
      rateSource: ctx.rateSource
    };
  };
  const feeInr = (sats: number) => (sats > 0 ? inrMinor(ctx.rate, sats) : null);

  if (decision.action === 'transfer') {
    const other = decision.otherWalletId;
    if (other == null) return { ok: false, error: 'choose the other wallet' };
    if (other === ctx.nodeWalletId)
      return { ok: false, error: 'the other wallet is the node itself' };
    const senderFee = decision.senderFeeSats ?? 0;
    if (!Number.isInteger(senderFee) || senderFee < 0)
      return { ok: false, error: 'the sending fee must be whole sats' };
    const incoming = p.direction === 'in';
    const amountSats = incoming ? f.creditedSats : f.amountSats;
    const feeSats = incoming ? f.feeSats + senderFee : f.feeSats;
    return {
      ok: true,
      draft: {
        type: 'TRANSFER',
        ts,
        fromWalletId: incoming ? other : ctx.nodeWalletId,
        toWalletId: incoming ? ctx.nodeWalletId : other,
        amountSats,
        feeSats,
        feeInrValueMinor: feeInr(feeSats),
        ...ref,
        notes: note
      }
    };
  }

  if (decision.action === 'spend')
    return {
      ok: true,
      draft: {
        type: 'SPEND',
        ts,
        walletId: ctx.nodeWalletId,
        amountSats: f.amountSats,
        feeSats: f.feeSats,
        feeInrValueMinor: feeInr(f.feeSats),
        ...valued(f.amountSats),
        ...ref,
        counterparty,
        notes: note
      }
    };

  const kind = decision.kind ?? s.kind;
  if (!['donation', 'grant', 'income'].includes(kind))
    return { ok: false, error: 'unknown kind of income' };
  return {
    ok: true,
    draft: {
      type: 'INCOME',
      ts,
      walletId: ctx.nodeWalletId,
      amountSats: f.amountSats,
      feeSats: f.feeSats,
      feeInrValueMinor: feeInr(f.feeSats),
      ...valued(f.amountSats),
      ...ref,
      incomeKind: kind,
      counterparty,
      notes: note
    }
  };
}
