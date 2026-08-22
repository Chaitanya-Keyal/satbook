// Binance BTCUSDT: the primary global (US-market convention) BTC price, spot
// and historical. Geo-blocked from US IPs — Coinbase and Kraken cover that
// case; INR is always derived as USD × the ECB FX rate for the same date.

export interface UsdCandle {
	periodStart: number; // unix sec UTC (API returns period-start ms)
	close: number; // USD per BTC
}

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

/** Klines back to 2017 at 1m–1d granularity; ≤1000 candles per call. */
export async function fetchKlines(
	interval: '1h' | '1d',
	startTimeMs: number,
	endTimeMs: number
): Promise<UsdCandle[] | null> {
	try {
		const url =
			`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}` +
			`&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=1000`;
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return null;
		const json = (await res.json()) as unknown[];
		if (!Array.isArray(json)) return null;
		const out: UsdCandle[] = [];
		for (const row of json) {
			// [openTime, open, high, low, close, volume, closeTime, ...]
			if (!Array.isArray(row)) continue;
			const openTimeMs = Number(row[0]);
			const close = Number(row[4]);
			if (!Number.isFinite(openTimeMs) || !Number.isFinite(close) || close <= 0) continue;
			out.push({ periodStart: Math.floor(openTimeMs / 1000), close });
		}
		return out;
	} catch {
		return null;
	}
}
