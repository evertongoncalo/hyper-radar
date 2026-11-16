import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { assetStatus, criadoEm } from './comum';

/** Ativos acompanhados (perps nativos, ex.: `BTC`, ou HIP-3, ex.: `xyz:NVDA`). */
export const assets = pgTable(
  'assets',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    ticker: text('ticker').notNull(),
    // DEX do builder (HIP-3); nulo para os perps nativos da Hyperliquid.
    dex: text('dex'),
    status: assetStatus('status').notNull().default('idle'),
    createdAt: criadoEm(),
  },
  (t) => [
    uniqueIndex('assets_ticker_unique').on(t.ticker),
    check('assets_ticker_not_blank', sql`length(trim(${t.ticker})) > 0`),
    // Coerência HIP-3: com `dex`, o ticker tem de ser `dex:ativo`; sem `dex`, não pode ter prefixo.
    check(
      'assets_ticker_dex_consistent',
      // `case` em vez de `or`: com `dex` nulo, `starts_with` daria NULL e o CHECK passaria.
      sql`case when ${t.dex} is null then position(':' in ${t.ticker}) = 0 else starts_with(${t.ticker}, ${t.dex} || ':') and length(${t.ticker}) > length(${t.dex}) + 1 end`,
    ),
  ],
);

/** Carteiras (endereços públicos) acompanhadas; nunca chaves privadas. */
export const wallets = pgTable(
  'wallets',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    // Endereço normalizado em minúsculas antes de gravar; a constraint rejeita qualquer outra forma.
    address: text('address').notNull(),
    alias: text('alias'),
    // Entidade opcional (ex.: várias carteiras do mesmo fundo), usada para detetar hedges.
    entity: text('entity'),
    createdAt: criadoEm(),
  },
  (t) => [
    uniqueIndex('wallets_address_unique').on(t.address),
    check('wallets_address_format', sql`${t.address} ~ '^0x[0-9a-f]{40}$'`),
  ],
);

/** Associação N:N entre ativos e as carteiras a acompanhar nesse ativo. */
export const assetWallets = pgTable(
  'asset_wallets',
  {
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    walletId: integer('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    createdAt: criadoEm(),
  },
  (t) => [
    primaryKey({ name: 'asset_wallets_pk', columns: [t.assetId, t.walletId] }),
    // A PK cobre consultas por ativo; este índice cobre "em que ativos está a carteira".
    index('asset_wallets_wallet_idx').on(t.walletId),
  ],
);

export type Asset = typeof assets.$inferSelect;
export type NovoAsset = typeof assets.$inferInsert;
export type Wallet = typeof wallets.$inferSelect;
export type NovaWallet = typeof wallets.$inferInsert;
export type AssetWallet = typeof assetWallets.$inferSelect;
export type NovoAssetWallet = typeof assetWallets.$inferInsert;
