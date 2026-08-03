CREATE TABLE `fx_rates` (
	`base` text NOT NULL,
	`date` text NOT NULL,
	`rate_to_inr` real NOT NULL,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`base`, `date`)
);
--> statement-breakpoint
CREATE TABLE `live_price` (
	`id` integer PRIMARY KEY NOT NULL,
	`btc_inr` real NOT NULL,
	`btc_usd` real NOT NULL,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	CONSTRAINT "live_price_single_row" CHECK("live_price"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`first_fail_at` integer,
	`locked_until` integer
);
--> statement-breakpoint
CREATE TABLE `price_candles` (
	`pair` text NOT NULL,
	`interval` text NOT NULL,
	`period_start` integer NOT NULL,
	`close` real NOT NULL,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`pair`, `interval`, `period_start`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`ts` integer NOT NULL,
	`seq` integer,
	`wallet_id` integer,
	`from_wallet_id` integer,
	`to_wallet_id` integer,
	`amount_sats` integer NOT NULL,
	`fee_sats` integer DEFAULT 0 NOT NULL,
	`fiat_currency` text,
	`fiat_amount_minor` integer,
	`fx_rate_to_inr` real,
	`inr_value_minor` integer,
	`fee_inr_value_minor` integer,
	`btc_usd_rate` real,
	`entered_rate` real,
	`rate_source` text,
	`txid` text,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`import_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tx_amount_positive" CHECK("transactions"."amount_sats" > 0),
	CONSTRAINT "tx_fee_nonneg" CHECK("transactions"."fee_sats" >= 0),
	CONSTRAINT "tx_type_shape" CHECK(("transactions"."type" = 'TRANSFER' AND "transactions"."wallet_id" IS NULL AND "transactions"."from_wallet_id" IS NOT NULL AND "transactions"."to_wallet_id" IS NOT NULL AND "transactions"."from_wallet_id" != "transactions"."to_wallet_id")
			OR ("transactions"."type" != 'TRANSFER' AND "transactions"."wallet_id" IS NOT NULL AND "transactions"."from_wallet_id" IS NULL AND "transactions"."to_wallet_id" IS NULL AND "transactions"."inr_value_minor" IS NOT NULL AND "transactions"."fiat_currency" IS NOT NULL AND "transactions"."fee_sats" = 0))
);
--> statement-breakpoint
CREATE INDEX `tx_ts_idx` ON `transactions` (`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `tx_import_key_idx` ON `transactions` (`import_key`);--> statement-breakpoint
CREATE TABLE `wallet_addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_id` integer NOT NULL,
	`label` text,
	`address` text NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_addresses_address_unique` ON `wallet_addresses` (`address`);--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_name_unique` ON `wallets` (`name`);