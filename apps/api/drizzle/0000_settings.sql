CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"capital_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
	"max_leverage" integer DEFAULT 5 NOT NULL,
	"risk_per_trade_pct" numeric(5, 2) DEFAULT '1.00' NOT NULL,
	"poll_interval_seconds" integer DEFAULT 60 NOT NULL,
	"ai_daily_call_limit" integer DEFAULT 10 NOT NULL,
	"ai_daily_token_limit" integer DEFAULT 200000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_single_row" CHECK ("settings"."id" = 1),
	CONSTRAINT "settings_capital_non_negative" CHECK ("settings"."capital_usd" >= 0),
	CONSTRAINT "settings_max_leverage_range" CHECK ("settings"."max_leverage" between 1 and 100),
	CONSTRAINT "settings_risk_pct_range" CHECK ("settings"."risk_per_trade_pct" > 0 and "settings"."risk_per_trade_pct" <= 100),
	CONSTRAINT "settings_poll_interval_min" CHECK ("settings"."poll_interval_seconds" >= 15),
	CONSTRAINT "settings_ai_call_limit_non_negative" CHECK ("settings"."ai_daily_call_limit" >= 0),
	CONSTRAINT "settings_ai_token_limit_non_negative" CHECK ("settings"."ai_daily_token_limit" >= 0)
);
