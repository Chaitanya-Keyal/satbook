// CoinDCX: BTCINR ticker (live INR leg fallback) + public candles (primary
// historical source, 1h/1d, keyless, data since ~Jan 2022).

export interface CoindcxCandle {
	periodStart: number; // unix sec UTC (API returns period-start ms)
	close: number; // INR per BTC
}

export async function fetchTickerBtcInr(): Promise<number | null> {
	try {
		const res = await fetch('https://api.coindcx.com/exchange/ticker', {
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { market?: string; last_price?: string | number }[];
		if (!Array.isArray(json)) return null;
		const btcInr = json.find((m) => m?.market === 'BTCINR');
		const price = Number(btcInr?.last_price);
		return Number.isFinite(price) && price > 0 ? price : null;
	} catch {
		return null;
	}
}

/**
 * Returns candles (any order the API gives; typically newest-first), or null on
 * failure. An empty array is a SUCCESSFUL response with no data — callers must
 * distinguish the two.
 */
export async function fetchCandles(
	interval: '1h' | '1d',
	startTimeMs: number,
	endTimeMs: number
): Promise<CoindcxCandle[] | null> {
	try {
		const url =
			`https://public.coindcx.com/market_data/candles?pair=I-BTC_INR&interval=${interval}` +
			`&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=1000`;
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return null;
		const json = (await res.json()) as {
			close?: string | number;
			time?: number;
			volume?: string | number;
		}[];
		if (!Array.isArray(json)) return null;
		const stepMs = interval === '1h' ? 3_600_000 : 86_400_000;
		const out: CoindcxCandle[] = [];
		for (const c of json) {
			const close = Number(c?.close);
			const timeMs = Number(c?.time);
			if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(timeMs)) continue;
			// CoinDCX occasionally emits synthetic zero-volume candles at odd
			// timestamps (e.g. 23:59:59Z) alongside the real period candle —
			// they would shadow the true close in the cache. Drop them.
			if (Number(c?.volume) === 0 && timeMs % stepMs !== 0) continue;
			out.push({ periodStart: Math.floor(timeMs / 1000), close });
		}
		return out;
	} catch {
		return null;
	}
}
