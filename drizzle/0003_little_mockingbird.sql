ALTER TABLE `transactions` ADD `ref_kind` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `income_kind` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `counterparty` text;--> statement-breakpoint
ALTER TABLE `wallets` ADD `layer` text DEFAULT 'onchain' NOT NULL;--> statement-breakpoint
ALTER TABLE `wallets` ADD `custodial` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Every reference recorded so far is an on-chain txid.
UPDATE `transactions` SET `ref_kind` = 'onchain' WHERE `txid` IS NOT NULL;--> statement-breakpoint
-- Importers now own a tag each, so one importer's --force cannot delete another's rows.
UPDATE `transactions` SET `source` = 'import:xlsx' WHERE `source` = 'import';--> statement-breakpoint
-- Wallets that hold someone else's keys; Lightning rails have no on-chain addresses.
UPDATE `wallets` SET `custodial` = true WHERE `kind` = 'exchange';
