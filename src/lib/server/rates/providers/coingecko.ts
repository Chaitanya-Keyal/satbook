// CoinGecko: live simple/price (primary live source) + /coins/bitcoin/history
// (last-resort historical, ≤365d on the free tier). Demo key header attached
// only when COINGECKO_DEMO_KEY is set; keyless calls are still attempted.

const BASE = 'https://api.coingecko.com/api/v3';

function headers(): Record<string, string> {
	const key = process.env.COINGECKO_DEMO_KEY;
	return key ? { 'x-cg-demo-api-key': key } : {};
}

export async function fetchSimplePrice(): Promise<{ inr: number; usd: number } | null> {
	try {
		const res = await fetch(`${BASE}/simple/price?ids=bitcoin&vs_currencies=inr,usd`, {
			signal: AbortSignal.timeout(5000),
			headers: headers()
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { bitcoin?: { inr?: number; usd?: number } };
		const inr = json?.bitcoin?.inr;
		const usd = json?.bitcoin?.usd;
		if (typeof inr !== 'number' || typeof usd !== 'number' || inr <= 0 || usd <= 0) return null;
		return { inr, usd };
	} catch {
		return null;
	}
}

/** date is 'DD-MM-YYYY' (CoinGecko's history endpoint format). Returns INR per BTC. */
export async function fetchHistoryInr(date: string): Promise<number | null> {
	try {
		const res = await fetch(`${BASE}/coins/bitcoin/history?date=${date}`, {
			signal: AbortSignal.timeout(5000),
			headers: headers()
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { market_data?: { current_price?: { inr?: number } } };
		const inr = json?.market_data?.current_price?.inr;
		return typeof inr === 'number' && inr > 0 ? inr : null;
	} catch {
		return null;
	}
}
