ALTER TABLE `lightning_payments` ADD `zap_id` text;--> statement-breakpoint
CREATE INDEX `ln_zap_id_idx` ON `lightning_payments` (`zap_id`);