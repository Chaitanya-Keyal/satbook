// Unit-aware display helpers shared by every screen. All inputs are integer
// satoshis; formatting delegates to the canonical formatters in money.ts.

import type { IncomeKind, Tx } from '../types';
import { formatBtc, formatSats } from './money';

export type Unit = 'sats' | 'btc';

/** 1921337 → '1 921 337 sats' | '0.019 213 37 BTC' per the global unit. */
export function formatAmount(sats: number, unit: Unit): string {
  return unit === 'btc' ? `${formatBtc(sats)} BTC` : `${formatSats(sats)} sats`;
}

/**
 * Signed variant: explicit '+' / '−' (true minus comes from the formatter)
 * plus the gain/loss color class for the sign. Zero renders unsigned/uncolored.
 */
export function signedAmount(sats: number, unit: Unit): { text: string; cls: string } {
  const text = sats > 0 ? `+${formatAmount(sats, unit)}` : formatAmount(sats, unit);
  return { text, cls: sats > 0 ? 'text-gain' : sats < 0 ? 'text-loss' : '' };
}

/** Compact USD for tight spaces (mobile ticker): 63488 → '$63.5k'. */
export function formatUsdCompact(usd: number): string {
  const sign = usd < 0 ? '−' : '';
  const abs = Math.abs(usd);
  if (abs < 1000) return `${sign}$${Math.round(abs)}`;
  const k = abs / 1000;
  return `${sign}$${(k >= 100 ? Math.round(k) : Math.round(k * 10) / 10).toString()}k`;
}

/** 61240.4 → '$61,240' (whole dollars, western grouping; true minus when negative). */
export function formatUsd(usd: number): string {
  const sign = usd < 0 ? '−' : '';
  const grouped = Math.round(Math.abs(usd))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}`;
}

/** Minor units of a foreign fiat → '$1,200' | '€179.50' (cents only when nonzero). */
export function formatForeignMinor(minor: number, cur: 'USD' | 'EUR'): string {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = abs % 100;
  return `${sign}${cur === 'USD' ? '$' : '€'}${whole}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
}

export const INCOME_KIND_LABEL: Record<IncomeKind, string> = {
  donation: 'Donation',
  grant: 'Grant',
  income: 'Income'
};

export interface DetailPart {
  text: string;
  /** lead: who / what kind · note: the user's own words · meta: quiet facts */
  tone: 'lead' | 'note' | 'meta';
}

/**
 * A ledger row's one-line details — only what the other columns don't say.
 * Leads with the income kind (when more specific than the INCOME badge) and
 * the counterparty, then the note, then a non-INR original amount and the
 * network fee. Empty when there is nothing to add.
 */
export function txDetails(
  t: Pick<
    Tx,
    | 'type'
    | 'incomeKind'
    | 'counterparty'
    | 'notes'
    | 'fiatCurrency'
    | 'fiatAmountMinor'
    | 'feeSats'
  >
): DetailPart[] {
  const parts: DetailPart[] = [];
  if (t.type === 'INCOME' && t.incomeKind != null && t.incomeKind !== 'income')
    parts.push({ text: INCOME_KIND_LABEL[t.incomeKind], tone: 'lead' });
  if (t.counterparty) parts.push({ text: t.counterparty, tone: 'lead' });
  if (t.notes) parts.push({ text: t.notes, tone: 'note' });
  if (t.fiatCurrency != null && t.fiatCurrency !== 'INR' && t.fiatAmountMinor != null)
    parts.push({ text: formatForeignMinor(t.fiatAmountMinor, t.fiatCurrency), tone: 'meta' });
  if (t.feeSats > 0) parts.push({ text: `fee ${formatSats(t.feeSats)} sats`, tone: 'meta' });
  return parts;
}
