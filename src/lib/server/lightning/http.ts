// One request helper for the Lightning clients. Unlike the rate providers,
// which only need "a value or nothing", the dashboard has to say WHY a node is
// unavailable, so failures come back as a reason instead of null.

export type FetchError =
	| { error: 'unreachable'; detail: string }
	| { error: 'unauthorized'; detail: string }
	| { error: 'http'; status: number; detail: string }
	| { error: 'bad_response'; detail: string };

export type Fetched<T> = ({ ok: true } & { data: T }) | ({ ok: false } & FetchError);

export interface RequestOptions {
	headers: Record<string, string>;
	proxy: string | null;
	method?: 'GET' | 'POST';
	/** Sent form-encoded (phoenixd's POST endpoints take forms, not JSON). */
	form?: Record<string, string>;
	timeoutMs?: number;
}

/** Raw request: the status and body text, or why there was no response. */
export async function request(
	url: string,
	opts: RequestOptions
): Promise<{ ok: true; status: number; text: string } | ({ ok: false } & FetchError)> {
	const init: RequestInit & { proxy?: string } = {
		method: opts.method ?? 'GET',
		headers: opts.form
			? { ...opts.headers, 'content-type': 'application/x-www-form-urlencoded' }
			: opts.headers,
		body: opts.form ? new URLSearchParams(opts.form).toString() : undefined,
		signal: AbortSignal.timeout(opts.timeoutMs ?? 5000)
	};
	if (opts.proxy) init.proxy = opts.proxy; // Bun's fetch: per-request proxy
	try {
		const res = await fetch(url, init);
		return { ok: true, status: res.status, text: await res.text() };
	} catch (e) {
		const name = e instanceof Error ? e.name : '';
		return {
			ok: false,
			error: 'unreachable',
			detail: name === 'TimeoutError' ? 'timed out' : e instanceof Error ? e.message : String(e)
		};
	}
}

/** GET/POST returning JSON, validated by `parse` (null = malformed). */
export async function requestJson<T>(
	url: string,
	opts: RequestOptions,
	parse: (json: unknown) => T | null
): Promise<Fetched<T>> {
	const res = await request(url, opts);
	if (!res.ok) return res;
	if (res.status === 401 || res.status === 403)
		return { ok: false, error: 'unauthorized', detail: `HTTP ${res.status}` };
	if (res.status < 200 || res.status >= 300)
		return { ok: false, error: 'http', status: res.status, detail: res.text.slice(0, 200) };
	let json: unknown;
	try {
		json = JSON.parse(res.text);
	} catch {
		return { ok: false, error: 'bad_response', detail: 'not JSON' };
	}
	const data = parse(json);
	return data == null
		? { ok: false, error: 'bad_response', detail: 'unexpected shape' }
		: { ok: true, data };
}

/** A short sentence for the UI. */
export function describeError(e: FetchError): string {
	switch (e.error) {
		case 'unreachable':
			return `unreachable (${e.detail})`;
		case 'unauthorized':
			return 'rejected the credentials';
		case 'http':
			return `answered HTTP ${e.status}`;
		case 'bad_response':
			return `sent a response satbook does not understand (${e.detail})`;
	}
}

// --- tolerant field readers -------------------------------------------------

export const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
export const num = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;
export const int = (v: unknown): number | null =>
	typeof v === 'number' && Number.isInteger(v) ? v : null;
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** Non-empty string, else null (phoenixd sends "" for an unset externalId). */
export const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
