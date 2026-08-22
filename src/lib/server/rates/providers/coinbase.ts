// Coinbase spot in USD: works from every region and serves any past date at
// daily granularity, making it the universal fallback for both the live price
// and historical lookups.

/** date is 'YYYY-MM-DD' (UTC) or 'spot' for the current price. USD per BTC. */
export async function fetchBtcUsd(date?: string): Promise<number | null> {
	try {
		const q = date ? `?date=${date}` : '';
		const res = await fetch(`https://api.coinbase.com/v2/prices/BTC-USD/spot${q}`, {
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { data?: { amount?: string | number } };
		const amount = Number(json?.data?.amount);
		return Number.isFinite(amount) && amount > 0 ? amount : null;
	} catch {
		return null;
	}
}
