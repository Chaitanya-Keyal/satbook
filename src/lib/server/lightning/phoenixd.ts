// Read-only phoenixd client. Deliberately has no paying or sending calls: the
// module is receive-only, and with phoenixd's limited-access password the node
// would refuse them anyway. Units are normalized here, once: phoenixd sends
// timestamps in milliseconds and fees in millisatoshis; everything that leaves
// this file is unix seconds and whole sats (fees stay msat, named so).

import type { LightningConfig } from './config';
import { type Fetched, int, isObj, num, request, requestJson, str, text } from './http';

export interface NodeChannel {
	state: string;
	channelId: string;
	balanceSat: number;
	inboundLiquiditySat: number;
	capacitySat: number;
	fundingTxId: string | null;
}

export interface NodeInfo {
	nodeId: string;
	/** 'mainnet', or 'testnet3' (older versions: 'testnet'). */
	chain: string;
	blockHeight: number;
	version: string;
	channels: NodeChannel[];
}

export interface NodeBalance {
	balanceSat: number;
	/** Non-refundable; only pays future liquidity fees. */
	feeCreditSat: number;
	/** On-chain deposits waiting to be swapped into a channel. */
	swapInSat: number;
}

export interface LiquidityFees {
	miningFeeSat: number;
	serviceFeeSat: number;
}

export interface IncomingPayment {
	paymentHash: string;
	subType: string;
	isPaid: boolean;
	/** Net of any liquidity fee; negative when a small payment set off a large purchase. */
	receivedSat: number;
	feesMsat: number;
	/** The invoice amount (BOLT11 with an amount): what the payer paid. */
	requestedSat: number | null;
	description: string | null;
	payerNote: string | null;
	externalId: string | null;
	createdAt: number;
	completedAt: number | null;
}

export interface OutgoingPayment {
	paymentId: string;
	subType: string;
	paymentHash: string | null;
	txId: string | null;
	isPaid: boolean;
	/** Sent, fees included. */
	sentSat: number;
	feesMsat: number;
	createdAt: number;
	completedAt: number | null;
}

/** Only channels in this state count toward balance and inbound liquidity. */
export const NORMAL = 'Normal';

const msToSec = (ms: number) => Math.floor(ms / 1000);

// --- parsers (null = malformed) ---------------------------------------------

export function parseNodeInfo(j: unknown): NodeInfo | null {
	if (!isObj(j)) return null;
	const nodeId = str(j.nodeId);
	const chain = str(j.chain);
	const version = str(j.version);
	const blockHeight = int(j.blockHeight);
	if (!nodeId || !chain || version == null || blockHeight == null || !Array.isArray(j.channels))
		return null;
	const channels: NodeChannel[] = [];
	for (const c of j.channels) {
		if (!isObj(c)) return null;
		const state = str(c.state);
		const channelId = str(c.channelId);
		if (!state || !channelId) return null;
		channels.push({
			state,
			channelId,
			balanceSat: int(c.balanceSat) ?? 0,
			inboundLiquiditySat: int(c.inboundLiquiditySat) ?? 0,
			capacitySat: int(c.capacitySat) ?? 0,
			fundingTxId: text(c.fundingTxId)
		});
	}
	return { nodeId, chain, blockHeight, version, channels };
}

export function parseBalance(j: unknown): NodeBalance | null {
	if (!isObj(j)) return null;
	const balanceSat = int(j.balanceSat);
	const feeCreditSat = int(j.feeCreditSat);
	if (balanceSat == null || feeCreditSat == null) return null;
	const swap = isObj(j.swapIn) ? j.swapIn : {};
	const swapInSat =
		(int(swap.unconfirmedBalanceSat) ?? 0) +
		(int(swap.weaklyConfirmedBalanceSat) ?? 0) +
		(int(swap.deeplyConfirmedBalanceSat) ?? 0);
	return { balanceSat, feeCreditSat, swapInSat };
}

export function parseLiquidityFees(j: unknown): LiquidityFees | null {
	if (!isObj(j)) return null;
	const miningFeeSat = int(j.miningFeeSat);
	const serviceFeeSat = int(j.serviceFeeSat);
	return miningFeeSat == null || serviceFeeSat == null ? null : { miningFeeSat, serviceFeeSat };
}

export function parseIncoming(j: unknown): IncomingPayment | null {
	if (!isObj(j)) return null;
	const paymentHash = str(j.paymentHash);
	const createdAt = num(j.createdAt);
	if (!paymentHash || createdAt == null) return null;
	const completedAt = num(j.completedAt);
	return {
		paymentHash,
		subType: str(j.subType) ?? 'lightning',
		isPaid: j.isPaid === true,
		receivedSat: int(j.receivedSat) ?? 0,
		feesMsat: int(j.fees) ?? 0,
		requestedSat: int(j.requestedSat),
		description: text(j.description),
		payerNote: text(j.payerNote),
		externalId: text(j.externalId),
		createdAt: msToSec(createdAt),
		completedAt: completedAt == null ? null : msToSec(completedAt)
	};
}

export function parseOutgoing(j: unknown): OutgoingPayment | null {
	if (!isObj(j)) return null;
	const paymentId = str(j.paymentId);
	const createdAt = num(j.createdAt);
	if (!paymentId || createdAt == null) return null;
	const completedAt = num(j.completedAt);
	return {
		paymentId,
		subType: str(j.subType) ?? 'lightning',
		paymentHash: text(j.paymentHash),
		txId: text(j.txId),
		isPaid: j.isPaid === true,
		sentSat: int(j.sent) ?? 0,
		feesMsat: int(j.fees) ?? 0,
		createdAt: msToSec(createdAt),
		completedAt: completedAt == null ? null : msToSec(completedAt)
	};
}

const listOf =
	<T>(item: (j: unknown) => T | null) =>
	(j: unknown): T[] | null => {
		if (!Array.isArray(j)) return null;
		const out: T[] = [];
		for (const x of j) {
			const v = item(x);
			if (v == null) return null;
			out.push(v);
		}
		return out;
	};

// --- client -------------------------------------------------------------------

export function phoenixd(cfg: LightningConfig) {
	const headers = {
		authorization: `Basic ${Buffer.from(`:${cfg.phoenixdPassword}`).toString('base64')}`
	};
	const get = <T>(path: string, parse: (j: unknown) => T | null): Promise<Fetched<T>> =>
		requestJson(`${cfg.phoenixdUrl}${path}`, { headers, proxy: cfg.proxy }, parse);

	return {
		getInfo: () => get('/getinfo', parseNodeInfo),
		getBalance: () => get('/getbalance', parseBalance),
		estimateLiquidityFees: (amountSat: number) =>
			get(`/estimateliquidityfees?amountSat=${amountSat}`, parseLiquidityFees),
		/** Paid incoming payments completed at or after `fromSec`, newest first. */
		listIncoming: (fromSec: number, limit: number, offset: number) =>
			get(
				`/payments/incoming?from=${fromSec * 1000}&limit=${limit}&offset=${offset}`,
				listOf(parseIncoming)
			),
		/** Successful outgoing payments (phoenixd leaves them unordered). */
		listOutgoing: (limit: number, offset: number) =>
			get(`/payments/outgoing?from=0&limit=${limit}&offset=${offset}`, listOf(parseOutgoing)),
		/**
		 * Which password satbook holds. A pay call with an unparseable invoice
		 * cannot pay anything: the limited password is refused (401) before the
		 * invoice is read, the full one gets as far as rejecting the invoice (400).
		 */
		async passwordScope(): Promise<'limited' | 'full' | 'unknown'> {
			const res = await request(`${cfg.phoenixdUrl}/payinvoice`, {
				headers,
				proxy: cfg.proxy,
				method: 'POST',
				form: { invoice: 'not-an-invoice' }
			});
			if (!res.ok) return 'unknown';
			return res.status === 401 ? 'limited' : res.status === 400 ? 'full' : 'unknown';
		}
	};
}

export type Phoenixd = ReturnType<typeof phoenixd>;
