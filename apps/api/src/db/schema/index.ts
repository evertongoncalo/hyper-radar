import { sql } from 'drizzle-orm';
import { check, integer, numeric, pgTable, timestamp } from 'drizzle-orm/pg-core';

// Restantes tabelas da secção 10, organizadas por domínio.
export * from './comum';
export * from './carteiras';
export * from './analise';
export * from './eventos';
export * from './ia';

/**
 * Definições do utilizador (secção 10 da especificação). Tabela de linha única:
 * o `id` está fixo em 1 por constraint, para nunca haver duas linhas de definições.
 */
export const settings = pgTable(
  'settings',
  {
    id: integer('id').primaryKey().default(1),
    // Capital disponível para a sugestão proporcional, em USD (numeric: nunca vírgula flutuante).
    capitalUsd: numeric('capital_usd', { precision: 20, scale: 2 }).notNull().default('0'),
    // Alavancagem máxima aceite pelo utilizador (a Hyperliquid usa valores inteiros).
    maxLeverage: integer('max_leverage').notNull().default(5),
    // Risco máximo por operação, em percentagem do capital (ex.: 1.00 = 1 %).
    riskPerTradePct: numeric('risk_per_trade_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('1.00'),
    // Intervalo de recolha de dados, em segundos (mínimo 15 s para respeitar os limites da API).
    pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(60),
    // Limites diários da análise IA (chamadas e tokens).
    aiDailyCallLimit: integer('ai_daily_call_limit').notNull().default(10),
    aiDailyTokenLimit: integer('ai_daily_token_limit').notNull().default(200000),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('settings_single_row', sql`${t.id} = 1`),
    check('settings_capital_non_negative', sql`${t.capitalUsd} >= 0`),
    check('settings_max_leverage_range', sql`${t.maxLeverage} between 1 and 100`),
    check('settings_risk_pct_range', sql`${t.riskPerTradePct} > 0 and ${t.riskPerTradePct} <= 100`),
    check('settings_poll_interval_min', sql`${t.pollIntervalSeconds} >= 15`),
    check('settings_ai_call_limit_non_negative', sql`${t.aiDailyCallLimit} >= 0`),
    check('settings_ai_token_limit_non_negative', sql`${t.aiDailyTokenLimit} >= 0`),
  ],
);

export type Settings = typeof settings.$inferSelect;
export type NovasSettings = typeof settings.$inferInsert;
