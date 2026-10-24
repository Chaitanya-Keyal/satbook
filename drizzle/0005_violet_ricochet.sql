CREATE TABLE `lightning_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`key` text NOT NULL,
	`direction` text NOT NULL,
	`sub_type` text NOT NULL,
	`payment_hash` text,
	`tx_id` text,
	`amount_sat` integer NOT NULL,
	`fee_msat` integer DEFAULT 0 NOT NULL,
	`requested_sat` integer,
	`description` text,
	`payer_note` text,
	`completed_at` integer NOT NULL,
	`memo` text,
	`comment` text,
	`ln_address` text,
	`zap_pubkey` text,
	`zap_content` text,
	`zap_verified` integer,
	`review` text DEFAULT 'pending' NOT NULL,
	`paired_key` text,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ln_node_key_idx` ON `lightning_payments` (`node_id`,`key`);--> statement-breakpoint
CREATE INDEX `ln_completed_idx` ON `lightning_payments` (`completed_at`);