// What the dashboard shows: the node's live state, the synced payments with
// their ledger status, and which satbook wallet stands for the node.

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db';
import { getSetting, setSetting } from '../settings';
import type { LightningConfig } from './config';
import { describeError } from './http';
import { type LiquidityFees, NORMAL, type NodeBalance, type NodeInfo, phoenixd } from './phoenixd';
import { npub } from './zap';

/** phoenixd's default --auto-liquidity: what one top-up buys on top of the payment. */
export const TOP_UP_SAT = 2_000_000;

export interface NodeStatus {
  info: NodeInfo;
  balance: NodeBalance;
  /** The fee for the next automatic top-up, if the node would quote one. */
  topUpFee: LiquidityFees | null;
  /** Summed over channels in the Normal state. */
  channels: { count: number; balanceSat: number; inboundSat: number; capacitySat: number };
  mainnet: boolean;
}

let cached: { at: number; value: { ok: true; status: NodeStatus } } | null = null;
const CACHE_MS = 20_000;

/** Live node state; cached briefly so navigating around does not hammer the node. */
export async function nodeStatus(
  cfg: LightningConfig
): Promise<{ ok: true; status: NodeStatus } | { ok: false; error: string }> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const node = phoenixd(cfg);
  const [info, balance, fee] = await Promise.all([
    node.getInfo(),
    node.getBalance(),
    node.estimateLiquidityFees(TOP_UP_SAT)
  ]);
  if (!info.ok) return { ok: false, error: `phoenixd ${describeError(info)}` };
  if (!balance.ok) return { ok: false, error: `phoenixd ${describeError(balance)}` };
  const normal = info.data.channels.filter((c) => c.state === NORMAL);
  const value = {
    ok: true as const,
    status: {
      info: info.data,
      balance: balance.data,
      topUpFee: fee.ok ? fee.data : null,
      channels: {
        count: normal.length,
        balanceSat: normal.reduce((s, c) => s + c.balanceSat, 0),
        inboundSat: normal.reduce((s, c) => s + c.inboundLiquiditySat, 0),
        capacitySat: normal.reduce((s, c) => s + c.capacitySat, 0)
      },
      mainnet: info.data.chain === 'mainnet'
    }
  };
  cached = { at: Date.now(), value };
  return value;
}

export function _resetNodeStatusCache(): void {
  cached = null;
}

// --- the node's wallet --------------------------------------------------------

const WALLET_KEY = 'ln_wallet_id';

/** The live wallet chosen to stand for the node, if any. */
export function lightningWallet(): { id: number; name: string } | null {
  const id = Number(getSetting(WALLET_KEY));
  if (!Number.isInteger(id) || id <= 0) return null;
  const w = db
    .select({ id: schema.wallets.id, name: schema.wallets.name })
    .from(schema.wallets)
    .where(and(eq(schema.wallets.id, id), isNull(schema.wallets.archivedAt)))
    .get();
  return w ?? null;
}

export function setLightningWallet(id: number): void {
  setSetting(WALLET_KEY, String(id));
}

// --- synced payments ------------------------------------------------------------

/** The ledger import key that records a payment. */
export const importKeyFor = (key: string) => `phoenixd:${key}`;

export interface PaymentView {
  key: string;
  direction: 'in' | 'out';
  subType: string;
  paymentHash: string | null;
  txId: string | null;
  /** Incoming: net of any liquidity fee. Outgoing: fees included. */
  amountSat: number;
  feeSat: number;
  requestedSat: number | null;
  completedAt: number;
  note: string | null;
  memo: string | null;
  comment: string | null;
  zap: { npub: string; content: string | null; verified: boolean } | null;
  review: 'pending' | 'ignored' | 'paired';
  /** The ledger row that records it, if any. */
  txIdInLedger: number | null;
}

/** Fees arrive in msat; a fee is whole sats once it reaches the ledger. */
export const msatToSat = (msat: number) => Math.round(msat / 1000);

export function listPayments(nodeId: string, limit = 100): PaymentView[] {
  const t = schema.lightningPayments;
  const rows = db
    .select()
    .from(t)
    .where(eq(t.nodeId, nodeId))
    .orderBy(desc(t.completedAt), desc(t.id))
    .limit(limit)
    .all();
  const links = ledgerLinks(rows);
  return rows.map((r) => ({
    key: r.key,
    direction: r.direction,
    subType: r.subType,
    paymentHash: r.paymentHash,
    txId: r.txId,
    amountSat: r.amountSat,
    feeSat: msatToSat(r.feeMsat),
    requestedSat: r.requestedSat,
    completedAt: r.completedAt,
    note: r.payerNote ?? r.description,
    memo: r.memo,
    comment: r.comment,
    zap: r.zapPubkey
      ? { npub: npub(r.zapPubkey), content: r.zapContent, verified: r.zapVerified === true }
      : null,
    review: r.review,
    txIdInLedger: links.get(r.key) ?? null
  }));
}

/**
 * Which payments already have a ledger row: one imported for it (by import
 * key), or a row entered by hand that carries its payment hash.
 */
export function ledgerLinks(
  rows: { key: string; paymentHash: string | null }[]
): Map<string, number> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;
  const tx = schema.transactions;
  const keys = rows.map((r) => importKeyFor(r.key));
  const hashes = rows.map((r) => r.paymentHash).filter((h): h is string => h != null);
  const hits = db
    .select({ id: tx.id, importKey: tx.importKey, txid: tx.txid })
    .from(tx)
    .where(
      or(
        inArray(tx.importKey, keys),
        hashes.length ? and(eq(tx.refKind, 'lightning'), inArray(tx.txid, hashes)) : undefined
      )
    )
    .all();
  const byImport = new Map(hits.filter((h) => h.importKey).map((h) => [h.importKey!, h.id]));
  const byHash = new Map(hits.filter((h) => h.txid).map((h) => [h.txid!, h.id]));
  for (const r of rows) {
    const id =
      byImport.get(importKeyFor(r.key)) ?? (r.paymentHash ? byHash.get(r.paymentHash) : undefined);
    if (id != null) out.set(r.key, id);
  }
  return out;
}
