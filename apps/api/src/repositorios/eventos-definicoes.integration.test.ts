import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarAmbiente, disponivel, enderecoFicticio } from './__testes__/ambiente';
import { apagarAtivo, criarAtivo, type Ativo } from './ativos';
import { apagarCarteira, criarOuObterCarteira, type Carteira } from './carteiras';
import { atualizarDefinicoes, obterDefinicoes } from './definicoes';
import { ErroNaoEncontrado, ErroRestricaoViolada, ErroValorInvalido } from './erros';
import {
  contarEventosNaoLidos,
  gravarEventos,
  listarEventos,
  marcarEventoLido,
  marcarEventosDoAtivoLidos,
  type EventoDetalhado,
  type NovoEvento,
} from './eventos';
import { abrirRun } from './runs';

describe.skipIf(!disponivel)('repositórios de eventos e definições (Postgres real)', () => {
  const ambiente = criarAmbiente();
  const { db } = ambiente;
  let btc: Ativo;
  let nvda: Ativo;
  let a: Carteira;
  let b: Carteira;

  beforeAll(async () => {
    await ambiente.preparar();
    btc = await criarAtivo(db, 'BTC');
    nvda = await criarAtivo(db, 'xyz:NVDA');
    a = await criarOuObterCarteira(db, { endereco: enderecoFicticio(1), alias: 'A' });
    b = await criarOuObterCarteira(db, { endereco: enderecoFicticio(2), alias: null });
  });
  afterAll(() => ambiente.limpar());

  const ev = (chave: string, extra: Partial<NovoEvento> = {}): NovoEvento => ({
    tipo: 'OPENED',
    assetId: btc.id,
    walletId: a.id,
    dedupeKey: chave,
    ...extra,
  });

  describe('eventos', () => {
    it('grava de forma idempotente e devolve só os inseridos', async () => {
      const run = await abrirRun(db, btc.id);
      const primeira = await gravarEventos(db, [
        ev('k1', { runId: run.id, payload: { tamanho: 1.5, aninhado: { x: [1, 2] } } }),
        ev('k2', { tipo: 'CLOSED' }),
      ]);
      expect(primeira.map((e) => e.dedupeKey)).toEqual(['k1', 'k2']);
      expect(primeira[0]).toMatchObject({
        tipo: 'OPENED',
        runId: run.id,
        lido: false,
        payload: { tamanho: 1.5, aninhado: { x: [1, 2] } },
      });
      expect(primeira[1]?.payload).toEqual({});

      // Repetidas (também dentro do mesmo lote) são ignoradas.
      const segunda = await gravarEventos(db, [ev('k1'), ev('k3'), ev('k3'), ev('k2')]);
      expect(segunda.map((e) => e.dedupeKey)).toEqual(['k3']);
      expect(await gravarEventos(db, [])).toEqual([]);
    });

    it('rejeita evento de carteira inexistente', async () => {
      await expect(gravarEventos(db, [ev('fk', { walletId: 999_999 })])).rejects.toBeInstanceOf(
        ErroNaoEncontrado,
      );
    });

    it('filtra por ativo, carteira, tipo, não lidos e intervalo de datas', async () => {
      await gravarEventos(db, [
        ev('f1', { assetId: nvda.id, walletId: b.id, tipo: 'FLIPPED' }),
        ev('f2', { assetId: nvda.id, tipo: 'LIQ_NEAR', criadoEm: new Date('2026-01-01T00:00Z') }),
        ev('f3', { assetId: nvda.id, tipo: 'SLTP_CHANGED', criadoEm: new Date('2026-02-01Z') }),
      ]);
      const chaves = async (f: Parameters<typeof listarEventos>[1]) =>
        (await listarEventos(db, f)).itens.map((e) => e.dedupeKey);

      expect(await chaves({ assetId: nvda.id })).toEqual(['f3', 'f2', 'f1']);
      expect(await chaves({ assetId: nvda.id, walletId: b.id })).toEqual(['f1']);
      expect(await chaves({ tipos: ['LIQ_NEAR', 'FLIPPED'] })).toEqual(['f2', 'f1']);
      expect(
        await chaves({
          assetId: nvda.id,
          desde: new Date('2025-12-31Z'),
          ate: new Date('2026-01-15Z'),
        }),
      ).toEqual(['f2']);

      const [detalhe] = (await listarEventos(db, { walletId: b.id })).itens;
      expect(detalhe).toMatchObject<Partial<EventoDetalhado>>({
        ticker: 'xyz:NVDA',
        endereco: b.endereco,
        alias: null,
      });

      const f2 = (await listarEventos(db, { tipos: ['LIQ_NEAR'] })).itens[0]!;
      expect(await marcarEventoLido(db, f2.id)).toBe(true);
      expect(await marcarEventoLido(db, 999_999)).toBe(false);
      expect(await chaves({ assetId: nvda.id, apenasNaoLidos: true })).toEqual(['f3', 'f1']);
    });

    it('pagina por cursor de forma estável, mesmo com inserções entre páginas', async () => {
      const ativo = await criarAtivo(db, 'PAG');
      await gravarEventos(
        db,
        Array.from({ length: 7 }, (_, i) => ev(`p${i}`, { assetId: ativo.id })),
      );
      const p1 = await listarEventos(db, { assetId: ativo.id, limite: 3 });
      expect(p1.itens.map((e) => e.dedupeKey)).toEqual(['p6', 'p5', 'p4']);
      expect(p1.proximoCursor).toBe(p1.itens[2]!.id);

      await gravarEventos(db, [ev('novo', { assetId: ativo.id })]);
      const p2 = await listarEventos(db, {
        assetId: ativo.id,
        limite: 3,
        cursor: p1.proximoCursor,
      });
      expect(p2.itens.map((e) => e.dedupeKey)).toEqual(['p3', 'p2', 'p1']);
      const p3 = await listarEventos(db, {
        assetId: ativo.id,
        limite: 3,
        cursor: p2.proximoCursor,
      });
      expect(p3.itens.map((e) => e.dedupeKey)).toEqual(['p0']);
      expect(p3.proximoCursor).toBeNull();

      // Página exata: não anuncia uma página seguinte vazia.
      const exata = await listarEventos(db, { assetId: ativo.id, limite: 8 });
      expect(exata.itens).toHaveLength(8);
      expect(exata.proximoCursor).toBeNull();
    });

    it.each([0, 201, 1.5])('rejeita limite de página %s', async (limite) => {
      await expect(listarEventos(db, { limite })).rejects.toBeInstanceOf(ErroValorInvalido);
    });

    it('conta não lidos e marca todos os de um ativo como lidos', async () => {
      const ativo = await criarAtivo(db, 'LIDOS');
      await gravarEventos(db, [
        ev('l1', { assetId: ativo.id }),
        ev('l2', { assetId: ativo.id, walletId: b.id }),
      ]);
      const totalAntes = await contarEventosNaoLidos(db);
      expect(await contarEventosNaoLidos(db, ativo.id)).toBe(2);
      expect(await marcarEventosDoAtivoLidos(db, ativo.id)).toBe(2);
      expect(await marcarEventosDoAtivoLidos(db, ativo.id)).toBe(0);
      expect(await contarEventosNaoLidos(db, ativo.id)).toBe(0);
      expect(await contarEventosNaoLidos(db)).toBe(totalAntes - 2);
    });

    it('cascatas: apagar carteira ou ativo apaga os seus eventos', async () => {
      const ativo = await criarAtivo(db, 'CASC');
      const c = await criarOuObterCarteira(db, { endereco: enderecoFicticio(3) });
      await gravarEventos(db, [
        ev('c1', { assetId: ativo.id, walletId: c.id }),
        ev('c2', { assetId: ativo.id }),
      ]);
      await apagarCarteira(db, c.id);
      expect(
        (await listarEventos(db, { assetId: ativo.id })).itens.map((e) => e.dedupeKey),
      ).toEqual(['c2']);
      await apagarAtivo(db, ativo.id);
      expect((await listarEventos(db, { assetId: ativo.id })).itens).toEqual([]);
    });
  });

  describe('definições', () => {
    it('cria a linha única com as omissões na primeira leitura', async () => {
      const d = await obterDefinicoes(db);
      expect(d).toMatchObject({
        capitalUsd: 0,
        alavancagemMaxima: 5,
        riscoPorOperacaoPct: 1,
        intervaloRecolhaSegundos: 60,
        limiteDiarioChamadasIa: 10,
        limiteDiarioTokensIa: 200000,
      });
      expect(await obterDefinicoes(db)).toEqual(d);
    });

    it('atualiza parcialmente', async () => {
      const antes = await obterDefinicoes(db);
      const d = await atualizarDefinicoes(db, { capitalUsd: 1234.56, riscoPorOperacaoPct: 2.5 });
      expect(d).toMatchObject({
        capitalUsd: 1234.56,
        riscoPorOperacaoPct: 2.5,
        alavancagemMaxima: 5,
      });
      expect(d.atualizadoEm.getTime()).toBeGreaterThanOrEqual(antes.atualizadoEm.getTime());
      const d2 = await atualizarDefinicoes(db, {
        alavancagemMaxima: 10,
        intervaloRecolhaSegundos: 15,
        limiteDiarioChamadasIa: 0,
        limiteDiarioTokensIa: 1000,
      });
      expect(d2).toMatchObject({ capitalUsd: 1234.56, alavancagemMaxima: 10 });
      expect(await atualizarDefinicoes(db, {})).toEqual(d2);
    });

    it.each([
      [{ intervaloRecolhaSegundos: 14 }, 'settings_poll_interval_min'],
      [{ alavancagemMaxima: 0 }, 'settings_max_leverage_range'],
      [{ capitalUsd: -1 }, 'settings_capital_non_negative'],
    ])('rejeita %o', async (alteracao, restricao) => {
      const erro = await atualizarDefinicoes(db, alteracao).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ErroRestricaoViolada);
      expect((erro as ErroRestricaoViolada).restricao).toBe(restricao);
    });
  });
});
