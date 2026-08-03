// Maps the entry form's POST body (hidden canonical fields) to the plain
// object ledger.ts#parseDraft expects. All coercion/validation happens server
// side in ledger.ts — this only plucks the known fields, so a stray form field
// can never smuggle extra columns into the insert.

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
	'notes'
] as const;

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
