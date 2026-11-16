import { numeric, pgEnum, timestamp } from 'drizzle-orm/pg-core';

/** Estados de um ativo (secção 2): `idle` → `running` → `stopped`; `running` → `restarting`. */
export const assetStatus = pgEnum('asset_status', ['idle', 'running', 'stopped', 'restarting']);

/** Lado de uma posição (derivado do sinal de `szi` na Hyperliquid). */
export const positionSide = pgEnum('position_side', ['long', 'short']);

/** Tipo de margem da posição na Hyperliquid. */
export const marginType = pgEnum('margin_type', ['cross', 'isolated']);

/** Tipo de ordem de trigger visível na exchange: stop loss ou take profit. */
export const orderKind = pgEnum('order_kind', ['SL', 'TP']);

/** Tipos de evento gerados pelo diff entre snapshots (secção 6.1). */
export const eventType = pgEnum('event_type', [
  'OPENED',
  'CLOSED',
  'INCREASED',
  'REDUCED',
  'FLIPPED',
  'SLTP_CHANGED',
  'LIQ_NEAR',
]);

/** Preços e tamanhos: 38 dígitos com 18 casas decimais cobrem tokens de preço ínfimo e tamanhos enormes. */
export const decimalCripto = (nome: string) => numeric(nome, { precision: 38, scale: 18 });

/** Valores em USD (equity, PnL, margem, notional): 30 dígitos com 8 casas decimais. */
export const decimalUsd = (nome: string) => numeric(nome, { precision: 30, scale: 8 });

/** `timestamptz` com valor por omissão `now()`. */
export const criadoEm = (nome = 'created_at') =>
  timestamp(nome, { withTimezone: true }).notNull().defaultNow();
