// Esplora-dialect txid lookup with ordered-host failover. mempool.space is
// last because it is ISP-blocked in India — viable here only because the
// SERVER does the fetch. Confirmed txs are immutable → in-memory cache.

export interface EsploraTxRaw {
	txid: string;
	confirmed: boolean;
	blockTime: number | null;
	feeSats: number;
	outputs: { index: number; address: string | null; valueSats: number }[];
	host: string;
}

const HOSTS = [
	'https://blockstream.info/api',
	'https://mempool.emzy.de/api',
	'https://mempool.space/api'
];

const confirmedTxCache = new Map<string, EsploraTxRaw>();

export async function fetchTx(txid: string): Promise<EsploraTxRaw | null> {
	const cached = confirmedTxCache.get(txid);
	if (cached) return cached;

	for (const host of HOSTS) {
		try {
			const res = await fetch(`${host}/tx/${txid}`, { signal: AbortSignal.timeout(4000) });
			if (!res.ok) continue;
			const parsed = parseTx(await res.json(), host);
			if (!parsed) continue;
			if (parsed.confirmed) confirmedTxCache.set(txid, parsed);
			return parsed;
		} catch {
			// timeout / network / bad JSON — try the next host
		}
	}
	return null;
}

interface EsploraTxJson {
	txid?: string;
	fee?: number;
	status?: { confirmed?: boolean; block_time?: number };
	vout?: { scriptpubkey_address?: string; value?: number }[];
}

function parseTx(json: unknown, host: string): EsploraTxRaw | null {
	const j = json as EsploraTxJson;
	if (!j || typeof j.txid !== 'string' || !Array.isArray(j.vout)) return null;
	const confirmed = j.status?.confirmed === true;
	return {
		txid: j.txid,
		confirmed,
		blockTime: confirmed && typeof j.status?.block_time === 'number' ? j.status.block_time : null,
		feeSats: typeof j.fee === 'number' ? j.fee : 0,
		outputs: j.vout.map((v, index) => ({
			index,
			address: typeof v?.scriptpubkey_address === 'string' ? v.scriptpubkey_address : null,
			valueSats: typeof v?.value === 'number' ? v.value : 0
		})),
		host
	};
}

/** Test hook: clears the confirmed-tx cache. */
export function _clearTxCache(): void {
	confirmedTxCache.clear();
}
