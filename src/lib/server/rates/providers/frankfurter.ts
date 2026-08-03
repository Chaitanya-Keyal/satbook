// frankfurter.dev (ECB rates): FX to INR, latest + historical. Weekend dates
// auto-resolve to the prior business day server-side. One retry on 5xx/timeout
// because Cloudflare 522s have been observed in the wild.

/** date is 'YYYY-MM-DD' or 'latest'. Returns INR per 1 unit of base. */
export async function fetchFxToInr(base: 'USD' | 'EUR', date: string): Promise<number | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await fetch(`https://api.frankfurter.dev/v1/${date}?base=${base}&symbols=INR`, {
				signal: AbortSignal.timeout(5000)
			});
			if (res.ok) {
				const json = (await res.json()) as { rates?: { INR?: number } };
				const rate = json?.rates?.INR;
				return typeof rate === 'number' && rate > 0 ? rate : null;
			}
			if (res.status < 500) return null; // 4xx is definitive — no retry
		} catch {
			// timeout / network error — retry once
		}
	}
	return null;
}
