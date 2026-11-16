CREATE TYPE "public"."asset_status" AS ENUM('idle', 'running', 'stopped', 'restarting');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('OPENED', 'CLOSED', 'INCREASED', 'REDUCED', 'FLIPPED', 'SLTP_CHANGED', 'LIQ_NEAR');--> statement-breakpoint
CREATE TYPE "public"."margin_type" AS ENUM('cross', 'isolated');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('SL', 'TP');--> statement-breakpoint
CREATE TYPE "public"."position_side" AS ENUM('long', 'short');--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "analysis_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"asset_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"restart_reason" text,
	CONSTRAINT "analysis_runs_end_after_start" CHECK ("analysis_runs"."ended_at" is null or "analysis_runs"."ended_at" >= "analysis_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"snapshot_id" bigint NOT NULL,
	"kind" "order_kind" NOT NULL,
	"trigger_px" numeric(38, 18) NOT NULL,
	"size" numeric(38, 18),
	"reduce_only" boolean NOT NULL,
	"exchange_order_id" bigint NOT NULL,
	CONSTRAINT "orders_trigger_px_positive" CHECK ("orders"."trigger_px" > 0),
	CONSTRAINT "orders_size_positive" CHECK ("orders"."size" is null or "orders"."size" > 0)
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "positions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"snapshot_id" bigint NOT NULL,
	"side" "position_side" NOT NULL,
	"size" numeric(38, 18) NOT NULL,
	"entry_px" numeric(38, 18) NOT NULL,
	"leverage" integer NOT NULL,
	"margin_type" "margin_type" NOT NULL,
	"liquidation_px" numeric(38, 18),
	"unrealized_pnl" numeric(30, 8) NOT NULL,
	"margin_used" numeric(30, 8) NOT NULL,
	"notional" numeric(30, 8) NOT NULL,
	CONSTRAINT "positions_size_positive" CHECK ("positions"."size" > 0),
	CONSTRAINT "positions_entry_px_positive" CHECK ("positions"."entry_px" > 0),
	CONSTRAINT "positions_leverage_min" CHECK ("positions"."leverage" >= 1),
	CONSTRAINT "positions_liquidation_px_positive" CHECK ("positions"."liquidation_px" is null or "positions"."liquidation_px" > 0),
	CONSTRAINT "positions_margin_used_non_negative" CHECK ("positions"."margin_used" >= 0),
	CONSTRAINT "positions_notional_non_negative" CHECK ("positions"."notional" >= 0)
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" integer NOT NULL,
	"wallet_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"account_value" numeric(30, 8) NOT NULL,
	"market_px" numeric(38, 18),
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshots_account_value_non_negative" CHECK ("snapshots"."account_value" >= 0),
	CONSTRAINT "snapshots_market_px_positive" CHECK ("snapshots"."market_px" is null or "snapshots"."market_px" > 0)
);
--> statement-breakpoint
CREATE TABLE "asset_wallets" (
	"asset_id" integer NOT NULL,
	"wallet_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_wallets_pk" PRIMARY KEY("asset_id","wallet_id")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "assets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ticker" text NOT NULL,
	"dex" text,
	"status" "asset_status" DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_ticker_not_blank" CHECK (length(trim("assets"."ticker")) > 0),
	CONSTRAINT "assets_ticker_dex_consistent" CHECK (case when "assets"."dex" is null then position(':' in "assets"."ticker") = 0 else starts_with("assets"."ticker", "assets"."dex" || ':') and length("assets"."ticker") > length("assets"."dex") + 1 end)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wallets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"address" text NOT NULL,
	"alias" text,
	"entity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_address_format" CHECK ("wallets"."address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" "event_type" NOT NULL,
	"wallet_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"run_id" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_dedupe_key_not_blank" CHECK (length("events"."dedupe_key") > 0)
);
--> statement-breakpoint
CREATE TABLE "ai_reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"asset_id" integer NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"estimated_cost_usd" numeric(14, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_reports_input_tokens_non_negative" CHECK ("ai_reports"."input_tokens" >= 0),
	CONSTRAINT "ai_reports_output_tokens_non_negative" CHECK ("ai_reports"."output_tokens" >= 0),
	CONSTRAINT "ai_reports_cost_non_negative" CHECK ("ai_reports"."estimated_cost_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_wallets" ADD CONSTRAINT "asset_wallets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_wallets" ADD CONSTRAINT "asset_wallets_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_reports" ADD CONSTRAINT "ai_reports_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_asset_started_idx" ON "analysis_runs" USING btree ("asset_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_snapshot_oid_unique" ON "orders" USING btree ("snapshot_id","exchange_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_snapshot_unique" ON "positions" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "snapshots_asset_wallet_taken_idx" ON "snapshots" USING btree ("asset_id","wallet_id","taken_at");--> statement-breakpoint
CREATE INDEX "snapshots_run_idx" ON "snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "snapshots_wallet_idx" ON "snapshots" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "asset_wallets_wallet_idx" ON "asset_wallets" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_ticker_unique" ON "assets" USING btree ("ticker");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_address_unique" ON "wallets" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "events_dedupe_key_unique" ON "events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "events_asset_wallet_created_idx" ON "events" USING btree ("asset_id","wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "events_unread_idx" ON "events" USING btree ("created_at") WHERE "events"."read" = false;--> statement-breakpoint
CREATE INDEX "events_wallet_idx" ON "events" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_reports_asset_hash_idx" ON "ai_reports" USING btree ("asset_id","input_hash");--> statement-breakpoint
CREATE INDEX "ai_reports_created_idx" ON "ai_reports" USING btree ("created_at");