// Mocked-fetch coverage of the rate service + Esplora client. Every fetch goes
// through the router installed below — NO live network. DATABASE_PATH must be
// set before the db module loads, hence the dynamic imports.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

process.env.DATABASE_PATH = ':memory:';

const { db, schema } = await import('../src/lib/server/db/index');
const rates = await import('../src/lib/server/rates/index');
const esplora = await import('../src/lib/server/esplora');

// ---------------------------------------------------------------------------
// fetch router
// ---------------------------------------------------------------------------

type Handler = (url: string) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
let calls: string[] = [];
let routes: { substr: string; handler: Handler }[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
	const url =
		typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
	calls.push(url);
	for (const r of routes) if (url.includes(r.substr)) return r.handler(url);
	throw new Error(`unmocked fetch: ${url}`);
}) as typeof fetch;

afterAll(() => {
	globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const route = (substr: string, handler: Handler) => routes.push({ substr, handler });
const fail = (substr: string, status = 500) => route(substr, () => json({ error: 'boom' }, status));
const timeout = (substr: string) =>
	route(substr, () => {
		throw new DOMException('The operation timed out', 'TimeoutError');
	});
const callsTo = (substr: string) => calls.filter((u) => u.includes(substr)).length;

const HOUR = 3600;
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const floorHour = (ts: number) => Math.floor(ts / HOUR) * HOUR;
const floorDay = (ts: number) => Math.floor(ts / DAY) * DAY;

function insertCandle(
	interval: '1h' | '1d',
	periodStart: number,
	close: number,
	source = 'coindcx'
) {
	db.insert(schema.priceCandles)
		.values({ pair: 'BTC_INR', interval, periodStart, close, source, fetchedAt: now() })
		.run();
}

function insertLive(btcInr: number, btcUsd: number, fetchedAt: number) {
	db.insert(schema.livePrice)
		.values({ id: 1, btcInr, btcUsd, source: 'coingecko', fetchedAt })
		.run();
}

/** {time (ms), close} in the newest-first shape the CoinDCX candles API returns. */
const dcxCandle = (periodStartSec: number, close: number) => ({
	open: close - 10,
	high: close + 10,
	low: close - 20,
	close,
	volume: 1.5,
	time: periodStartSec * 1000
});

beforeEach(() => {
	db.delete(schema.priceCandles).run();
	db.delete(schema.fxRates).run();
	db.delete(schema.livePrice).run();
	rates._resetMemoryCaches();
	esplora._clearTxCache();
	calls = [];
	routes = [];
});

// ---------------------------------------------------------------------------
// getBtcInrAt — resolution order
// ---------------------------------------------------------------------------

describe('getBtcInrAt', () => {
	test('rejects future timestamps beyond the 300s slack', async () => {
		await expect(rates.getBtcInrAt(now() + 3600)).rejects.toThrow(/future/);
		expect(calls.length).toBe(0);
	});

	test('ts within 1h of now → fresh live price, no network', async () => {
		insertLive(51_00_000, 61000, now());
		const r = await rates.getBtcInrAt(now() - 1800);
		expect(r).toEqual({ rate: 51_00_000, source: 'live' });
		expect(calls.length).toBe(0);
	});

	test('cached 1h candle at floor(ts/3600), no network', async () => {
		const ts = now() - DAY;
		insertCandle('1h', floorHour(ts), 49_99_000);
		const r = await rates.getBtcInrAt(ts);
		expect(r).toEqual({ rate: 49_99_000, source: 'coindcx-1h' });
		expect(calls.length).toBe(0);
	});

	test('walks back up to 2 candles on gaps', async () => {
		const ts = now() - 2 * DAY;
		insertCandle('1h', floorHour(ts) - 2 * HOUR, 48_88_000);
		const r = await rates.getBtcInrAt(ts);
		expect(r).toEqual({ rate: 48_88_000, source: 'coindcx-1h' });
		expect(calls.length).toBe(0);
	});

	test('a candle 3 periods back is NOT used — falls through to fetch', async () => {
		const ts = now() - 3 * DAY;
		insertCandle('1h', floorHour(ts) - 3 * HOUR, 47_77_000);
		route('interval=1h', () => json([])); // successful but empty
		fail('api.coinbase.com');
		fail('api.coingecko.com');
		const r = await rates.getBtcInrAt(ts);
		expect(r).toBeNull();
		expect(callsTo('interval=1h')).toBe(1);
	});

	test('CoinDCX 1h fetch: uses latest candle ≤ ts, persists ONLY elapsed periods', async () => {
		const ts = now() - 2 * HOUR;
		const h = floorHour(ts);
		const currentHour = floorHour(now());
		route('interval=1h', () =>
			json([
				dcxCandle(currentHour, 52_10_000),
				dcxCandle(h, 52_00_000),
				dcxCandle(h - HOUR, 51_90_000)
			])
		);
		const r = await rates.getBtcInrAt(ts);
		expect(r).toEqual({ rate: 52_00_000, source: 'coindcx-1h' });
		expect(callsTo('public.coindcx.com/market_data/candles')).toBe(1);

		const persisted = db.select().from(schema.priceCandles).all();
		const starts = persisted.map((c) => c.periodStart).sort();
		expect(starts).toEqual([h - HOUR, h]); // current-hour candle is not final → not stored

		// Immutable read-through: the same lookup now hits the cache, no refetch.
		calls = [];
		const r2 = await rates.getBtcInrAt(ts);
		expect(r2).toEqual({ rate: 52_00_000, source: 'coindcx-1h' });
		expect(calls.length).toBe(0);
	});

	test('CoinDCX down → Coinbase daily, persisted as an elapsed 1d candle', async () => {
		const ts = now() - 10 * DAY;
		timeout('public.coindcx.com');
		route('api.coinbase.com/v2/prices/BTC-INR/spot', () =>
			json({ data: { amount: '4500000.12' } })
		);
		const r = await rates.getBtcInrAt(ts);
		expect(r).toEqual({ rate: 4500000.12, source: 'coinbase-1d' });
		expect(callsTo(`spot?date=${utc(ts)}`)).toBe(1);

		const persisted = db.select().from(schema.priceCandles).all();
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({
			interval: '1d',
			periodStart: floorDay(ts),
			close: 4500000.12,
			source: 'coinbase'
		});
	});

	test('cached 1d candle short-circuits Coinbase', async () => {
		const ts = now() - 10 * DAY;
		insertCandle('1d', floorDay(ts), 4400000, 'coinbase');
		timeout('public.coindcx.com');
		const r = await rates.getBtcInrAt(ts);
		expect(r).toEqual({ rate: 4400000, source: 'coinbase-1d' });
		expect(callsTo('api.coinbase.com')).toBe(0);
	});

	test('CoinGecko history is the last fallback, DD-MM-YYYY date format', async () => {
		const ts = now() - 30 * DAY;
		timeout('public.coindcx.com');
		fail('api.coinbase.com');
		route('coins/bitcoin/history', () =>
			json({ market_data: { current_price: { inr: 3999999 } } })
		);
		const r = await rates.getBtcInrAt(ts);
		expect(r).toEqual({ rate: 3999999, source: 'coingecko-1d' });
		const [y, m, d] = utc(ts).split('-');
		expect(callsTo(`history?date=${d}-${m}-${y}`)).toBe(1);
	});

	test('CoinGecko NOT attempted beyond 365d; resolves to null', async () => {
		const ts = now() - 400 * DAY;
		timeout('public.coindcx.com');
		fail('api.coinbase.com');
		const r = await rates.getBtcInrAt(ts);
		expect(r).toBeNull();
		expect(callsTo('api.coingecko.com')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// getLivePrice
// ---------------------------------------------------------------------------

describe('getLivePrice', () => {
	test('row fresher than 300s served without network', async () => {
		insertLive(52_00_000, 62000, now() - 100);
		const p = await rates.getLivePrice();
		expect(p.btcInr).toBe(52_00_000);
		expect(p.stale).toBe(false);
		expect(calls.length).toBe(0);
	});

	test('stale row refreshed via CoinGecko', async () => {
		insertLive(50_00_000, 60000, now() - 600);
		route('simple/price', () => json({ bitcoin: { inr: 52_50_000, usd: 62500 } }));
		const p = await rates.getLivePrice();
		expect(p).toMatchObject({
			btcInr: 52_50_000,
			btcUsd: 62500,
			source: 'coingecko',
			stale: false
		});
		const row = db.select().from(schema.livePrice).all();
		expect(row[0].btcInr).toBe(52_50_000);
	});

	test('CoinGecko down → decoupled CoinDCX INR + Binance USD legs', async () => {
		fail('api.coingecko.com');
		route('api.coindcx.com/exchange/ticker', () =>
			json([
				{ market: 'ETHINR', last_price: '250000' },
				{ market: 'BTCINR', last_price: '5150000.0' }
			])
		);
		route('api.binance.com', () => json({ price: '61500.5' }));
		const p = await rates.getLivePrice();
		expect(p).toMatchObject({
			btcInr: 5150000,
			btcUsd: 61500.5,
			source: 'coindcx+binance',
			stale: false
		});
	});

	test('Binance down → tertiary USD = btcInr ÷ frankfurter USD/INR', async () => {
		fail('api.coingecko.com');
		route('api.coindcx.com/exchange/ticker', () =>
			json([{ market: 'BTCINR', last_price: '5280000' }])
		);
		timeout('api.binance.com');
		route('frankfurter.dev/v1/latest', () => json({ base: 'USD', rates: { INR: 88.0 } }));
		const p = await rates.getLivePrice();
		expect(p.btcInr).toBe(5280000);
		expect(p.btcUsd).toBeCloseTo(5280000 / 88.0);
		expect(p.source).toBe('coindcx+frankfurter');
	});

	test('total provider failure → stale row flagged stale: true', async () => {
		const fetchedAt = now() - 7200;
		insertLive(48_00_000, 58000, fetchedAt);
		fail('api.coingecko.com');
		timeout('api.coindcx.com');
		timeout('api.binance.com');
		fail('frankfurter.dev');
		const p = await rates.getLivePrice();
		expect(p).toMatchObject({ btcInr: 48_00_000, fetchedAt, stale: true });
	});

	test('no row at all + total failure → throws', async () => {
		fail('api.coingecko.com');
		timeout('api.coindcx.com');
		timeout('api.binance.com');
		fail('frankfurter.dev');
		await expect(rates.getLivePrice()).rejects.toThrow(/live price unavailable/);
	});
});

// ---------------------------------------------------------------------------
// getFxToInrAt — UTC date keying
// ---------------------------------------------------------------------------

function utc(ts: number): string {
	const d = new Date(ts * 1000);
	const p = (n: number) => n.toString().padStart(2, '0');
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

describe('getFxToInrAt', () => {
	// 2025-06-15 is a Sunday: frankfurter resolves it to Friday's rate, but the
	// cache key must remain the REQUESTED date.
	const sundayTs = Math.floor(Date.UTC(2025, 5, 15, 10, 30) / 1000);

	test('historical: fetched once, cached under the requested UTC date, never refetched', async () => {
		route('frankfurter.dev/v1/2025-06-15', () =>
			json({ base: 'USD', date: '2025-06-13', rates: { INR: 85.5 } })
		);
		const r = await rates.getFxToInrAt('USD', sundayTs);
		expect(r).toEqual({ rate: 85.5, source: 'frankfurter', date: '2025-06-15' });

		const rows = db.select().from(schema.fxRates).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ base: 'USD', date: '2025-06-15', rateToInr: 85.5 });

		calls = [];
		const r2 = await rates.getFxToInrAt('USD', sundayTs);
		expect(r2).toEqual({ rate: 85.5, source: 'frankfurter', date: '2025-06-15' });
		expect(calls.length).toBe(0);
	});

	test('today: /latest with in-memory 10-min TTL, NEVER persisted', async () => {
		route('frankfurter.dev/v1/latest', () => json({ base: 'USD', rates: { INR: 87.2 } }));
		const r = await rates.getFxToInrAt('USD', now());
		expect(r).toEqual({ rate: 87.2, source: 'frankfurter-latest', date: utc(now()) });
		expect(db.select().from(schema.fxRates).all()).toHaveLength(0);

		const r2 = await rates.getFxToInrAt('USD', now());
		expect(r2?.rate).toBe(87.2);
		expect(callsTo('frankfurter.dev/v1/latest')).toBe(1); // TTL hit, no second fetch
	});

	test('frankfurter gets exactly 1 retry on 5xx', async () => {
		let attempt = 0;
		route('frankfurter.dev/v1/2025-06-15', () =>
			++attempt === 1 ? json({ error: '522' }, 522) : json({ rates: { INR: 85.1 } })
		);
		const r = await rates.getFxToInrAt('USD', sundayTs);
		expect(r?.rate).toBe(85.1);
		expect(callsTo('frankfurter.dev/v1/2025-06-15')).toBe(2);
	});

	test('frankfurter dead → fawaz fallback (date ≥ 2024-03-02), persisted as fawaz', async () => {
		fail('frankfurter.dev', 522);
		route('cdn.jsdelivr.net/npm/@fawazahmed0', () =>
			json({ date: '2025-06-15', eur: { inr: 98.7, usd: 1.15 } })
		);
		const r = await rates.getFxToInrAt('EUR', sundayTs);
		expect(r).toEqual({ rate: 98.7, source: 'fawaz', date: '2025-06-15' });
		expect(callsTo('frankfurter.dev')).toBe(2); // original + retry
		expect(db.select().from(schema.fxRates).all()[0]).toMatchObject({
			base: 'EUR',
			source: 'fawaz'
		});
	});

	test('jsDelivr down → pages.dev mirror', async () => {
		fail('frankfurter.dev', 522);
		timeout('cdn.jsdelivr.net');
		route('currency-api.pages.dev', () => json({ usd: { inr: 85.3 } }));
		const r = await rates.getFxToInrAt('USD', sundayTs);
		expect(r?.rate).toBe(85.3);
		expect(callsTo('2025-06-15.currency-api.pages.dev')).toBe(1);
	});

	test('fawaz NOT attempted before its 2024-03-02 floor → null', async () => {
		const oldTs = Math.floor(Date.UTC(2023, 4, 14, 12) / 1000);
		fail('frankfurter.dev', 522);
		const r = await rates.getFxToInrAt('USD', oldTs);
		expect(r).toBeNull();
		expect(callsTo('fawazahmed0') + callsTo('currency-api')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// ensureDailySeries + getDailyCloses
// ---------------------------------------------------------------------------

describe('daily series', () => {
	test('backfills missing days, persists only elapsed, reports backfilling: false when done', async () => {
		const yesterday = floorDay(now()) - DAY;
		const fromTs = yesterday - 4 * DAY;
		insertCandle('1d', yesterday - 3 * DAY, 4000003);
		route('interval=1d', () => {
			// Provider returns the whole range including TODAY's unfinished candle.
			const candles = [dcxCandle(floorDay(now()), 5000000)];
			for (let i = 0; i < 5; i++) candles.push(dcxCandle(yesterday - i * DAY, 4000000 + i));
			return json(candles);
		});

		const r = await rates.ensureDailySeries(fromTs);
		expect(r).toEqual({ backfilling: false });

		const closes = rates.getDailyCloses(fromTs, now());
		expect(closes.size).toBe(5); // today's candle was not persisted
		expect(closes.get(utc(yesterday))).toBe(4000000);
		expect(closes.get(utc(floorDay(now())))).toBeUndefined();
		expect(closes.get(utc(yesterday - 3 * DAY))).toBe(4000003); // pre-existing row untouched
	});

	test('fetch failure → backfilling: true, no throw', async () => {
		fail('public.coindcx.com');
		const r = await rates.ensureDailySeries(now() - 5 * DAY);
		expect(r).toEqual({ backfilling: true });
	});

	test('nothing missing → backfilling: false with zero fetches', async () => {
		const yesterday = floorDay(now()) - DAY;
		insertCandle('1d', yesterday, 4100000);
		const r = await rates.ensureDailySeries(yesterday + 3600);
		expect(r).toEqual({ backfilling: false });
		expect(calls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Esplora host failover
// ---------------------------------------------------------------------------

describe('esplora fetchTx', () => {
	const txJson = {
		txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',
		fee: 624,
		status: { confirmed: true, block_height: 850000, block_time: 1717000000 },
		vout: [
			{ scriptpubkey_address: 'bc1qexampleaddr', value: 1_000_000 },
			{ value: 0 } // e.g. OP_RETURN — no address
		]
	};

	test('fails over hosts in order on timeout/error; first success wins', async () => {
		timeout('blockstream.info');
		route('mempool.emzy.de', () => json(txJson));
		const r = await esplora.fetchTx(txJson.txid);
		expect(r).toEqual({
			txid: txJson.txid,
			confirmed: true,
			blockTime: 1717000000,
			feeSats: 624,
			outputs: [
				{ index: 0, address: 'bc1qexampleaddr', valueSats: 1_000_000 },
				{ index: 1, address: null, valueSats: 0 }
			],
			host: 'https://mempool.emzy.de/api'
		});
		expect(callsTo('blockstream.info')).toBe(1);
		expect(callsTo('mempool.space')).toBe(0);

		// Confirmed → cached: second lookup makes no network calls.
		calls = [];
		const r2 = await esplora.fetchTx(txJson.txid);
		expect(r2?.host).toBe('https://mempool.emzy.de/api');
		expect(calls.length).toBe(0);
	});

	test('unconfirmed txs are returned but never cached', async () => {
		const mempoolTx = { ...txJson, status: { confirmed: false } };
		route('blockstream.info', () => json(mempoolTx));
		const r = await esplora.fetchTx(txJson.txid);
		expect(r?.confirmed).toBe(false);
		expect(r?.blockTime).toBeNull();
		await esplora.fetchTx(txJson.txid);
		expect(callsTo('blockstream.info')).toBe(2);
	});

	test('all hosts down → null, all three attempted in order', async () => {
		timeout('blockstream.info');
		fail('mempool.emzy.de', 502);
		timeout('mempool.space');
		const r = await esplora.fetchTx(txJson.txid);
		expect(r).toBeNull();
		expect(calls.map((u) => new URL(u).hostname)).toEqual([
			'blockstream.info',
			'mempool.emzy.de',
			'mempool.space'
		]);
	});
});
