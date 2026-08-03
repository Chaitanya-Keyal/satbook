// Coinbase daily spot: historical fallback for any date (pre-2022 CoinDCX gap).

/** date is 'YYYY-MM-DD' (UTC). Returns INR per BTC for that date. */
export async function fetchDailySpot(date: string): Promise<number | null> {
	try {
		const res = await fetch(`https://api.coinbase.com/v2/prices/BTC-INR/spot?date=${date}`, {
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
