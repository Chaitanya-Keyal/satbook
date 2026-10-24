// Copies a phoenixd node's payments into lightning_payments, so they can be
// shown and reviewed into ledger rows without asking the node every time.
// Pull only: satbook asks when a page wants fresh data, and the node never has
// to reach satbook. Re-running is harmless — rows are keyed per node and
// payment, and a sync only refreshes what the node reports, never the review
// state.

import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { getSetting, setSetting } from '../settings';
import { lightningConfig } from './config';
import { describeError } from './http';
import { lnbitsFor, type LnbitsPayment } from './lnbits';
import { type IncomingPayment, type OutgoingPayment, phoenixd } from './phoenixd';
import { isHexKey, verifyZapRequest } from './zap';

const PAGE = 100;
const MAX_PAGES = 200;
/** Each sync re-reads the last day, so late completions and LNbits context are not missed. */
const OVERLAP_SEC = 24 * 3600;
/** An auto_liquidity record and the payment that triggered it complete together. */
const PAIR_WINDOW_SEC = 30 * 60;
/** Automatic syncs (page loads) run at most this often; "Sync now" forces one. */
export const AUTO_SYNC_INTERVAL_SEC = 60;

export interface SyncStatus {
  at: number;
  ok: boolean;
  error?: string;
  /** Synced, but LNbits could not add comments and zaps. */
  warning?: string;
  nodeId?: string;
  chain?: string;
  /** New payments this run. */
  added?: number;
}

const LAST_SYNC = 'ln_last_sync';
const nowSec = () => Math.floor(Date.now() / 1000);

export function lastSync(): SyncStatus | null {
  const raw = getSetting(LAST_SYNC);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncStatus;
  } catch {
    return null;
  }
}

function record(s: SyncStatus): SyncStatus {
  setSetting(LAST_SYNC, JSON.stringify(s));
  return s;
}

let inFlight: Promise<SyncStatus> | null = null;

/**
 * Sync unless one ran within AUTO_SYNC_INTERVAL_SEC (`force` skips that check).
 * Concurrent callers share one run. `full` re-reads the node's whole history.
 */
export function syncLightning(opts: { force?: boolean; full?: boolean } = {}): Promise<SyncStatus> {
  if (inFlight) return inFlight;
  const last = lastSync();
  if (!opts.force && !opts.full && last && nowSec() - last.at < AUTO_SYNC_INTERVAL_SEC)
    return Promise.resolve(last);
  inFlight = run(opts.full ?? false).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(full: boolean): Promise<SyncStatus> {
  const at = nowSec();
  const cfg = lightningConfig();
  if (!cfg) return { at, ok: false, error: 'Lightning is not configured' };
  const node = phoenixd(cfg);

  const info = await node.getInfo();
  if (!info.ok) return record({ at, ok: false, error: `phoenixd ${describeError(info)}` });
  const { nodeId, chain } = info.data;

  const cursorKey = `ln_in_cursor:${nodeId}`;
  const cursor = full ? 0 : Number(getSetting(cursorKey) ?? 0) || 0;
  const from = Math.max(0, cursor - OVERLAP_SEC);

  // phoenixd may return short pages (it filters after LIMIT), so only an
  // empty page ends the listing.
  const incoming: IncomingPayment[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await node.listIncoming(from, PAGE, page * PAGE);
    if (!r.ok)
      return record({ at, ok: false, nodeId, chain, error: `phoenixd ${describeError(r)}` });
    if (r.data.length === 0) break;
    incoming.push(...r.data);
  }
  // Outgoing payments are few (sweeps, the odd payment from the CLI) and an
  // on-chain one only completes once locked, so they are re-read in full.
  const outgoing: OutgoingPayment[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await node.listOutgoing(PAGE, page * PAGE);
    if (!r.ok)
      return record({ at, ok: false, nodeId, chain, error: `phoenixd ${describeError(r)}` });
    if (r.data.length === 0) break;
    outgoing.push(...r.data);
  }

  const added = store(nodeId, incoming, outgoing, at);
  pairLiquidityPurchases(nodeId);

  const newest = incoming.reduce((m, p) => Math.max(m, p.completedAt ?? 0), cursor);
  if (newest > cursor) setSetting(cursorKey, String(newest));

  let warning: string | undefined;
  const lb = lnbitsFor(cfg);
  if (lb) {
    const err = await enrichFromLnbits(lb, nodeId, full ? 0 : from);
    if (err) warning = `LNbits ${err}`;
  }
  return record({ at, ok: true, nodeId, chain, added, warning });
}

function store(
  nodeId: string,
  incoming: IncomingPayment[],
  outgoing: OutgoingPayment[],
  at: number
): number {
  const t = schema.lightningPayments;
  const known = new Set(
    db
      .select({ key: t.key })
      .from(t)
      .where(eq(t.nodeId, nodeId))
      .all()
      .map((r) => r.key)
  );
  type Row = typeof t.$inferInsert;
  const rows: Row[] = [];
  for (const p of incoming) {
    if (!p.isPaid || p.completedAt == null) continue;
    rows.push({
      nodeId,
      key: `in:${p.paymentHash}`,
      direction: 'in',
      subType: p.subType,
      paymentHash: p.paymentHash,
      txId: null,
      amountSat: p.receivedSat,
      feeMsat: p.feesMsat,
      requestedSat: p.requestedSat,
      description: p.description,
      payerNote: p.payerNote,
      completedAt: p.completedAt,
      syncedAt: at
    });
  }
  for (const p of outgoing) {
    if (!p.isPaid || p.completedAt == null) continue;
    rows.push({
      nodeId,
      key: `out:${p.paymentId}`,
      direction: 'out',
      subType: p.subType,
      paymentHash: p.paymentHash,
      txId: p.txId,
      amountSat: p.sentSat,
      feeMsat: p.feesMsat,
      requestedSat: null,
      description: null,
      payerNote: null,
      completedAt: p.completedAt,
      syncedAt: at
    });
  }

  let added = 0;
  db.transaction((tx) => {
    for (const r of rows) {
      if (!known.has(r.key)) added++;
      tx.insert(t)
        .values(r)
        .onConflictDoUpdate({
          target: [t.nodeId, t.key],
          // What the node reports; never the review state or LNbits context.
          set: {
            subType: r.subType,
            txId: r.txId,
            amountSat: r.amountSat,
            feeMsat: r.feeMsat,
            requestedSat: r.requestedSat,
            description: r.description,
            payerNote: r.payerNote,
            completedAt: r.completedAt,
            syncedAt: at
          }
        })
        .run();
    }
  });
  return added;
}

/**
 * A liquidity purchase shows up twice: the incoming payment that triggered it
 * arrives net of the fee (and carries it in `fees`), and a separate outgoing
 * auto_liquidity record pays the same fee. The incoming payment is the one to
 * record, so its partner is marked 'paired' and kept out of review.
 */
export function pairLiquidityPurchases(nodeId: string): void {
  const t = schema.lightningPayments;
  const rows = db.select().from(t).where(eq(t.nodeId, nodeId)).all();
  const taken = new Set(rows.map((r) => r.pairedKey).filter((k): k is string => k != null));
  const triggers = rows.filter((r) => r.direction === 'in' && r.feeMsat > 0);
  for (const p of rows) {
    if (p.direction !== 'out' || p.subType !== 'auto_liquidity' || p.pairedKey != null) continue;
    const match = triggers
      .filter(
        (i) =>
          !taken.has(i.key) &&
          i.feeMsat === p.feeMsat &&
          Math.abs(i.completedAt - p.completedAt) <= PAIR_WINDOW_SEC
      )
      .sort(
        (a, b) => Math.abs(a.completedAt - p.completedAt) - Math.abs(b.completedAt - p.completedAt)
      )[0];
    if (!match) continue;
    taken.add(match.key);
    db.update(t).set({ review: 'paired', pairedKey: match.key }).where(eq(t.id, p.id)).run();
  }
}

/** Adds memo, comment, Lightning Address and zap sender. Returns an error, if any. */
async function enrichFromLnbits(
  lb: NonNullable<ReturnType<typeof lnbitsFor>>,
  nodeId: string,
  fromSec: number
): Promise<string | null> {
  const byHash = new Map<string, LnbitsPayment>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await lb.listPayments(PAGE, page * PAGE);
    if (!r.ok) return describeError(r);
    if (r.data.length === 0) break;
    for (const p of r.data) if (p.amountMsat > 0) byHash.set(p.paymentHash, p);
    if (r.data.reduce((m, p) => Math.min(m, p.time), Infinity) < fromSec - 3600) break;
  }
  if (byHash.size === 0) return null;

  const t = schema.lightningPayments;
  const rows = db
    .select({ id: t.id, paymentHash: t.paymentHash })
    .from(t)
    .where(and(eq(t.nodeId, nodeId), eq(t.direction, 'in')))
    .all();
  db.transaction((tx) => {
    for (const row of rows) {
      const p = row.paymentHash ? byHash.get(row.paymentHash) : undefined;
      if (!p) continue;
      tx.update(t)
        .set({
          memo: p.memo,
          comment: p.comment,
          lnAddress: p.lnAddress,
          zapPubkey: p.zap && isHexKey(p.zap.pubkey) ? p.zap.pubkey : null,
          zapContent: p.zap ? p.zap.content.slice(0, 500) : null,
          zapVerified: p.zap ? verifyZapRequest(p.zap, p.amountMsat) : null
        })
        .where(eq(t.id, row.id))
        .run();
    }
  });
  return null;
}
