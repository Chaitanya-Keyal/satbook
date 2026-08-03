PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
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
	CONSTRAINT "tx_amount_positive" CHECK("__new_transactions"."amount_sats" > 0),
	CONSTRAINT "tx_fee_nonneg" CHECK("__new_transactions"."fee_sats" >= 0),
	CONSTRAINT "tx_type_shape" CHECK(("__new_transactions"."type" = 'TRANSFER' AND "__new_transactions"."wallet_id" IS NULL AND "__new_transactions"."from_wallet_id" IS NOT NULL AND "__new_transactions"."to_wallet_id" IS NOT NULL AND "__new_transactions"."from_wallet_id" != "__new_transactions"."to_wallet_id")
			OR ("__new_transactions"."type" != 'TRANSFER' AND "__new_transactions"."wallet_id" IS NOT NULL AND "__new_transactions"."from_wallet_id" IS NULL AND "__new_transactions"."to_wallet_id" IS NULL AND "__new_transactions"."inr_value_minor" IS NOT NULL AND "__new_transactions"."fiat_currency" IS NOT NULL AND ("__new_transactions"."type" IN ('SELL', 'SPEND') OR "__new_transactions"."fee_sats" = 0)))
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "type", "ts", "seq", "wallet_id", "from_wallet_id", "to_wallet_id", "amount_sats", "fee_sats", "fiat_currency", "fiat_amount_minor", "fx_rate_to_inr", "inr_value_minor", "fee_inr_value_minor", "btc_usd_rate", "entered_rate", "rate_source", "txid", "notes", "source", "import_key", "created_at", "updated_at") SELECT "id", "type", "ts", "seq", "wallet_id", "from_wallet_id", "to_wallet_id", "amount_sats", "fee_sats", "fiat_currency", "fiat_amount_minor", "fx_rate_to_inr", "inr_value_minor", "fee_inr_value_minor", "btc_usd_rate", "entered_rate", "rate_source", "txid", "notes", "source", "import_key", "created_at", "updated_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tx_ts_idx` ON `transactions` (`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `tx_import_key_idx` ON `transactions` (`import_key`);