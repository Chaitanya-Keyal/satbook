// NIP-57 zap requests: the signed nostr event (kind 9734) a zapper's client
// hands the Lightning Address server, which LNbits stores as a JSON string.
// LNbits does not verify it, so anyone can claim any sender; satbook checks
// the event id and the BIP-340 signature itself before calling it verified.

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

/**
 * A zap request is trusted only if it is a kind-9734 event whose id matches its
 * content and whose signature verifies against the claimed pubkey. When the
 * request names an amount it must match what was actually paid.
 */
export function verifyZapRequest(e: ZapRequest, paidMsat: number | null): boolean {
	if (e.kind !== 9734) return false;
	if (!HEX64.test(e.pubkey) || !HEX64.test(e.id) || !HEX128.test(e.sig)) return false;
	if (eventId(e) !== e.id) return false;
	const amount = e.tags.find((t) => t[0] === 'amount')?.[1];
	if (amount != null && paidMsat != null && Number(amount) !== paidMsat) return false;
	try {
		return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
	} catch {
		return false;
	}
}

/** A hex pubkey as a NIP-19 npub. */
export function npub(pubkeyHex: string): string {
	return bech32.encode('npub', bech32.toWords(hexToBytes(pubkeyHex)));
}
