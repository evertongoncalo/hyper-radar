import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import { assets } from './carteiras';
import { criadoEm } from './comum';

/** Relatórios da análise IA (pedidos manualmente), com cache por hash do input. */
export const aiReports = pgTable(
  'ai_reports',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    // Hash (ex.: SHA-256 hex) do JSON de input; permite devolver o relatório anterior se nada mudou.
    inputHash: text('input_hash').notNull(),
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 14, scale: 6 }).notNull(),
    createdAt: criadoEm(),
  },
  (t) => [
    index('ai_reports_asset_hash_idx').on(t.assetId, t.inputHash),
    // Limites diários: contagem de chamadas/tokens por data.
    index('ai_reports_created_idx').on(t.createdAt),
    check('ai_reports_input_tokens_non_negative', sql`${t.inputTokens} >= 0`),
    check('ai_reports_output_tokens_non_negative', sql`${t.outputTokens} >= 0`),
    check('ai_reports_cost_non_negative', sql`${t.estimatedCostUsd} >= 0`),
  ],
);

export type AiReport = typeof aiReports.$inferSelect;
export type NovoAiReport = typeof aiReports.$inferInsert;
