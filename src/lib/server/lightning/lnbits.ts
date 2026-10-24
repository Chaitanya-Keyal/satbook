// LNbits, read with an invoice (read-only) key. It knows what phoenixd cannot:
// a Lightning Address payment's comment and, for zaps, the nostr zap request.
// LNURL-pay invoices commit to a description hash, so phoenixd itself only
// ever sees the hash, never the words.

import type { LightningConfig } from './config';
import { type Fetched, int, isObj, requestJson, str, text } from './http';
import { parseZapRequest, type ZapRequest } from './zap';

export interface LnbitsPayment {
	paymentHash: string;
	/** Millisatoshis; positive for incoming. */
	amountMsat: number;
	status: string;
	/** unix sec */
	time: number;
	memo: string | null;
	comment: string | null;
	lnAddress: string | null;
	zap: ZapRequest | null;
}

/** Payer-supplied text is capped before it is stored or shown. */
const cap = (s: string | null, n = 500) => (s == null ? null : s.slice(0, n));

export function parseLnbitsPayment(j: unknown): LnbitsPayment | null {
	if (!isObj(j)) return null;
	const paymentHash = str(j.payment_hash);
	const amountMsat = int(j.amount);
	const time = Date.parse(str(j.time) ?? '');
	if (!paymentHash || amountMsat == null || !Number.isFinite(time)) return null;
	const extra = isObj(j.extra) ? j.extra : {};
	return {
		paymentHash,
		amountMsat,
		status: str(j.status) ?? (j.pending === false ? 'success' : 'pending'),
		time: Math.floor(time / 1000),
		memo: cap(text(j.memo)),
		comment: cap(text(extra.comment)),
		lnAddress: cap(text(extra.lnaddress), 200),
		zap: extra.nostr != null ? parseZapRequest(extra.nostr) : null
	};
}

function parsePage(j: unknown): LnbitsPayment[] | null {
	if (!isObj(j) || !Array.isArray(j.data)) return null;
	const out: LnbitsPayment[] = [];
	// One odd row (another extension's payment) should not hide the rest.
	for (const p of j.data) {
		const v = parseLnbitsPayment(p);
		if (v) out.push(v);
	}
	return out;
}

export function lnbits(cfg: LightningConfig & { lnbitsUrl: string; lnbitsInvoiceKey: string }) {
	const headers = { 'x-api-key': cfg.lnbitsInvoiceKey };
	return {
		/** Newest first. */
		listPayments: (limit: number, offset: number): Promise<Fetched<LnbitsPayment[]>> =>
			requestJson(
				`${cfg.lnbitsUrl}/api/v1/payments/paginated?limit=${limit}&offset=${offset}&sortby=time&direction=desc`,
				{ headers, proxy: cfg.proxy },
				parsePage
			),
		getWallet: (): Promise<Fetched<{ name: string; balanceMsat: number }>> =>
			requestJson(`${cfg.lnbitsUrl}/api/v1/wallet`, { headers, proxy: cfg.proxy }, (j) => {
				if (!isObj(j)) return null;
				const name = str(j.name);
				const balanceMsat = int(j.balance);
				return name == null || balanceMsat == null ? null : { name, balanceMsat };
			})
	};
}

export function lnbitsFor(cfg: LightningConfig) {
	return cfg.lnbitsUrl && cfg.lnbitsInvoiceKey
		? lnbits({ ...cfg, lnbitsUrl: cfg.lnbitsUrl, lnbitsInvoiceKey: cfg.lnbitsInvoiceKey })
		: null;
}
