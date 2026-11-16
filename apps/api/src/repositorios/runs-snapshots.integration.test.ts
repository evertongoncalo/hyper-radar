import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analysisRuns, orders, positions, snapshots } from '../db/schema';
import { codigoErro } from '../db/teste-pg';
import { criarAmbiente, disponivel, enderecoFicticio } from './__testes__/ambiente';
import { apagarAtivo, criarAtivo } from './ativos';
import { apagarCarteira, criarOuObterCarteira } from './carteiras';
import { ErroNaoEncontrado, ErroRestricaoViolada, ErroRunFechado } from './erros';
import { gravarEventos, listarEventos } from './eventos';
import { abrirRun, fecharRun, obterRunAtivo, obterRunPorId } from './runs';
import {
  apagarSnapshotsAnterioresA,
  gravarSnapshot,
  snapshotMaisProximo,
  ultimoSnapshot,
  ultimosSnapshotsPorCarteira,
  type NovoSnapshot,
  type PosicaoGravada,
} from './snapshots';

describe.skipIf(!disponivel)('repositórios de runs e snapshots (Postgres real)', () => {
  const ambiente = criarAmbiente();
  const { db } = ambiente;
  let n = 0;

  beforeAll(() => ambiente.preparar());
  afterAll(() => ambiente.limpar());

  async function base() {
    n += 1;
    const ativo = await criarAtivo(db, `RS${n}`);
    const carteira = await criarOuObterCarteira(db, { endereco: enderecoFicticio(0x100 + n) });
    const run = await abrirRun(db, ativo.id);
    return { ativo, carteira, run };
  }

  const posicao: PosicaoGravada = {
    lado: 'short',
    tamanho: 123456.123456789,
    entryPx: 0.000012345678,
    alavancagem: 20,
    tipoMargem: 'isolated',
    liquidationPx: 0.0000151234567,
    unrealizedPnl: -1234.56789012,
    marginUsed: 98765.4321,
    notional: 1524.12345678,
  };

  const novo = (runId: number, walletId: number, extra: Partial<NovoSnapshot> = {}) =>
    ({
      runId,
      walletId,
      accountValue: 1_234_567.12345678,
      marketPx: 65454.12345678,
      posicao: null,
      ordens: [],
      ...extra,
    }) satisfies NovoSnapshot;

  const contar = async (tabela: typeof snapshots | typeof positions | typeof orders) =>
    (await db.select({ n: count() }).from(tabela))[0]!.n;

  describe('runs', () => {
    it('abre, obtém o ativo e fecha um run', async () => {
      const { ativo, run } = await base();
      expect(run).toMatchObject({ assetId: ativo.id, fim: null, motivoReinicio: null });
      expect(await obterRunAtivo(db, ativo.id)).toEqual(run);
      const fechado = await fecharRun(db, run.id);
      expect(fechado.fim).toBeInstanceOf(Date);
      expect(fechado.fim!.getTime()).toBeGreaterThanOrEqual(run.inicio.getTime());
      // Idempotente.
      expect(await fecharRun(db, run.id)).toEqual(fechado);
      expect(await obterRunAtivo(db, ativo.id)).toBeNull();
      expect(await obterRunPorId(db, run.id)).toEqual(fechado);
      expect(await obterRunPorId(db, 999_999)).toBeNull();
      await expect(fecharRun(db, 999_999)).rejects.toBeInstanceOf(ErroNaoEncontrado);
    });

    it('rejeita fim anterior ao início', async () => {
      const { run } = await base();
      await expect(fecharRun(db, run.id, new Date(0))).rejects.toBeInstanceOf(ErroRestricaoViolada);
    });

    it('abrir um novo run fecha o anterior na mesma transação (um só aberto)', async () => {
      const { ativo, run } = await base();
      const novoRun = await abrirRun(db, ativo.id, 'carteira adicionada');
      expect(novoRun.motivoReinicio).toBe('carteira adicionada');
      expect((await obterRunPorId(db, run.id))?.fim).toBeInstanceOf(Date);
      expect(await obterRunAtivo(db, ativo.id)).toEqual(novoRun);

      // Aberturas em paralelo continuam a deixar exatamente um run aberto.
      await Promise.all([abrirRun(db, ativo.id, 'a'), abrirRun(db, ativo.id, 'b')]);
      const abertos = await db
        .select({ n: count() })
        .from(analysisRuns)
        .where(eq(analysisRuns.assetId, ativo.id));
      expect(abertos[0]!.n).toBe(4);
      const ativoRun = await obterRunAtivo(db, ativo.id);
      expect(['a', 'b']).toContain(ativoRun?.motivoReinicio);
    });

    it('a BD rejeita um segundo run aberto inserido diretamente', async () => {
      const { ativo } = await base();
      expect(await codigoErro(db.insert(analysisRuns).values({ assetId: ativo.id }))).toBe('23505');
    });

    it('rejeita run para ativo inexistente', async () => {
      await expect(abrirRun(db, 999_999)).rejects.toBeInstanceOf(ErroNaoEncontrado);
    });
  });

  describe('snapshots', () => {
    it('grava snapshot com posição e ordens e lê-o de volta sem perda relevante', async () => {
      const { ativo, carteira, run } = await base();
      const gravado = await gravarSnapshot(
        db,
        novo(run.id, carteira.id, {
          marketPx: 0.000012345678,
          posicao,
          ordens: [
            { tipo: 'SL', triggerPx: 0.0000140123456, tamanho: null, reduceOnly: true, oid: 1 },
            {
              tipo: 'TP',
              triggerPx: 0.00001012345678,
              tamanho: 1000.5,
              reduceOnly: true,
              oid: 9007199254740991,
            },
          ],
        }),
      );
      expect(gravado.assetId).toBe(ativo.id);
      const lido = await ultimoSnapshot(db, run.id, carteira.id);
      expect(lido).toEqual(gravado);
      expect(lido).toMatchObject({
        accountValue: 1_234_567.12345678,
        marketPx: 0.000012345678,
        posicao,
      });
      expect(lido?.ordens).toEqual([
        { tipo: 'SL', triggerPx: 0.0000140123456, tamanho: null, reduceOnly: true, oid: 1 },
        {
          tipo: 'TP',
          triggerPx: 0.00001012345678,
          tamanho: 1000.5,
          reduceOnly: true,
          oid: 9007199254740991,
        },
      ]);
    });

    it('carteira sem posição: snapshot sem posição nem ordens', async () => {
      const { carteira, run } = await base();
      const s = await gravarSnapshot(db, novo(run.id, carteira.id, { marketPx: null }));
      expect(s).toMatchObject({ posicao: null, ordens: [], marketPx: null });
      expect(await ultimoSnapshot(db, run.id, carteira.id)).toEqual(s);
      expect(await ultimoSnapshot(db, run.id, 999_999)).toBeNull();
    });

    it('é atómico: falha numa ordem não deixa snapshot nem posição', async () => {
      const { carteira, run } = await base();
      const antes = await Promise.all([contar(snapshots), contar(positions), contar(orders)]);
      const erro = await gravarSnapshot(
        db,
        novo(run.id, carteira.id, {
          posicao,
          ordens: [
            { tipo: 'SL', triggerPx: 1, tamanho: null, reduceOnly: true, oid: 1 },
            { tipo: 'TP', triggerPx: 0, tamanho: null, reduceOnly: true, oid: 2 },
          ],
        }),
      ).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ErroRestricaoViolada);
      expect((erro as ErroRestricaoViolada).restricao).toBe('orders_trigger_px_positive');
      expect(await Promise.all([contar(snapshots), contar(positions), contar(orders)])).toEqual(
        antes,
      );
    });

    it('rejeita run fechado, run inexistente e carteira inexistente', async () => {
      const { carteira, run } = await base();
      await expect(gravarSnapshot(db, novo(999_999, carteira.id))).rejects.toBeInstanceOf(
        ErroNaoEncontrado,
      );
      await expect(gravarSnapshot(db, novo(run.id, 999_999))).rejects.toThrow(/Carteira/);
      await fecharRun(db, run.id);
      await expect(gravarSnapshot(db, novo(run.id, carteira.id))).rejects.toBeInstanceOf(
        ErroRunFechado,
      );
    });

    it('último snapshot por carteira do ativo, por run e até um instante', async () => {
      const { ativo, carteira: a, run } = await base();
      const b = await criarOuObterCarteira(db, { endereco: enderecoFicticio(0x900) });
      const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, min));
      await gravarSnapshot(db, novo(run.id, a.id, { instante: t(0), accountValue: 1 }));
      await gravarSnapshot(db, novo(run.id, a.id, { instante: t(10), accountValue: 2, posicao }));
      await gravarSnapshot(db, novo(run.id, b.id, { instante: t(5), accountValue: 3 }));
      const run2 = await abrirRun(db, ativo.id, 'reinício');
      await gravarSnapshot(db, novo(run2.id, b.id, { instante: t(20), accountValue: 4 }));

      const todos = await ultimosSnapshotsPorCarteira(db, ativo.id);
      expect(todos.map((s) => [s.walletId, s.accountValue])).toEqual([
        [a.id, 2],
        [b.id, 4],
      ]);
      expect(todos[0]?.posicao).toEqual(posicao);

      const doRun2 = await ultimosSnapshotsPorCarteira(db, ativo.id, { runId: run2.id });
      expect(doRun2.map((s) => s.accountValue)).toEqual([4]);

      const ate7 = await ultimosSnapshotsPorCarteira(db, ativo.id, { ate: t(7) });
      expect(ate7.map((s) => s.accountValue)).toEqual([1, 3]);

      expect((await snapshotMaisProximo(db, ativo.id, a.id, t(9)))?.accountValue).toBe(1);
      expect((await snapshotMaisProximo(db, ativo.id, a.id, t(10)))?.accountValue).toBe(2);
      expect(await snapshotMaisProximo(db, ativo.id, a.id, t(-1))).toBeNull();
      expect(await ultimosSnapshotsPorCarteira(db, 999_999)).toEqual([]);
    });

    it('retenção apaga snapshots antigos (com posições e ordens) e mantém eventos', async () => {
      const { ativo, carteira, run } = await base();
      const antigo = await gravarSnapshot(
        db,
        novo(run.id, carteira.id, {
          instante: new Date('2000-01-01T00:00:00Z'),
          posicao,
          ordens: [{ tipo: 'SL', triggerPx: 1, tamanho: null, reduceOnly: true, oid: 7 }],
        }),
      );
      const recente = await gravarSnapshot(db, novo(run.id, carteira.id));
      await gravarEventos(db, [
        { tipo: 'OPENED', assetId: ativo.id, walletId: carteira.id, dedupeKey: `ret-${n}` },
      ]);

      const apagados = await apagarSnapshotsAnterioresA(db, new Date('2001-01-01T00:00:00Z'));
      expect(apagados).toBeGreaterThanOrEqual(1);
      const restantes = await db.select().from(snapshots).where(eq(snapshots.runId, run.id));
      expect(restantes.map((s) => s.id)).toEqual([recente.id]);
      expect(await db.select().from(positions).where(eq(positions.snapshotId, antigo.id))).toEqual(
        [],
      );
      expect(await db.select().from(orders).where(eq(orders.snapshotId, antigo.id))).toEqual([]);
      expect((await listarEventos(db, { assetId: ativo.id })).itens).toHaveLength(1);
      expect(await apagarSnapshotsAnterioresA(db, new Date('2001-01-01T00:00:00Z'))).toBe(0);
    });

    it('cascatas: apagar carteira apaga os seus snapshots; apagar ativo apaga runs', async () => {
      const { ativo, carteira, run } = await base();
      const s = await gravarSnapshot(db, novo(run.id, carteira.id, { posicao }));
      await apagarCarteira(db, carteira.id);
      expect(await db.select().from(snapshots).where(eq(snapshots.id, s.id))).toEqual([]);
      expect(await db.select().from(positions).where(eq(positions.snapshotId, s.id))).toEqual([]);
      await apagarAtivo(db, ativo.id);
      expect(await obterRunPorId(db, run.id)).toBeNull();
    });
  });
});
