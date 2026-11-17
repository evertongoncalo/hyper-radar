ALTER TABLE "snapshots" ADD COLUMN "account_value_representative" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "account_mode" text;