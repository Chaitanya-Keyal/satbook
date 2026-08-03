// fawazahmed0 currency-api: historical FX fallback. Date-stamped npm releases
// start 2024-03-02 — callers must not request earlier dates. jsDelivr primary,
// pages.dev mirror second.

/** date is 'YYYY-MM-DD' (must be ≥ 2024-03-02). Returns INR per 1 unit of base. */
export async function fetchFxToInr(base: 'USD' | 'EUR', date: string): Promise<number | null> {
	const cur = base.toLowerCase();
	const urls = [
		`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${cur}.min.json`,
		`https://${date}.currency-api.pages.dev/v1/currencies/${cur}.min.json`
	];
	for (const url of urls) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
			if (!res.ok) continue;
			const json = (await res.json()) as Record<string, Record<string, number> | undefined>;
			const rate = json?.[cur]?.inr;
			if (typeof rate === 'number' && rate > 0) return rate;
		} catch {
			// try the mirror
		}
	}
	return null;
}
