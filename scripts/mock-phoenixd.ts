// A stand-in phoenixd (and LNbits) for developing and testing the Lightning
// module without a node or real money. It serves one made-up history, in the
// exact JSON shapes the real APIs use: a bootstrap that bought liquidity, a
// Lightning Address payment with a comment, a verified zap, a zap with a
// forged signature, a payment to a CLI invoice, a sweep on-chain, a payment out
// and a donation that set off a second liquidity purchase.
//
//   bun scripts/mock-phoenixd.ts
//   PHOENIXD_URL=http://127.0.0.1:9740 PHOENIXD_PASSWORD=mock-limited \
//   LNBITS_URL=http://127.0.0.1:5000 LNBITS_INVOICE_KEY=mock-invoice-key bun run dev
//
// Environment: MOCK_PHOENIXD_PORT (9740), MOCK_LNBITS_PORT (5000),
// MOCK_CHAIN (mainnet), MOCK_SCOPE (limited | full: the password satbook is
// pretending to hold).

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

const sha256Hex = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const hash = (label: string) => sha256Hex(`satbook mock: ${label}`);
/** Stable across restarts, so a dev database never sees the same payment twice. */
const uuid = (label: string) => {
	const h = hash(label);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export const MOCK_PASSWORD = { limited: 'mock-limited', full: 'mock-full' } as const;
export const MOCK_INVOICE_KEY = 'mock-invoice-key';
export const MOCK_ADDRESS = 'you@example.com';
const RECIPIENT = hash('recipient pubkey'); // stands in for the address owner's nostr key

/** A zap request (NIP-57, kind 9734) signed by a throwaway key, or forged. */
function zapRequest(amountMsat: number, content: string, createdAt: number, forged = false) {
	const sk = hexToBytes(hash('zapper secret key'));
	const pubkey = bytesToHex(schnorr.getPublicKey(sk));
	const tags = [
		['relays', 'wss://relay.example.com'],
		['amount', String(amountMsat)],
		['p', RECIPIENT]
	];
	const id = sha256Hex(JSON.stringify([0, pubkey, createdAt, 9734, tags, content]));
	const sig = forged ? '0'.repeat(128) : bytesToHex(schnorr.sign(hexToBytes(id), sk));
	return JSON.stringify({ pubkey, created_at: createdAt, kind: 9734, tags, content, id, sig });
}

export interface Scenario {
	info: Record<string, unknown>;
	balance: Record<string, unknown>;
	incoming: Record<string, unknown>[];
	outgoing: Record<string, unknown>[];
	lnbits: Record<string, unknown>[];
}

/** The history, relative to `nowSec`, with phoenixd's ms timestamps and msat fees. */
export function scenario(nowSec: number, chain = 'mainnet'): Scenario {
	const DAY = 86400;
	const ms = (sec: number) => sec * 1000;
	const iso = (sec: number) => new Date(sec * 1000).toISOString();
	const incoming: Record<string, unknown>[] = [];
	const outgoing: Record<string, unknown>[] = [];
	const lnbits: Record<string, unknown>[] = [];

	const received = (
		label: string,
		at: number,
		requestedSat: number,
		feeSat: number,
		description?: string
	) => {
		const paymentHash = hash(label);
		incoming.push({
			type: 'incoming_payment',
			subType: 'lightning',
			paymentHash,
			preimage: hash(`${label} preimage`),
			externalId: '',
			...(description ? { description } : {}),
			invoice: `lnbc${requestedSat}n1mock${label.replace(/\W/g, '')}`,
			isPaid: true,
			isExpired: false,
			requestedSat,
			receivedSat: requestedSat - feeSat,
			fees: feeSat * 1000,
			expiresAt: ms(at + 3600),
			completedAt: ms(at),
			createdAt: ms(at - 30)
		});
		return paymentHash;
	};
	const liquidity = (label: string, at: number, feeSat: number) =>
		outgoing.push({
			type: 'outgoing_payment',
			subType: 'auto_liquidity',
			paymentId: uuid(`${label} purchase`),
			txId: hash(`${label} funding tx`),
			isPaid: true,
			sent: feeSat,
			fees: feeSat * 1000,
			completedAt: ms(at + 2),
			createdAt: ms(at)
		});
	const viaAddress = (
		paymentHash: string,
		at: number,
		amountSat: number,
		extra: Record<string, unknown>
	) =>
		lnbits.push({
			checking_id: paymentHash,
			payment_hash: paymentHash,
			wallet_id: 'mockwallet',
			amount: amountSat * 1000,
			fee: 0,
			status: 'success',
			memo: `Payment to ${MOCK_ADDRESS}`,
			tag: 'lnurlp',
			time: iso(at),
			extra: { tag: 'lnurlp', link: 'mock01', lnaddress: MOCK_ADDRESS, ...extra }
		});

	// 1. the bootstrap: your own 30k from another wallet buys the first 2M of inbound
	const t1 = nowSec - 10 * DAY;
	received('bootstrap', t1, 30_000, 21_711, 'bootstrap');
	liquidity('bootstrap', t1, 21_711);

	// 2. a Lightning Address payment with a comment
	const t2 = nowSec - 8 * DAY;
	viaAddress(received('comment', t2, 21_000, 0), t2, 21_000, {
		comment: 'Thanks for the open-source work'
	});

	// 3. a zap with a valid signature, and 4. one whose signature is forged
	const t3 = nowSec - 6 * DAY;
	viaAddress(received('zap', t3, 2_100, 0), t3, 2_100, {
		nostr: zapRequest(2_100_000, 'great post', t3 - 5)
	});
	const t4 = nowSec - 5 * DAY;
	viaAddress(received('forged zap', t4, 500, 0), t4, 500, {
		nostr: zapRequest(500_000, 'trust me', t4 - 5, true)
	});

	// 5. a payment to an invoice made with the CLI (LNbits never saw it)
	received('cli invoice', nowSec - 3 * DAY, 50_000, 0, 'invoice from the CLI');

	// 6. a sweep to cold storage: 60 000 out on-chain plus a 1 200 mining fee
	const t6 = nowSec - 2 * DAY;
	outgoing.push({
		type: 'outgoing_payment',
		subType: 'splice_out',
		paymentId: uuid('sweep'),
		txId: hash('sweep tx'),
		isPaid: true,
		sent: 61_200,
		fees: 1_200_000,
		completedAt: ms(t6 + 600),
		createdAt: ms(t6)
	});

	// 7. a Lightning payment out: 1 000 plus a 4 sat routing fee
	const t7 = nowSec - DAY;
	outgoing.push({
		type: 'outgoing_payment',
		subType: 'lightning',
		paymentId: uuid('payment out'),
		paymentHash: hash('payment out'),
		preimage: hash('payment out preimage'),
		isPaid: true,
		sent: 1_004,
		fees: 4_000,
		invoice: 'lnbc10u1mockpaymentout',
		completedAt: ms(t7 + 3),
		createdAt: ms(t7)
	});

	// 8. a donation that arrives once inbound is used up: a second purchase
	const t8 = nowSec - 12 * 3600;
	viaAddress(received('donation with top-up', t8, 40_000, 22_100), t8, 40_000, {
		comment: 'keep building'
	});
	liquidity('second top-up', t8, 22_100);

	const balanceSat = 8_289 + 21_000 + 2_100 + 500 + 50_000 - 61_200 - 1_004 + 17_900;
	const capacitySat = 4_068_800;
	return {
		info: {
			nodeId: `02${hash('node id')}`,
			channels: [
				{
					state: 'Normal',
					channelId: hash('channel'),
					balanceSat,
					inboundLiquiditySat: capacitySat - balanceSat - 40_000,
					capacitySat,
					fundingTxId: hash('second top-up funding tx')
				},
				{
					state: 'Closed',
					channelId: hash('old channel'),
					balanceSat: 999,
					inboundLiquiditySat: 0,
					capacitySat: 100_000,
					fundingTxId: hash('old funding tx')
				}
			],
			chain,
			blockHeight: 900_000,
			version: '0.9.3-mock'
		},
		balance: {
			balanceSat,
			feeCreditSat: 0,
			swapIn: {
				unconfirmedBalanceSat: 0,
				weaklyConfirmedBalanceSat: 0,
				deeplyConfirmedBalanceSat: 0
			}
		},
		incoming,
		outgoing,
		lnbits
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body, null, 4), {
		status,
		headers: { 'content-type': 'application/json' }
	});

/** phoenixd's API over `s`. Pure: (Request) → Response, so tests can call it directly. */
export function phoenixdHandler(s: Scenario, scope: 'limited' | 'full' = 'limited') {
	return async (req: Request): Promise<Response> => {
		const auth = req.headers.get('authorization') ?? '';
		const password = Buffer.from(auth.replace(/^Basic /, ''), 'base64')
			.toString()
			.replace(/^[^:]*:/, '');
		if (password !== MOCK_PASSWORD[scope]) return new Response('Unauthorized', { status: 401 });
		const url = new URL(req.url);
		const q = url.searchParams;
		const page = <T>(rows: T[]) => {
			const offset = Number(q.get('offset') ?? 0);
			return rows.slice(offset, offset + Number(q.get('limit') ?? 20));
		};
		switch (`${req.method} ${url.pathname}`) {
			case 'GET /getinfo':
				return json(s.info);
			case 'GET /getbalance':
				return json(s.balance);
			case 'GET /estimateliquidityfees': {
				const amount = Number(q.get('amountSat') ?? 0);
				return json({ miningFeeSat: 411, serviceFeeSat: Math.round(amount / 100) + 1_000 });
			}
			case 'GET /payments/incoming': {
				const from = Number(q.get('from') ?? 0);
				const rows = s.incoming
					.filter((p) => (p.completedAt as number) >= from)
					.sort((a, b) => (b.completedAt as number) - (a.completedAt as number));
				return json(page(rows));
			}
			case 'GET /payments/outgoing':
				return json(page(s.outgoing));
			case 'POST /payinvoice':
				// The limited password is refused before the invoice is read; only
				// the full one gets far enough to reject it. Nothing is ever paid.
				return scope === 'full'
					? new Response('invalid invoice', { status: 400 })
					: new Response('Unauthorized', { status: 401 });
			default:
				return new Response('Not Found', { status: 404 });
		}
	};
}

/** LNbits' API over `s`, for an invoice key. */
export function lnbitsHandler(s: Scenario) {
	return async (req: Request): Promise<Response> => {
		if (req.headers.get('x-api-key') !== MOCK_INVOICE_KEY)
			return json({ detail: 'Invalid key' }, 401);
		const url = new URL(req.url);
		if (url.pathname === '/api/v1/wallet') return json({ name: 'donations', balance: 0 });
		if (url.pathname === '/api/v1/payments/paginated') {
			const q = url.searchParams;
			const offset = Number(q.get('offset') ?? 0);
			const rows = [...s.lnbits].sort((a, b) => String(b.time).localeCompare(String(a.time)));
			return json({
				data: rows.slice(offset, offset + Number(q.get('limit') ?? 20)),
				total: rows.length
			});
		}
		return json({ detail: 'Not Found' }, 404);
	};
}

if (import.meta.main) {
	const s = scenario(Math.floor(Date.now() / 1000), process.env.MOCK_CHAIN ?? 'mainnet');
	const scope = process.env.MOCK_SCOPE === 'full' ? 'full' : 'limited';
	const phoenixdPort = Number(process.env.MOCK_PHOENIXD_PORT ?? 9740);
	const lnbitsPort = Number(process.env.MOCK_LNBITS_PORT ?? 5000);
	Bun.serve({ hostname: '127.0.0.1', port: phoenixdPort, fetch: phoenixdHandler(s, scope) });
	Bun.serve({ hostname: '127.0.0.1', port: lnbitsPort, fetch: lnbitsHandler(s) });
	console.log(
		`mock phoenixd on http://127.0.0.1:${phoenixdPort} (password ${MOCK_PASSWORD[scope]})`
	);
	console.log(`mock LNbits on http://127.0.0.1:${lnbitsPort} (invoice key ${MOCK_INVOICE_KEY})`);
}
