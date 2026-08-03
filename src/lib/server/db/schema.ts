import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

export const wallets = sqliteTable('wallets', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	kind: text('kind', { enum: ['hot', 'cold', 'exchange'] }).notNull(),
	sortOrder: integer('sort_order').notNull().default(0),
	archivedAt: integer('archived_at'),
	createdAt: integer('created_at').notNull()
});

export const walletAddresses = sqliteTable('wallet_addresses', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	walletId: integer('wallet_id')
		.notNull()
		.references(() => wallets.id),
	label: text('label'),
	address: text('address').notNull().unique()
});

// The ledger — single source of truth. All BTC quantities are integer satoshis
// (positive magnitudes; direction is implied by `type`), all fiat quantities are
// integer minor units (paise/cents), timestamps are unix seconds UTC.
export const transactions = sqliteTable(
	'transactions',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		type: text('type', { enum: ['INCOME', 'BUY', 'SELL', 'SPEND', 'TRANSFER'] }).notNull(),
		ts: integer('ts').notNull(),
		// Manual ordering override among same-timestamp rows; engine sorts (ts, seq??0, typeRank, id).
		seq: integer('seq'),
		walletId: integer('wallet_id').references(() => wallets.id),
		fromWalletId: integer('from_wallet_id').references(() => wallets.id),
		toWalletId: integer('to_wallet_id').references(() => wallets.id),
		// TRANSFER: sats credited to the destination; SELL/SPEND: sats the
		// counterparty received. The paying wallet is debited amountSats + feeSats.
		amountSats: integer('amount_sats').notNull(),
		// Network fee (TRANSFER/SELL/SPEND): consumed from the FIFO queue, never a
		// taxable event, never deductible (s.115BBH allows only cost of acquisition).
		feeSats: integer('fee_sats').notNull().default(0),
		fiatCurrency: text('fiat_currency', { enum: ['INR', 'USD', 'EUR'] }),
		fiatAmountMinor: integer('fiat_amount_minor'),
		// Static conversion snapshot captured at entry; 1.0 for INR. Never recomputed after save.
		fxRateToInr: real('fx_rate_to_inr'),
		// Canonical INR value the engine reads. Required for all non-TRANSFER types.
		inrValueMinor: integer('inr_value_minor'),
		// Informational only: INR FMV of feeSats at ts, shown in row expansions.
		feeInrValueMinor: integer('fee_inr_value_minor'),
		btcUsdRate: real('btc_usd_rate'),
		// Provenance of the entry-time rate, for display after save.
		enteredRate: real('entered_rate'),
		rateSource: text('rate_source'),
		txid: text('txid'),
		notes: text('notes'),
		source: text('source', { enum: ['manual', 'import'] })
			.notNull()
			.default('manual'),
		importKey: text('import_key'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		index('tx_ts_idx').on(t.ts),
		uniqueIndex('tx_import_key_idx').on(t.importKey),
		check('tx_amount_positive', sql`${t.amountSats} > 0`),
		check('tx_fee_nonneg', sql`${t.feeSats} >= 0`),
		// Shape backstop; ledger.ts app-level validation is primary.
		check(
			'tx_type_shape',
			sql`(${t.type} = 'TRANSFER' AND ${t.walletId} IS NULL AND ${t.fromWalletId} IS NOT NULL AND ${t.toWalletId} IS NOT NULL AND ${t.fromWalletId} != ${t.toWalletId})
			OR (${t.type} != 'TRANSFER' AND ${t.walletId} IS NOT NULL AND ${t.fromWalletId} IS NULL AND ${t.toWalletId} IS NULL AND ${t.inrValueMinor} IS NOT NULL AND ${t.fiatCurrency} IS NOT NULL AND (${t.type} IN ('SELL', 'SPEND') OR ${t.feeSats} = 0))`
		)
	]
);

// Permanent immutable cache of historical BTC prices; only fully-elapsed periods are stored.
export const priceCandles = sqliteTable(
	'price_candles',
	{
		pair: text('pair').notNull(), // 'BTC_INR'
		interval: text('interval', { enum: ['1h', '1d'] }).notNull(),
		periodStart: integer('period_start').notNull(), // unix sec UTC, aligned to interval
		close: real('close').notNull(), // INR per BTC
		source: text('source').notNull(), // 'coindcx' | 'coinbase' | 'coingecko'
		fetchedAt: integer('fetched_at').notNull()
	},
	(t) => [primaryKey({ columns: [t.pair, t.interval, t.periodStart] })]
);

// Permanent cache keyed on the REQUESTED UTC date (frankfurter resolves weekends internally).
export const fxRates = sqliteTable(
	'fx_rates',
	{
		base: text('base', { enum: ['USD', 'EUR'] }).notNull(),
		date: text('date').notNull(), // 'YYYY-MM-DD'
		rateToInr: real('rate_to_inr').notNull(),
		source: text('source').notNull(), // 'frankfurter' | 'fawaz'
		fetchedAt: integer('fetched_at').notNull()
	},
	(t) => [primaryKey({ columns: [t.base, t.date] })]
);

// Single-row table (id = 1) holding the most recent live price fetch.
export const livePrice = sqliteTable(
	'live_price',
	{
		id: integer('id').primaryKey(),
		btcInr: real('btc_inr').notNull(),
		btcUsd: real('btc_usd').notNull(),
		source: text('source').notNull(),
		fetchedAt: integer('fetched_at').notNull()
	},
	(t) => [check('live_price_single_row', sql`${t.id} = 1`)]
);

export const sessions = sqliteTable('sessions', {
	tokenHash: text('token_hash').primaryKey(), // sha256(base64url token); raw token only in cookie
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull() // sliding 30d, absolute cap 90d from createdAt
});

// Persisted login limiter state (survives restarts). Single user → single 'global' row.
export const loginAttempts = sqliteTable('login_attempts', {
	key: text('key').primaryKey(),
	failCount: integer('fail_count').notNull().default(0),
	firstFailAt: integer('first_fail_at'),
	lockedUntil: integer('locked_until')
});

// KV settings: password_hash, fee_micro_disposal ('0'|'1'), unit ('sats'|'btc'),
// per-type entry defaults, last transfer pair.
export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});
