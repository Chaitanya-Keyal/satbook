// Rate service facade. Resolution strategies are specified in
// docs/design-architecture.md §5 — that section is authoritative.

import type { RateSource } from '../../types';
import { utcDateString } from '../../utils/time';
import * as cache from './cache';
import * as binance from './providers/binance';
import * as coinbase from './providers/coinbase';
import * as coindcx from './providers/coindcx';
import * as coingecko from './providers/coingecko';
import * as fawaz from './providers/fawaz';
import * as frankfurter from './providers/frankfurter';

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
		'live price unavailable: no cached row and all providers (CoinGecko, CoinDCX, Binance, frankfurter) failed'
	);
}

async function refreshLivePrice(now: number): Promise<cache.LiveRow | null> {
	const cg = await coingecko.fetchSimplePrice();
	if (cg) {
		const row = { btcInr: cg.inr, btcUsd: cg.usd, source: 'coingecko', fetchedAt: now };
		cache.putLiveRow(row);
		return row;
	}
	// Decoupled fallback legs: INR from CoinDCX, USD from Binance (tertiary:
	// derive USD from the INR leg via frankfurter USD/INR).
	const btcInr = await coindcx.fetchTickerBtcInr();
	if (btcInr == null) return null;
	let btcUsd = await binance.fetchBtcUsdt();
	let source = 'coindcx+binance';
	if (btcUsd == null) {
		const usdInr = await frankfurter.fetchFxToInr('USD', 'latest');
		if (usdInr == null) return null;
		btcUsd = btcInr / usdInr;
		source = 'coindcx+frankfurter';
	}
	const row = { btcInr, btcUsd, source, fetchedAt: now };
	cache.putLiveRow(row);
	return row;
}

// ---------------------------------------------------------------------------
// Historical BTC/INR
// ---------------------------------------------------------------------------

const DAILY_SOURCE: Record<string, RateSource> = {
	coindcx: 'coindcx-1d',
	coinbase: 'coinbase-1d',
	coingecko: 'coingecko-1d'
};

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
	if (cached1h) return { rate: cached1h.close, source: 'coindcx-1h' };

	const fetched = await coindcx.fetchCandles('1h', (ts - 6 * HOUR) * 1000, (ts + HOUR) * 1000);
	if (fetched && fetched.length > 0) {
		cache.persistElapsedCandles('1h', 'coindcx', fetched, now);
		let best: coindcx.CoindcxCandle | null = null;
		for (const c of fetched) {
			if (c.periodStart <= ts && (!best || c.periodStart > best.periodStart)) best = c;
		}
		if (best) return { rate: best.close, source: 'coindcx-1h' };
	}

	const day = Math.floor(ts / DAY) * DAY;
	const cached1d = cache.getCandle('1d', day);
	if (cached1d)
		return { rate: cached1d.close, source: DAILY_SOURCE[cached1d.source] ?? 'coindcx-1d' };

	const spot = await coinbase.fetchDailySpot(utcDateString(ts));
	if (spot != null) {
		cache.persistElapsedCandles('1d', 'coinbase', [{ periodStart: day, close: spot }], now);
		return { rate: spot, source: 'coinbase-1d' };
	}

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
		const candles = await coindcx.fetchCandles(
			'1d',
			chunk[0] * 1000,
			(chunk[chunk.length - 1] + DAY) * 1000
		);
		if (candles == null) {
			failed = true;
			break;
		}
		cache.persistElapsedCandles('1d', 'coindcx', candles, now);
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
