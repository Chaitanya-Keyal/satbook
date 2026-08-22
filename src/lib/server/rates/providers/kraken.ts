// Kraken XBT/USD spot: live-price fallback that works from US IPs (where
// Binance is geo-blocked). Its OHLC window is only ~720 candles, so it is
// deliberately not used for history.

export async function fetchBtcUsd(): Promise<number | null> {
	try {
		const res = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', {
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { result?: Record<string, { c?: [string, string] }> };
		const pair = Object.values(json?.result ?? {})[0];
		const price = Number(pair?.c?.[0]);
		return Number.isFinite(price) && price > 0 ? price : null;
	} catch {
		return null;
	}
}
