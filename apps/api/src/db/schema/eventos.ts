import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { analysisRuns } from './analise';
import { assets, wallets } from './carteiras';
import { criadoEm, eventType } from './comum';

/** Eventos tipados gerados pelo diff entre snapshots (secção 6.1). */
export const events = pgTable(
  'events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    type: eventType('type').notNull(),
    walletId: integer('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    // `set null`: os eventos (sem limite de retenção) sobrevivem à limpeza de runs antigos.
    runId: integer('run_id').references(() => analysisRuns.id, { onDelete: 'set null' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    // Chave de deduplicação (carteira + ativo + tipo + janela), calculada pelo motor de análise.
    dedupeKey: text('dedupe_key').notNull(),
    read: boolean('read').notNull().default(false),
    createdAt: criadoEm(),
  },
  (t) => [
    uniqueIndex('events_dedupe_key_unique').on(t.dedupeKey),
    index('events_asset_wallet_created_idx').on(t.assetId, t.walletId, t.createdAt),
    // Índice parcial: só os não lidos (contador e feed de notificações).
    index('events_unread_idx')
      .on(t.createdAt)
      .where(sql`${t.read} = false`),
    index('events_wallet_idx').on(t.walletId),
    index('events_run_idx').on(t.runId),
    check('events_dedupe_key_not_blank', sql`length(${t.dedupeKey}) > 0`),
  ],
);

export type Event = typeof events.$inferSelect;
export type NovoEvent = typeof events.$inferInsert;
