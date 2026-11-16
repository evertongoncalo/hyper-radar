import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aiReports,
  analysisRuns,
  assets,
  assetWallets,
  events,
  orders,
  positions,
  snapshots,
  wallets,
  type NovaPosition,
} from './schema';
import { semear } from './seed';
import { codigoErro, criarSchemaIsolado, prepararBaseTeste } from './teste-pg';
import { resolverUrlTeste } from './url-teste';

/**
 * Teste de integração do schema completo (constraints, cascatas e fluxo ponta a ponta).
 * Mesmo mecanismo do teste de migrações: schema isolado numa base `*_test`; skip sem Postgres.
 */
const urlTeste = resolverUrlTeste();
const disponivel = await prepararBaseTeste(urlTeste);

/** Endereço fictício óbvio: `0x` + 39 zeros + o dígito hexadecimal indicado. */
const enderecoFicticio = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

describe.skipIf(!disponivel)('schema (Postgres real)', () => {
  const isolado = criarSchemaIsolado(urlTeste);
  const { db, schema } = isolado;
  let contador = 0;

  /** Cria um ativo, uma carteira associada, um run e um snapshot; devolve os ids. */
  async function criarGrafo() {
    contador += 1;
    const [ativo] = await db
      .insert(assets)
      .values({ ticker: `TST${contador}` })
      .returning();
    const [carteira] = await db
      .insert(wallets)
      .values({ address: enderecoFicticio(contador), alias: `Fictícia ${contador}` })
      .returning();
    if (!ativo || !carteira) throw new Error('falha a criar ativo/carteira');
    await db.insert(assetWallets).values({ assetId: ativo.id, walletId: carteira.id });
    const [run] = await db.insert(analysisRuns).values({ assetId: ativo.id }).returning();
    if (!run) throw new Error('falha a criar run');
    const [snap] = await db
      .insert(snapshots)
      .values({
        runId: run.id,
        walletId: carteira.id,
        assetId: ativo.id,
        accountValue: '1000000',
        marketPx: '100',
      })
      .returning();
    if (!snap) throw new Error('falha a criar snapshot');
    return { assetId: ativo.id, walletId: carteira.id, runId: run.id, snapshotId: snap.id };
  }

  const posicaoBase = (snapshotId: number): NovaPosition => ({
    snapshotId,
    side: 'long',
    size: '1',
    entryPx: '100',
    leverage: 5,
    marginType: 'cross',
    unrealizedPnl: '0',
    marginUsed: '20',
    notional: '100',
  });

  beforeAll(() => isolado.preparar());
  afterAll(() => isolado.limpar());

  it('cria todas as tabelas e enums no schema isolado', async () => {
    const tabelas = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = ${schema} and table_name <> '__drizzle_migrations'`,
    );
    expect(tabelas.map((t) => t.table_name).sort()).toEqual(
      [
        'ai_reports',
        'analysis_runs',
        'asset_wallets',
        'assets',
        'events',
        'orders',
        'positions',
        'settings',
        'snapshots',
        'wallets',
      ].sort(),
    );
    const enums = await db.execute<{ typname: string }>(
      sql`select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = ${schema} and t.typtype = 'e'`,
    );
    expect(enums.map((e) => e.typname).sort()).toEqual(
      ['asset_status', 'event_type', 'margin_type', 'order_kind', 'position_side'].sort(),
    );
  });

  describe('carteiras', () => {
    it.each([
      ['sem prefixo 0x', '0'.repeat(42)],
      ['maiúsculas', `0x${'A'.repeat(40)}`],
      ['curto', `0x${'0'.repeat(39)}`],
      ['longo', `0x${'0'.repeat(41)}`],
      ['caracteres não hex', `0x${'g'.repeat(40)}`],
    ])('rejeita endereço %s', async (_d, address) => {
      expect(await codigoErro(db.insert(wallets).values({ address }))).toBe('23514');
    });

    it('rejeita endereço duplicado', async () => {
      const address = enderecoFicticio(0xfff);
      await db.insert(wallets).values({ address });
      expect(await codigoErro(db.insert(wallets).values({ address }))).toBe('23505');
    });
  });

  describe('ativos', () => {
    it('aceita nativo sem dex e HIP-3 com dex, com estado idle por omissão', async () => {
      const linhas = await db
        .insert(assets)
        .values([{ ticker: 'NATIVO' }, { ticker: 'xyz:NVDA', dex: 'xyz' }])
        .returning();
      expect(linhas.map((l) => l.status)).toEqual(['idle', 'idle']);
    });

    it('rejeita ticker duplicado', async () => {
      expect(await codigoErro(db.insert(assets).values({ ticker: 'NATIVO' }))).toBe('23505');
    });

    it.each([
      ['dex sem prefixo no ticker', { ticker: 'NVDA2', dex: 'xyz' }],
      ['prefixo sem dex', { ticker: 'abc:NVDA' }],
      ['dex diferente do prefixo', { ticker: 'abc:NVDA', dex: 'xyz' }],
      ['ticker vazio após o prefixo', { ticker: 'xyz:', dex: 'xyz' }],
      ['ticker em branco', { ticker: '  ' }],
    ])('rejeita %s', async (_d, valores) => {
      expect(await codigoErro(db.insert(assets).values(valores))).toBe('23514');
    });
  });

  describe('posições e ordens', () => {
    it.each([
      ['tamanho 0', { size: '0' }],
      ['tamanho negativo', { size: '-1' }],
      ['entrada 0', { entryPx: '0' }],
      ['alavancagem 0', { leverage: 0 }],
      ['liquidação 0', { liquidationPx: '0' }],
      ['margem negativa', { marginUsed: '-1' }],
    ] as const)('rejeita posição com %s', async (_d, valores) => {
      const { snapshotId } = await criarGrafo();
      const codigo = await codigoErro(
        db.insert(positions).values({ ...posicaoBase(snapshotId), ...valores }),
      );
      expect(codigo).toBe('23514');
    });

    it('rejeita segunda posição no mesmo snapshot', async () => {
      const { snapshotId } = await criarGrafo();
      await db.insert(positions).values(posicaoBase(snapshotId));
      expect(await codigoErro(db.insert(positions).values(posicaoBase(snapshotId)))).toBe('23505');
    });

    it.each([
      ['tamanho 0', { size: '0' }],
      ['trigger 0', { triggerPx: '0' }],
    ])('rejeita ordem com %s', async (_d, valores) => {
      const { snapshotId } = await criarGrafo();
      const ordem = {
        snapshotId,
        kind: 'SL' as const,
        triggerPx: '90',
        reduceOnly: true,
        exchangeOrderId: 1,
        ...valores,
      };
      expect(await codigoErro(db.insert(orders).values(ordem))).toBe('23514');
    });
  });

  describe('eventos', () => {
    it('rejeita chave de deduplicação duplicada', async () => {
      const { assetId, walletId, runId } = await criarGrafo();
      const evento = { type: 'OPENED' as const, assetId, walletId, runId, dedupeKey: 'dup-1' };
      await db.insert(events).values(evento);
      expect(await codigoErro(db.insert(events).values(evento))).toBe('23505');
    });

    it('mantém o evento (run_id nulo) quando o run é apagado', async () => {
      const { assetId, walletId, runId } = await criarGrafo();
      const [ev] = await db
        .insert(events)
        .values({ type: 'CLOSED', assetId, walletId, runId, dedupeKey: 'run-apagado' })
        .returning();
      await db.delete(analysisRuns).where(eq(analysisRuns.id, runId));
      const [depois] = await db.select().from(events).where(eq(events.id, ev!.id));
      expect(depois?.runId).toBeNull();
    });
  });

  describe('cascatas ON DELETE', () => {
    /** Conta as linhas de cada tabela dependente filtradas pelo ativo/carteira do grafo. */
    async function contagens(assetId: number, walletId: number, snapshotId: number) {
      const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? -1;
      return {
        assetWallets: await n(
          db.select({ n: count() }).from(assetWallets).where(eq(assetWallets.walletId, walletId)),
        ),
        runs: await n(
          db.select({ n: count() }).from(analysisRuns).where(eq(analysisRuns.assetId, assetId)),
        ),
        snapshots: await n(
          db.select({ n: count() }).from(snapshots).where(eq(snapshots.walletId, walletId)),
        ),
        positions: await n(
          db.select({ n: count() }).from(positions).where(eq(positions.snapshotId, snapshotId)),
        ),
        orders: await n(
          db.select({ n: count() }).from(orders).where(eq(orders.snapshotId, snapshotId)),
        ),
        events: await n(
          db.select({ n: count() }).from(events).where(eq(events.walletId, walletId)),
        ),
        aiReports: await n(
          db.select({ n: count() }).from(aiReports).where(eq(aiReports.assetId, assetId)),
        ),
      };
    }

    async function grafoCompleto() {
      const g = await criarGrafo();
      await db.insert(positions).values(posicaoBase(g.snapshotId));
      await db.insert(orders).values({
        snapshotId: g.snapshotId,
        kind: 'TP',
        triggerPx: '120',
        reduceOnly: true,
        exchangeOrderId: 42,
      });
      await db.insert(events).values({
        type: 'OPENED',
        assetId: g.assetId,
        walletId: g.walletId,
        runId: g.runId,
        dedupeKey: `cascata-${g.snapshotId}`,
      });
      await db.insert(aiReports).values({
        assetId: g.assetId,
        model: 'modelo-ficticio',
        inputHash: 'a'.repeat(64),
        response: { resumo: 'fictício' },
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: '0.000070',
      });
      return g;
    }

    it('apagar um ativo apaga runs, snapshots, posições, ordens, eventos e relatórios', async () => {
      const g = await grafoCompleto();
      expect(Object.values(await contagens(g.assetId, g.walletId, g.snapshotId))).not.toContain(0);

      await db.delete(assets).where(eq(assets.id, g.assetId));

      expect(await contagens(g.assetId, g.walletId, g.snapshotId)).toEqual({
        assetWallets: 0,
        runs: 0,
        snapshots: 0,
        positions: 0,
        orders: 0,
        events: 0,
        aiReports: 0,
      });
      const [carteira] = await db.select().from(wallets).where(eq(wallets.id, g.walletId));
      expect(carteira).toBeDefined();
    });

    it('apagar uma carteira remove associações, snapshots e eventos, mas não o ativo', async () => {
      const g = await grafoCompleto();
      await db.delete(wallets).where(eq(wallets.id, g.walletId));

      expect(await contagens(g.assetId, g.walletId, g.snapshotId)).toMatchObject({
        assetWallets: 0,
        runs: 1,
        snapshots: 0,
        positions: 0,
        orders: 0,
        events: 0,
        aiReports: 1,
      });
      const [ativo] = await db.select().from(assets).where(eq(assets.id, g.assetId));
      expect(ativo).toBeDefined();
    });
  });

  it('seed de desenvolvimento é idempotente', async () => {
    const totais = async () => ({
      ativos: (await db.select({ n: count() }).from(assets))[0]?.n,
      carteiras: (await db.select({ n: count() }).from(wallets))[0]?.n,
      associacoes: (await db.select({ n: count() }).from(assetWallets))[0]?.n,
    });
    await semear(db);
    const primeira = await totais();
    await semear(db);
    expect(await totais()).toEqual(primeira);
    const [btc] = await db.select().from(assets).where(eq(assets.ticker, 'BTC'));
    const n = await db
      .select({ n: count() })
      .from(assetWallets)
      .where(eq(assetWallets.assetId, btc!.id));
    expect(n[0]?.n).toBe(3);
  });

  it('fluxo ponta a ponta: run → snapshot → posição/ordem → evento', async () => {
    const [ativo] = await db.insert(assets).values({ ticker: 'xyz:E2E', dex: 'xyz' }).returning();
    const [carteira] = await db
      .insert(wallets)
      .values({ address: enderecoFicticio(0xe2e), alias: 'Baleia fictícia', entity: 'Fundo X' })
      .returning();
    const [run] = await db
      .insert(analysisRuns)
      .values({ assetId: ativo!.id, restartReason: 'carteira adicionada' })
      .returning();
    const [snap] = await db
      .insert(snapshots)
      .values({
        runId: run!.id,
        walletId: carteira!.id,
        assetId: ativo!.id,
        accountValue: '1234567.12345678',
        marketPx: '0.000001234567890123',
      })
      .returning();
    await db.insert(positions).values({
      ...posicaoBase(snap!.id),
      side: 'short',
      size: '123456789.000000000000000001',
      entryPx: '0.000001200000000001',
      leverage: 20,
      marginType: 'isolated',
      liquidationPx: '0.0000015',
      unrealizedPnl: '-12.5',
    });
    await db.insert(orders).values([
      {
        snapshotId: snap!.id,
        kind: 'SL',
        triggerPx: '0.0000014',
        reduceOnly: true,
        exchangeOrderId: 9007199254740991,
      },
      {
        snapshotId: snap!.id,
        kind: 'TP',
        triggerPx: '0.000001',
        size: '1000',
        reduceOnly: true,
        exchangeOrderId: 2,
      },
    ]);
    const payload = { tamanho: '123456789', entrada: '0.0000012', aninhado: { lista: [1, 2] } };
    await db.insert(events).values({
      type: 'OPENED',
      assetId: ativo!.id,
      walletId: carteira!.id,
      runId: run!.id,
      payload,
      dedupeKey: 'e2e-opened',
    });

    const lido = await db.query.snapshots.findFirst({ where: eq(snapshots.id, snap!.id) });
    expect(lido).toMatchObject({
      accountValue: '1234567.12345678',
      marketPx: '0.000001234567890123',
    });
    expect(lido?.takenAt).toBeInstanceOf(Date);

    const [pos] = await db.select().from(positions).where(eq(positions.snapshotId, snap!.id));
    expect(pos).toMatchObject({
      side: 'short',
      size: '123456789.000000000000000001',
      entryPx: '0.000001200000000001',
      leverage: 20,
      marginType: 'isolated',
      liquidationPx: '0.000001500000000000',
      unrealizedPnl: '-12.50000000',
    });

    const ordens = await db
      .select()
      .from(orders)
      .where(eq(orders.snapshotId, snap!.id))
      .orderBy(orders.kind);
    expect(ordens.map((o) => [o.kind, o.size, o.exchangeOrderId])).toEqual([
      ['SL', null, 9007199254740991],
      ['TP', '1000.000000000000000000', 2],
    ]);

    const [ev] = await db
      .select({ evento: events, ticker: assets.ticker, alias: wallets.alias })
      .from(events)
      .innerJoin(assets, eq(events.assetId, assets.id))
      .innerJoin(wallets, eq(events.walletId, wallets.id))
      .where(eq(events.dedupeKey, 'e2e-opened'));
    expect(ev).toMatchObject({
      ticker: 'xyz:E2E',
      alias: 'Baleia fictícia',
      evento: { type: 'OPENED', read: false, runId: run!.id, payload },
    });
  });
});
