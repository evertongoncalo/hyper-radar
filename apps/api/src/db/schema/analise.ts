import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { assets, wallets } from './carteiras';
import { decimalCripto, decimalUsd, marginType, orderKind, positionSide } from './comum';

/** Execuções da análise de um ativo; cada reinício (ex.: alteração de carteiras) abre um novo run. */
export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    // Nulo enquanto o run está em curso.
    endedAt: timestamp('ended_at', { withTimezone: true }),
    // Motivo do reinício que originou este run (nulo no primeiro arranque).
    restartReason: text('restart_reason'),
  },
  (t) => [
    index('analysis_runs_asset_started_idx').on(t.assetId, t.startedAt),
    // No máximo um run em curso por ativo (garantido pela BD, mesmo com escritas concorrentes).
    uniqueIndex('analysis_runs_one_open_per_asset')
      .on(t.assetId)
      .where(sql`${t.endedAt} is null`),
    check(
      'analysis_runs_end_after_start',
      sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`,
    ),
  ],
);

/** Fotografia do estado de uma carteira num ativo, num ciclo de recolha. */
export const snapshots = pgTable(
  'snapshots',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: integer('run_id')
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'cascade' }),
    // Apagar a carteira apaga o seu histórico de snapshots (sem a carteira deixam de ter significado).
    walletId: integer('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    // Redundante com o run, mas evita joins nas consultas por (ativo, carteira, tempo).
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    // `marginSummary.accountValue`: equity da conta, base do cálculo proporcional.
    accountValue: decimalUsd('account_value').notNull(),
    // `false` em conta unificada / margem de portfólio: o `accountValue` por DEX não representa a
    // equity real da conta (o cálculo proporcional não o deve usar sem ressalva).
    accountValueRepresentative: boolean('account_value_representative').notNull().default(true),
    // Modo da conta devolvido pela Hyperliquid (`userAbstraction`); `null` se desconhecido.
    accountMode: text('account_mode'),
    marketPx: decimalCripto('market_px'),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('snapshots_asset_wallet_taken_idx').on(t.assetId, t.walletId, t.takenAt),
    index('snapshots_run_idx').on(t.runId),
    index('snapshots_wallet_idx').on(t.walletId),
    check('snapshots_account_value_non_negative', sql`${t.accountValue} >= 0`),
    check('snapshots_market_px_positive', sql`${t.marketPx} is null or ${t.marketPx} > 0`),
  ],
);

/** Posição aberta no ativo do snapshot (no máximo uma; carteira sem posição ⇒ nenhuma linha). */
export const positions = pgTable(
  'positions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    snapshotId: bigint('snapshot_id', { mode: 'number' })
      .notNull()
      .references(() => snapshots.id, { onDelete: 'cascade' }),
    side: positionSide('side').notNull(),
    // Tamanho absoluto (|szi|); o sinal vive em `side`.
    size: decimalCripto('size').notNull(),
    entryPx: decimalCripto('entry_px').notNull(),
    leverage: integer('leverage').notNull(),
    marginType: marginType('margin_type').notNull(),
    // Nulo quando a exchange não calcula liquidação (ex.: margem cross muito folgada).
    liquidationPx: decimalCripto('liquidation_px'),
    unrealizedPnl: decimalUsd('unrealized_pnl').notNull(),
    marginUsed: decimalUsd('margin_used').notNull(),
    notional: decimalUsd('notional').notNull(),
  },
  (t) => [
    uniqueIndex('positions_snapshot_unique').on(t.snapshotId),
    check('positions_size_positive', sql`${t.size} > 0`),
    check('positions_entry_px_positive', sql`${t.entryPx} > 0`),
    check('positions_leverage_min', sql`${t.leverage} >= 1`),
    check(
      'positions_liquidation_px_positive',
      sql`${t.liquidationPx} is null or ${t.liquidationPx} > 0`,
    ),
    check('positions_margin_used_non_negative', sql`${t.marginUsed} >= 0`),
    check('positions_notional_non_negative', sql`${t.notional} >= 0`),
  ],
);

/** Ordens de trigger SL/TP abertas na exchange no momento do snapshot. */
export const orders = pgTable(
  'orders',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    snapshotId: bigint('snapshot_id', { mode: 'number' })
      .notNull()
      .references(() => snapshots.id, { onDelete: 'cascade' }),
    kind: orderKind('kind').notNull(),
    triggerPx: decimalCripto('trigger_px').notNull(),
    // Nulo = ordem sobre a posição inteira (a Hyperliquid devolve `sz` 0 nas TP/SL de posição).
    size: decimalCripto('size'),
    reduceOnly: boolean('reduce_only').notNull(),
    // `oid` da Hyperliquid (inteiro < 2^53, seguro como number).
    exchangeOrderId: bigint('exchange_order_id', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('orders_snapshot_oid_unique').on(t.snapshotId, t.exchangeOrderId),
    check('orders_trigger_px_positive', sql`${t.triggerPx} > 0`),
    check('orders_size_positive', sql`${t.size} is null or ${t.size} > 0`),
  ],
);

export type AnalysisRun = typeof analysisRuns.$inferSelect;
export type NovoAnalysisRun = typeof analysisRuns.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
export type NovoSnapshot = typeof snapshots.$inferInsert;
export type Position = typeof positions.$inferSelect;
export type NovaPosition = typeof positions.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NovaOrder = typeof orders.$inferInsert;
