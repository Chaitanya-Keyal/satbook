// Rate service facade.
//
// ONE MARKET CONVENTION, EVERYWHERE: every BTC price is a global (US-market)
// price, and INR is always that USD price × the ECB reference FX rate for the
// same date. Indian-exchange quotes carry a premium (~3% at the time of
// writing) — mixing them with global quotes made the implied USD/INR rate, and
// so every USD-equivalent figure in the app, jump whenever a fallback engaged.

import type { RateSource } from '../../types';
import { utcDateString } from '../../utils/time';
import * as cache from './cache';
import * as binance from './providers/binance';
import * as coinbase from './providers/coinbase';
import * as coingecko from './providers/coingecko';
import * as fawaz from './providers/fawaz';
import * as frankfurter from './providers/frankfurter';
import * as kraken from './providers/kraken';

const HOUR = 3600;
const DAY = 86400;
const LIVE_TTL_SEC = 300;
const FUTURE_SLACK_SEC = 300;
const FX_LATEST_TTL_SEC = 600;
const FAWAZ_FLOOR_DATE = '2024-03-02';

// ---------------------------------------------------------------------------
// Live price
// ---------------------------------------------------------------------------

export async function getLivePrice(): Promise<{
	btcInr: number;
	btcUsd: number;
	source: string;
	fetchedAt: number;
	stale: boolean;
}> {
	const now = cache.nowSec();
	const row = cache.getLiveRow();
	if (row && now - row.fetchedAt < LIVE_TTL_SEC) return { ...row, stale: false };

	const fresh = await refreshLivePrice(now);
	if (fresh) return { ...fresh, stale: false };
	if (row) return { ...row, stale: true };
	throw new Error(
		'live price unavailable: no cached row and all providers (CoinGecko, Binance, Coinbase, Kraken, frankfurter) failed'
	);
}

async function refreshLivePrice(now: number): Promise<cache.LiveRow | null> {
	const cg = await coingecko.fetchSimplePrice();
	if (cg) {
		const row = { btcInr: cg.inr, btcUsd: cg.usd, source: 'coingecko', fetchedAt: now };
		cache.putLiveRow(row);
		return row;
	}

	// Fallback: a global USD price × the latest ECB rate. Never an Indian-market
	// quote — pairing one with a global USD price fakes a ~3% FX premium.
	let btcUsd = await binance.fetchBtcUsdt();
	let source = 'binance+ecb';
	if (btcUsd == null) {
		btcUsd = await coinbase.fetchBtcUsd();
		source = 'coinbase+ecb';
	}
	if (btcUsd == null) {
		btcUsd = await kraken.fetchBtcUsd();
		source = 'kraken+ecb';
	}
	if (btcUsd == null) return null;

	const usdInr = await frankfurter.fetchFxToInr('USD', 'latest');
	if (usdInr == null) return null;

	const row = { btcInr: btcUsd * usdInr, btcUsd, source, fetchedAt: now };
	cache.putLiveRow(row);
	return row;
}

/** INR per USD right now (ECB daily reference rate) — the app's one FX truth. */
export async function getUsdInrNow(): Promise<number | null> {
	const fx = await getFxToInrAt('USD', cache.nowSec());
	return fx?.rate ?? null;
}

// ---------------------------------------------------------------------------
// Historical BTC/INR
// ---------------------------------------------------------------------------

const DAILY_SOURCE: Record<string, RateSource> = {
	binance: 'binance-1d',
	coinbase: 'coinbase-1d',
	coingecko: 'coingecko-1d'
};

/** USD price at `ts` → INR via the ECB rate for that same UTC date. */
async function toInr(usd: number, ts: number): Promise<number | null> {
	const fx = await getFxToInrAt('USD', ts);
	return fx == null ? null : usd * fx.rate;
}

export async function getBtcInrAt(
	ts: number
): Promise<{ rate: number; source: RateSource } | null> {
	const now = cache.nowSec();
	if (ts > now + FUTURE_SLACK_SEC) throw new Error(`getBtcInrAt: future timestamp ${ts} rejected`);

	if (now - ts < HOUR) {
		try {
			const live = await getLivePrice();
			if (!live.stale) return { rate: live.btcInr, source: 'live' };
		} catch {
			// no live row exists yet — fall through to the candle path
		}
	}

	const hour = Math.floor(ts / HOUR) * HOUR;
	const cached1h = cache.getCandleWalkback('1h', hour, 2);
	if (cached1h) return { rate: cached1h.close, source: 'binance-1h' };

	const klines = await binance.fetchKlines('1h', (ts - 6 * HOUR) * 1000, (ts + HOUR) * 1000);
	if (klines && klines.length > 0) {
		let best: binance.UsdCandle | null = null;
		for (const c of klines) {
			if (c.periodStart <= ts && (!best || c.periodStart > best.periodStart)) best = c;
		}
		if (best) {
			const inr = await toInr(best.close, ts);
			if (inr != null) {
				// Persist the whole window in INR at this date's FX (candles within
				// a few hours share the same daily reference rate).
				const fx = inr / best.close;
				cache.persistElapsedCandles(
					'1h',
					'binance',
					klines.map((c) => ({ periodStart: c.periodStart, close: c.close * fx })),
					now
				);
				return { rate: inr, source: 'binance-1h' };
			}
		}
	}

	const day = Math.floor(ts / DAY) * DAY;
	const cached1d = cache.getCandle('1d', day);
	if (cached1d)
		return { rate: cached1d.close, source: DAILY_SOURCE[cached1d.source] ?? 'coinbase-1d' };

	const spotUsd = await coinbase.fetchBtcUsd(utcDateString(ts));
	if (spotUsd != null) {
		const inr = await toInr(spotUsd, ts);
		if (inr != null) {
			cache.persistElapsedCandles('1d', 'coinbase', [{ periodStart: day, close: inr }], now);
			return { rate: inr, source: 'coinbase-1d' };
		}
	}

	// CoinGecko's INR is its global price converted with its own FX — same
	// convention, so it is a safe last resort.
	if (now - ts <= 365 * DAY) {
		const [y, m, d] = utcDateString(ts).split('-');
		const inr = await coingecko.fetchHistoryInr(`${d}-${m}-${y}`);
		if (inr != null) {
			cache.persistElapsedCandles('1d', 'coingecko', [{ periodStart: day, close: inr }], now);
			return { rate: inr, source: 'coingecko-1d' };
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Fiat FX
// ---------------------------------------------------------------------------

const fxLatestCache = new Map<string, { rate: number; fetchedAt: number }>();

export async function getFxToInrAt(
	base: 'USD' | 'EUR',
	ts: number
): Promise<{ rate: number; source: string; date: string } | null> {
	const now = cache.nowSec();
	const date = utcDateString(ts);
	const today = utcDateString(now);

	if (date >= today) {
		const hit = fxLatestCache.get(base);
		if (hit && now - hit.fetchedAt < FX_LATEST_TTL_SEC)
			return { rate: hit.rate, source: 'frankfurter-latest', date };
		const rate = await frankfurter.fetchFxToInr(base, 'latest');
		if (rate == null) return null;
		fxLatestCache.set(base, { rate, fetchedAt: now });
		// Today's rate is still moving — in-memory TTL only, never persisted.
		return { rate, source: 'frankfurter-latest', date };
	}

	const cached = cache.getFx(base, date);
	if (cached) return { rate: cached.rateToInr, source: cached.source, date };

	// Weekend dates resolve to the prior business day inside frankfurter; the
	// row is still cached under the REQUESTED date (stable key).
	const fr = await frankfurter.fetchFxToInr(base, date);
	if (fr != null) {
		cache.persistFx(base, date, fr, 'frankfurter');
		return { rate: fr, source: 'frankfurter', date };
	}

	if (date >= FAWAZ_FLOOR_DATE) {
		const fz = await fawaz.fetchFxToInr(base, date);
		if (fz != null) {
			cache.persistFx(base, date, fz, 'fawaz');
			return { rate: fz, source: 'fawaz', date };
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Daily series (chart backfill)
// ---------------------------------------------------------------------------

const MAX_CHUNKS_PER_CALL = 3;
const MAX_DAYS_PER_CHUNK = 1000;

export async function ensureDailySeries(fromTs: number): Promise<{ backfilling: boolean }> {
	const now = cache.nowSec();
	const firstDay = Math.floor(fromTs / DAY) * DAY;
	const lastDay = Math.floor(now / DAY) * DAY - DAY; // yesterday = last fully-elapsed day
	if (firstDay > lastDay) return { backfilling: false };

	let remaining = missingDays(firstDay, lastDay);
	if (remaining.length === 0) return { backfilling: false };

	// Cap this call's work so the API route stays fast; leftover work just
	// reports backfilling: true and the next request continues.
	let failed = false;
	for (let i = 0; i < MAX_CHUNKS_PER_CALL && remaining.length > 0; i++) {
		const chunk = remaining.slice(0, MAX_DAYS_PER_CHUNK);
		remaining = remaining.slice(chunk.length);
		const candles = await binance.fetchKlines(
			'1d',
			chunk[0] * 1000,
			(chunk[chunk.length - 1] + DAY) * 1000
		);
		if (candles == null || candles.length === 0) {
			failed = true;
			break;
		}
		// One FX call covers the whole span; ECB publishes business days only,
		// so weekends and holidays carry the previous close forward.
		const fxByDate = await frankfurter.fetchFxRangeToInr(
			'USD',
			utcDateString(chunk[0] - 7 * DAY),
			utcDateString(chunk[chunk.length - 1])
		);
		if (fxByDate == null) {
			failed = true;
			break;
		}
		const fxDates = [...fxByDate.keys()].sort();
		const inrCandles: { periodStart: number; close: number }[] = [];
		for (const c of candles) {
			const date = utcDateString(c.periodStart);
			let fx = fxByDate.get(date);
			if (fx == null) {
				// forward-fill: the most recent business day at or before `date`
				let prev: string | undefined;
				for (const d of fxDates) {
					if (d <= date) prev = d;
					else break;
				}
				fx = prev == null ? undefined : fxByDate.get(prev);
			}
			if (fx != null) inrCandles.push({ periodStart: c.periodStart, close: c.close * fx });
		}
		if (inrCandles.length === 0) {
			failed = true;
			break;
		}
		cache.persistElapsedCandles('1d', 'binance', inrCandles, now);
	}

	return { backfilling: failed || missingDays(firstDay, lastDay).length > 0 };
}

function missingDays(firstDay: number, lastDay: number): number[] {
	const existing = cache.getExistingDailyStarts(firstDay, lastDay);
	const out: number[] = [];
	for (let day = firstDay; day <= lastDay; day += DAY) {
		if (!existing.has(day)) out.push(day);
	}
	return out;
}

/** utcDateString → INR close, strictly from cache (no fetching). */
export function getDailyCloses(fromTs: number, toTs: number): Map<string, number> {
	const fromDay = Math.floor(fromTs / DAY) * DAY;
	const out = new Map<string, number>();
	for (const c of cache.getDailyCandles(fromDay, toTs))
		out.set(utcDateString(c.periodStart), c.close);
	return out;
}

/** Test hook: clears in-memory (non-SQLite) caches. */
export function _resetMemoryCaches(): void {
	fxLatestCache.clear();
}
