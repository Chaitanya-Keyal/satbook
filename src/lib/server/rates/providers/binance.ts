// Binance BTCUSDT ticker: USD leg of the live-price fallback. Geo-blocked from
// US IPs — deploy region must be India/SG/EU (see docs/plan.md).

export async function fetchBtcUsdt(): Promise<number | null> {
	try {
		const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { price?: string | number };
		const price = Number(json?.price);
		return Number.isFinite(price) && price > 0 ? price : null;
	} catch {
		return null;
	}
}
