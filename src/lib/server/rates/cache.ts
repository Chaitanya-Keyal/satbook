// SQLite-backed cache over price_candles / fx_rates / live_price. Two hard
// rules: (1) only fully-elapsed candle periods are persisted — a candle for the
// current hour/day is not final; (2) historical rows are immutable — writes are
// insert-or-ignore, hits are never refetched.

import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { db, schema } from '../db';

const PAIR = 'BTC_INR';

export const INTERVAL_SEC: Record<'1h' | '1d', number> = { '1h': 3600, '1d': 86400 };

export function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

export interface CandleHit {
	periodStart: number;
	close: number;
	source: string;
}

export function getCandle(interval: '1h' | '1d', periodStart: number): CandleHit | null {
	const row = db
		.select()
		.from(schema.priceCandles)
		.where(
			and(
				eq(schema.priceCandles.pair, PAIR),
				eq(schema.priceCandles.interval, interval),
				eq(schema.priceCandles.periodStart, periodStart)
			)
		)
		.get();
	return row ? { periodStart: row.periodStart, close: row.close, source: row.source } : null;
}

/** Checks periodStart, then up to stepsBack earlier periods (tolerates candle gaps). */
export function getCandleWalkback(
	interval: '1h' | '1d',
	periodStart: number,
	stepsBack: number
): CandleHit | null {
	const step = INTERVAL_SEC[interval];
	for (let i = 0; i <= stepsBack; i++) {
		const hit = getCandle(interval, periodStart - i * step);
		if (hit) return hit;
	}
	return null;
}

/** Persists only candles whose period has fully elapsed; existing rows are never overwritten. */
export function persistElapsedCandles(
	interval: '1h' | '1d',
	source: string,
	candles: { periodStart: number; close: number }[],
	now = nowSec()
): void {
	const step = INTERVAL_SEC[interval];
	const rows = candles
		.filter((c) => c.periodStart + step <= now)
		.map((c) => ({
			pair: PAIR,
			interval,
			periodStart: c.periodStart,
			close: c.close,
			source,
			fetchedAt: now
		}));
	if (rows.length === 0) return;
	db.insert(schema.priceCandles).values(rows).onConflictDoNothing().run();
}

/** All cached 1d candles with fromPeriodStart ≤ periodStart ≤ toTs, ascending. */
export function getDailyCandles(fromPeriodStart: number, toTs: number): CandleHit[] {
	return db
		.select()
		.from(schema.priceCandles)
		.where(
			and(
				eq(schema.priceCandles.pair, PAIR),
				eq(schema.priceCandles.interval, '1d'),
				gte(schema.priceCandles.periodStart, fromPeriodStart),
				lte(schema.priceCandles.periodStart, toTs)
			)
		)
		.orderBy(asc(schema.priceCandles.periodStart))
		.all()
		.map((r) => ({ periodStart: r.periodStart, close: r.close, source: r.source }));
}

export function getExistingDailyStarts(fromDay: number, toDay: number): Set<number> {
	const rows = db
		.select({ periodStart: schema.priceCandles.periodStart })
		.from(schema.priceCandles)
		.where(
			and(
				eq(schema.priceCandles.pair, PAIR),
				eq(schema.priceCandles.interval, '1d'),
				gte(schema.priceCandles.periodStart, fromDay),
				lte(schema.priceCandles.periodStart, toDay)
			)
		)
		.all();
	return new Set(rows.map((r) => r.periodStart));
}

// FX ---------------------------------------------------------------------

export function getFx(
	base: 'USD' | 'EUR',
	date: string
): { rateToInr: number; source: string } | null {
	const row = db
		.select()
		.from(schema.fxRates)
		.where(and(eq(schema.fxRates.base, base), eq(schema.fxRates.date, date)))
		.get();
	return row ? { rateToInr: row.rateToInr, source: row.source } : null;
}

export function persistFx(
	base: 'USD' | 'EUR',
	date: string,
	rateToInr: number,
	source: string
): void {
	db.insert(schema.fxRates)
		.values({ base, date, rateToInr, source, fetchedAt: nowSec() })
		.onConflictDoNothing()
		.run();
}

// Live price -------------------------------------------------------------

export interface LiveRow {
	btcInr: number;
	btcUsd: number;
	source: string;
	fetchedAt: number;
}

export function getLiveRow(): LiveRow | null {
	const row = db.select().from(schema.livePrice).where(eq(schema.livePrice.id, 1)).get();
	return row
		? { btcInr: row.btcInr, btcUsd: row.btcUsd, source: row.source, fetchedAt: row.fetchedAt }
		: null;
}

export function putLiveRow(row: LiveRow): void {
	db.insert(schema.livePrice)
		.values({ id: 1, ...row })
		.onConflictDoUpdate({ target: schema.livePrice.id, set: { ...row } })
		.run();
}
