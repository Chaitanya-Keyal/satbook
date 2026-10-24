// The review inbox: synced payments that are not in the ledger yet, and the
// writes that settle them — record (through createTx, so every rule a hand
// entry meets applies), link to a row entered by hand, or ignore.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { createTx } from '../ledger';
import { getBtcInrAt } from '../rates';
import { mulDivRound, SATS_PER_BTC } from '../../utils/money';
import { type Decision, draftFor, type StoredPayment, type Suggestion, suggest } from './classify';
import { importKeyFor, ledgerLinks, lightningWallet } from './node';
import { lastSync } from './sync';

export const IMPORT_SOURCE = 'import:phoenixd' as const;

export interface LinkCandidate {
  id: number;
  type: string;
  ts: number;
  amountSats: number;
  notes: string | null;
}

export interface PendingPayment {
  row: StoredPayment;
  suggestion: Suggestion;
  /** INR value of the suggested amount at the payment's time, if a rate exists. */
  inrMinor: number | null;
  candidates: LinkCandidate[];
}

/** The node whose payments are under review: the one the last sync reached. */
export function currentNode(): { nodeId: string; mainnet: boolean } | null {
  const s = lastSync();
  return s?.nodeId ? { nodeId: s.nodeId, mainnet: s.chain === 'mainnet' } : null;
}

function unsettled(nodeId: string): StoredPayment[] {
  const t = schema.lightningPayments;
  const rows = db
    .select()
    .from(t)
    .where(and(eq(t.nodeId, nodeId), eq(t.review, 'pending')))
    .all();
  const linked = ledgerLinks(rows);
  // Oldest first: recorded in order, each payment finds the sats it needs
  // (a sweep recorded before the payments that funded it would be refused).
  return rows.filter((r) => !linked.has(r.key)).sort((a, b) => a.completedAt - b.completedAt);
}

export function pendingCount(): number {
  const node = currentNode();
  return node ? unsettled(node.nodeId).length : 0;
}

/** Rows entered by hand around the payment's time with a matching amount. */
function linkCandidates(p: StoredPayment, s: Suggestion): LinkCandidate[] {
  const tx = schema.transactions;
  const amounts = [
    ...new Set([s.figures.amountSats, s.figures.creditedSats, p.amountSat].filter((a) => a > 0))
  ];
  if (amounts.length === 0) return [];
  return db
    .select({
      id: tx.id,
      type: tx.type,
      ts: tx.ts,
      amountSats: tx.amountSats,
      notes: tx.notes,
      importKey: tx.importKey
    })
    .from(tx)
    .where(and(isNull(tx.importKey), inArray(tx.amountSats, amounts)))
    .all()
    .filter((r) => Math.abs(r.ts - p.completedAt) <= 86400)
    .map(({ importKey: _, ...r }) => r);
}

export async function pendingPayments(): Promise<PendingPayment[]> {
  const node = currentNode();
  if (!node) return [];
  const out: PendingPayment[] = [];
  for (const row of unsettled(node.nodeId)) {
    const suggestion = suggest(row);
    let inrMinor: number | null = null;
    if (suggestion.actions.length > 0) {
      try {
        const hit = await getBtcInrAt(row.completedAt);
        if (hit)
          inrMinor = mulDivRound(
            Math.round(hit.rate * 100),
            suggestion.figures.amountSats,
            SATS_PER_BTC
          );
      } catch {
        inrMinor = null;
      }
    }
    out.push({ row, suggestion, inrMinor, candidates: linkCandidates(row, suggestion) });
  }
  return out;
}

export function ignoredPayments(): StoredPayment[] {
  const node = currentNode();
  if (!node) return [];
  const t = schema.lightningPayments;
  return db
    .select()
    .from(t)
    .where(and(eq(t.nodeId, node.nodeId), eq(t.review, 'ignored')))
    .all()
    .sort((a, b) => b.completedAt - a.completedAt);
}

type Result = { ok: true; id?: number } | { ok: false; error: string };

function findPending(key: string): StoredPayment | { error: string } {
  const node = currentNode();
  if (!node) return { error: 'no node has been synced yet' };
  const t = schema.lightningPayments;
  const row = db
    .select()
    .from(t)
    .where(and(eq(t.nodeId, node.nodeId), eq(t.key, key)))
    .get();
  if (!row) return { error: 'unknown payment' };
  if (row.review !== 'pending') return { error: 'this payment is not up for review' };
  if (ledgerLinks([row]).has(row.key)) return { error: 'already recorded in the ledger' };
  return row;
}

/**
 * Write the ledger row for one payment. Test-network payments are refused
 * unless `allowTestnet` (dev servers), so they can never reach a real ledger.
 */
export async function recordPayment(
  key: string,
  decision: Decision,
  opts: { allowTestnet: boolean }
): Promise<Result> {
  const node = currentNode();
  if (node && !node.mainnet && !opts.allowTestnet)
    return { ok: false, error: 'this is a test-network node; its payments stay out of the ledger' };
  const wallet = lightningWallet();
  if (!wallet)
    return { ok: false, error: 'choose the wallet that stands for the node in Settings' };
  const row = findPending(key);
  if ('error' in row) return { ok: false, error: row.error };
  const hit = await getBtcInrAt(row.completedAt).catch(() => null);
  if (!hit) return { ok: false, error: 'no BTC/INR rate for this time yet — try again later' };
  const built = draftFor(row, decision, {
    nodeWalletId: wallet.id,
    rate: hit.rate,
    rateSource: hit.source
  });
  if (!built.ok) return { ok: false, error: built.error };
  const res = createTx(built.draft, { source: IMPORT_SOURCE, importKey: importKeyFor(row.key) });
  return res.ok ? { ok: true, id: res.id } : { ok: false, error: res.errors.join('; ') };
}

/** Claim a row entered by hand for this payment (it gets the payment's import key). */
export function linkPayment(key: string, txId: number): Result {
  const row = findPending(key);
  if ('error' in row) return { ok: false, error: row.error };
  const tx = schema.transactions;
  const target = db.select().from(tx).where(eq(tx.id, txId)).get();
  if (!target) return { ok: false, error: 'unknown ledger row' };
  if (target.importKey != null)
    return { ok: false, error: 'that row already belongs to an import' };
  db.update(tx)
    .set({ importKey: importKeyFor(row.key) })
    .where(eq(tx.id, txId))
    .run();
  return { ok: true, id: txId };
}

export function setIgnored(keys: string[], ignored: boolean): number {
  const node = currentNode();
  if (!node || keys.length === 0) return 0;
  const t = schema.lightningPayments;
  return db
    .update(t)
    .set({ review: ignored ? 'ignored' : 'pending' })
    .where(
      and(
        eq(t.nodeId, node.nodeId),
        inArray(t.key, keys),
        eq(t.review, ignored ? 'pending' : 'ignored')
      )
    )
    .returning({ id: t.id })
    .all().length;
}

/** Everything before `ts` still pending — e.g. history already recorded elsewhere. */
export function ignoreBefore(ts: number): number {
  const node = currentNode();
  if (!node) return 0;
  const keys = unsettled(node.nodeId)
    .filter((r) => r.completedAt < ts)
    .map((r) => r.key);
  return setIgnored(keys, true);
}

/** Record a payment exactly as suggested, as income of `kind` (the bulk action). */
export async function recordAsSuggested(
  key: string,
  kind: 'donation' | 'grant' | 'income',
  opts: { allowTestnet: boolean }
): Promise<Result> {
  const row = findPending(key);
  if ('error' in row) return { ok: false, error: row.error };
  const s = suggest(row);
  return recordPayment(
    key,
    { action: 'income', kind, counterparty: s.counterparty, note: s.note },
    opts
  );
}
