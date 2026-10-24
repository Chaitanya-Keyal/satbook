// Maps the entry form's POST body (hidden canonical fields) to the plain
// object ledger.ts#parseDraft expects. All coercion/validation happens server
// side in ledger.ts — this only plucks the known fields, so a stray form field
// can never smuggle extra columns into the insert.

import type { DraftTx } from '../../types';

const FIELDS = [
	'type',
	'ts',
	'seq',
	'walletId',
	'fromWalletId',
	'toWalletId',
	'amountSats',
	'feeSats',
	'fiatCurrency',
	'fiatAmountMinor',
	'fxRateToInr',
	'inrValueMinor',
	'feeInrValueMinor',
	'btcUsdRate',
	'enteredRate',
	'rateSource',
	'txid',
	'refKind',
	'incomeKind',
	'counterparty',
	'notes'
] as const;

// Every draft field must be plucked here. A field the form posts but this list
// omits is dropped silently — it once cost three columns' worth of entries —
// so a missing one is now a compile error rather than lost data.
type Unplucked = Exclude<keyof Omit<DraftTx, 'id'>, (typeof FIELDS)[number]>;
const _everyFieldPlucked: [Unplucked] extends [never] ? true : Unplucked = true;
void _everyFieldPlucked;

export function draftFromFormData(form: FormData): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	for (const f of FIELDS) {
		const v = form.get(f);
		out[f] = typeof v === 'string' ? v : null;
	}
	return out;
}

/**
 * The withdrawal leg of a composite exchange buy (wd* fields posted alongside
 * the BUY): a TRANSFER draft from the buy's exchange wallet to self custody.
 * Coercion/validation still happens in ledger.ts#createTxPair.
 */
export function withdrawalFromFormData(form: FormData): Record<string, string | null> {
	const get = (k: string) => {
		const v = form.get(k);
		return typeof v === 'string' ? v : null;
	};
	return {
		type: 'TRANSFER',
		ts: get('wdTs'),
		seq: null,
		fromWalletId: get('walletId'),
		toWalletId: get('wdToWalletId'),
		amountSats: get('wdAmountSats'),
		feeSats: get('wdFeeSats'),
		feeInrValueMinor: get('wdFeeInrValueMinor'),
		txid: get('wdTxid'),
		notes: null
	};
}
