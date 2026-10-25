// NIP-57 zap requests: the signed nostr event (kind 9734) a zapper's client
// hands the Lightning Address server, which LNbits stores as a JSON string.
// LNbits does not verify it, so anyone can claim any sender. A valid signature
// alone proves little: paid zap requests are public (zap receipts embed them),
// so one can be lifted and attached to any payment. satbook calls a sender
// verified only when the request is signed by it AND bound to this payment.

import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/curves/utils.js';
import { bech32 } from '@scure/base';

export interface ZapRequest {
  id: string;
  pubkey: string;
  createdAt: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
export const isHexKey = (s: string) => HEX64.test(s);
const HEX128 = /^[0-9a-f]{128}$/;

/** The stored JSON string → a structurally sound event, else null. */
export function parseZapRequest(raw: unknown): ZapRequest | null {
  let j: unknown = raw;
  if (typeof raw === 'string') {
    try {
      j = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof j !== 'object' || j === null) return null;
  const e = j as Record<string, unknown>;
  if (
    typeof e.id !== 'string' ||
    typeof e.pubkey !== 'string' ||
    typeof e.sig !== 'string' ||
    typeof e.content !== 'string' ||
    typeof e.kind !== 'number' ||
    typeof e.created_at !== 'number' ||
    !Array.isArray(e.tags) ||
    !e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  )
    return null;
  return {
    id: e.id.toLowerCase(),
    pubkey: e.pubkey.toLowerCase(),
    createdAt: e.created_at,
    kind: e.kind,
    tags: e.tags as string[][],
    content: e.content,
    sig: e.sig.toLowerCase()
  };
}

/** NIP-01 event id: sha256 of the canonical serialization. */
export function eventId(e: Omit<ZapRequest, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([0, e.pubkey, e.createdAt, e.kind, e.tags, e.content]);
  return new Bun.CryptoHasher('sha256').update(serialized).digest('hex');
}

/** How long before its payment a zap request may have been made. */
export const ZAP_MAX_AGE_SEC = 3600;
/** How far ahead of ours the zapper's clock may run. */
const CLOCK_SKEW_SEC = 600;

export interface ZapContext {
  /** Our hex pubkey, which the request must be addressed to. Without it nothing verifies. */
  recipient: string | null;
  /** What was paid, in msat. */
  paidMsat: number;
  /** When the payment completed, unix seconds. */
  completedAt: number;
}

/**
 * Whether a zap request names the sender of this payment: a kind-9734 event,
 * correctly hashed and signed, addressed to exactly our pubkey, for exactly
 * the amount paid, and made shortly before the payment. One request naming
 * two payments is caught by the caller, which can see the other payments.
 */
export function verifyZapRequest(e: ZapRequest, ctx: ZapContext): boolean {
  if (!ctx.recipient) return false;
  if (e.kind !== 9734) return false;
  if (!HEX64.test(e.pubkey) || !HEX64.test(e.id) || !HEX128.test(e.sig)) return false;
  const p = e.tags.filter((t) => t[0] === 'p');
  if (p.length !== 1 || p[0][1]?.toLowerCase() !== ctx.recipient) return false;
  const amount = e.tags.filter((t) => t[0] === 'amount');
  if (amount.length !== 1 || !/^\d+$/.test(amount[0][1] ?? '')) return false;
  if (Number(amount[0][1]) !== ctx.paidMsat) return false;
  const age = ctx.completedAt - e.createdAt;
  if (age > ZAP_MAX_AGE_SEC || age < -CLOCK_SKEW_SEC) return false;
  if (eventId(e) !== e.id) return false;
  try {
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

/** An npub or a 64-character hex key → the hex key, else null. */
export function parseNostrPubkey(raw: string): string | null {
  const v = raw.trim();
  if (HEX64.test(v.toLowerCase())) return v.toLowerCase();
  if (!/^npub1/i.test(v)) return null;
  try {
    const { prefix, words } = bech32.decode(v.toLowerCase() as `${string}1${string}`);
    if (prefix !== 'npub') return null;
    const bytes = bech32.fromWords(words);
    if (bytes.length !== 32) return null;
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** A hex pubkey as a NIP-19 npub. */
export function npub(pubkeyHex: string): string {
  return bech32.encode('npub', bech32.toWords(hexToBytes(pubkeyHex)));
}
