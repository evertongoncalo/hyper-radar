import {
  adicionarCarteiraRespostaSchema,
  ativoResumoSchema,
  AVISO_LEGAL,
  respostaErroSchema,
  respostaSugestaoSchema,
} from '@hyper-radar/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estadoCarteira, MINUTO, T0 } from '../analise/__testes__/auxiliares';
import { ErroCircuitoAberto } from '../hyperliquid';
import { abrirRun, fecharRun, gravarSnapshot, type PosicaoGravada } from '../repositorios';
import { criarAmbiente, disponivel, enderecoFicticio } from '../repositorios/__testes__/ambiente';
import { criarApp, esperarAte } from './__testes__/auxiliares';

describe.skipIf(!disponivel)(
  'rota de sugestão proporcional (Postgres real, Hyperliquid falsa)',
  { timeout: 30_000 },
  () => {
    const ambiente = criarAmbiente();
    const { app, analise, cliente, mercado } = criarApp(ambiente.db);
    const { db } = ambiente;

    beforeAll(() => ambiente.preparar());
    afterAll(async () => {
      await app.close();
      await analise.encerrar();
      await ambiente.limpar();
    });

    type Metodo = 'GET' | 'POST' | 'PATCH';
    const pedir = (method: Metodo, url: string, payload?: object) =>
      app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    const erro = (r: { json: () => unknown }) => respostaErroSchema.parse(r.json()).erro;
    const sugestao = async (url: string) => {
      const r = await pedir('GET', url);
      expect(r.statusCode).toBe(200);
      return respostaSugestaoSchema.parse(r.json());
    };

    let assetId = 0;
    const ids: Record<'a' | 'b' | 'c' | 'd', number> = { a: 0, b: 0, c: 0, d: 0 };

    const posicao = (extra: Partial<PosicaoGravada> = {}): PosicaoGravada => ({
      lado: 'long',
      tamanho: 1,
      entryPx: 64_000,
      alavancagem: 10,
      tipoMargem: 'isolated',
      liquidationPx: 58_000,
      unrealizedPnl: 1_000,
      marginUsed: 6_500,
      notional: 65_000,
      ...extra,
    });

    it('prepara: ativo, carteiras (A e B da mesma entidade) e snapshots de um run já fechado', async () => {
      const r = await pedir('POST', '/api/ativos', { ticker: 'BTC' });
      assetId = ativoResumoSchema.parse(r.json()).id;
      const adicionar = async (n: number, entidade?: string) => {
        const resposta = await pedir('POST', `/api/ativos/${assetId}/carteiras`, {
          endereco: enderecoFicticio(n),
          ...(entidade ? { entidade } : {}),
        });
        expect(resposta.statusCode).toBe(201);
        return adicionarCarteiraRespostaSchema.parse(resposta.json()).carteira.id;
      };
      ids.a = await adicionar(1, 'Fundo');
      ids.b = await adicionar(2, 'Fundo');
      ids.c = await adicionar(3);
      ids.d = await adicionar(4);

      const run = await abrirRun(db, assetId);
      const base = { runId: run.id, accountValue: 100_000, marketPx: 64_500, ordens: [] };
      const recente = new Date(T0 - 5 * MINUTO);
      await gravarSnapshot(db, {
        ...base,
        walletId: ids.a,
        instante: recente,
        posicao: posicao(),
        ordens: [
          { tipo: 'SL', triggerPx: 60_800, tamanho: null, reduceOnly: true, oid: 1 },
          { tipo: 'TP', triggerPx: 70_400, tamanho: null, reduceOnly: true, oid: 2 },
        ],
      });
      await gravarSnapshot(db, {
        ...base,
        walletId: ids.b,
        instante: recente,
        posicao: posicao({ lado: 'short', notional: 30_000, tamanho: 0.5 }),
      });
      await gravarSnapshot(db, {
        ...base,
        walletId: ids.c,
        // Antigo face ao intervalo (15 min × 2).
        instante: new Date(T0 - 60 * MINUTO),
        accountValueRepresentativo: false,
        modoConta: 'unifiedAccount',
        posicao: posicao({ notional: 200_000 }),
      });
      await gravarSnapshot(db, { ...base, walletId: ids.d, instante: recente, posicao: null });
      await fecharRun(db, run.id);
    });

    it('capital 0 → 422 a pedir para configurar em Definições', async () => {
      const r = await pedir('GET', `/api/ativos/${assetId}/sugestao`);
      expect(r.statusCode).toBe(422);
      expect(erro(r).codigo).toBe('CAPITAL_NAO_CONFIGURADO');
      expect(erro(r).mensagem).toMatch(/Definições/);
    });

    it('sem carteira: só as que têm posição, por notional; análise inativa sinalizada', async () => {
      const p = await pedir('PATCH', '/api/definicoes', {
        capitalUsd: 1000,
        alavancagemMaxima: 10,
        riscoPorOperacaoPct: 2,
        intervaloRecolhaSegundos: 900,
      });
      expect(p.statusCode).toBe(200);

      mercado.chamadas.length = 0;
      const r = await sugestao(`/api/ativos/${assetId}/sugestao`);
      expect(mercado.chamadas).toEqual(expect.arrayContaining(['allMids:', 'meta:']));
      expect(r).toMatchObject({
        ativoId: assetId,
        ticker: 'BTC',
        analiseAtiva: false,
        precoMercado: { valor: 65_000, fonte: 'hyperliquid' },
        definicoes: { capitalUsd: 1000, alavancagemMaxima: 10, riscoPorOperacaoPct: 2 },
        avisoLegal: AVISO_LEGAL,
      });
      expect(r.sugestoes.map((s) => s.carteira.id)).toEqual([ids.c, ids.a, ids.b]);

      const [c, a, b] = r.sugestoes;
      // A: 6,5 % de margem × 10x = 650 USD → 0,01 BTC; SL −5 % → 61 750; perda 32,5 > 20
      // → 20/3250 = 0,00615 → 0,006 (szDecimals 3) = 390 USD.
      expect(a!.sugestao).toMatchObject({
        viavel: true,
        lado: 'long',
        fator: 0.01,
        posicao: {
          tamanho: 0.006,
          notionalUsd: 390,
          alavancagem: 10,
          szDecimals: 3,
          stopLoss: { preco: 61_750 },
          takeProfit: { preco: 71_500 },
          limitadoPeloRisco: true,
        },
      });
      const codigosA = a!.sugestao.avisos.map((x) => x.codigo);
      expect(codigosA[0]).toBe('ANALISE_INATIVA');
      expect(codigosA).toContain('PROVAVEL_HEDGE');
      expect(codigosA).not.toContain('DADOS_DESATUALIZADOS');
      expect(b!.sugestao.avisos.map((x) => x.codigo)).toContain('PROVAVEL_HEDGE');
      expect(c!.sugestao.avisos.map((x) => x.codigo)).toEqual(
        expect.arrayContaining(['DADOS_DESATUALIZADOS', 'ACCOUNT_VALUE_NAO_REPRESENTATIVO']),
      );
      expect(c!.sugestao.avisos.map((x) => x.codigo)).not.toContain('PROVAVEL_HEDGE');
    });

    it('?carteira= devolve só essa (mesmo sem posição); fora do ativo → 404; inválida → 400', async () => {
      const r = await sugestao(`/api/ativos/${assetId}/sugestao?carteira=${ids.d}`);
      expect(r.sugestoes).toHaveLength(1);
      expect(r.sugestoes[0]!.sugestao).toMatchObject({
        viavel: false,
        motivo: { codigo: 'SEM_POSICAO' },
      });

      const fora = await pedir('GET', `/api/ativos/${assetId}/sugestao?carteira=999999`);
      expect(fora.statusCode).toBe(404);
      expect(erro(fora).codigo).toBe('NAO_ENCONTRADO');
      const invalida = await pedir('GET', `/api/ativos/${assetId}/sugestao?carteira=abc`);
      expect(invalida.statusCode).toBe(400);
      const extra = await pedir('GET', `/api/ativos/${assetId}/sugestao?x=1`);
      expect(extra.statusCode).toBe(400);
    });

    it('ativo inexistente → 404', async () => {
      const r = await pedir('GET', '/api/ativos/999999/sugestao');
      expect(r.statusCode).toBe(404);
    });

    it('sem preço ao vivo: usa o do snapshot e avisa', async () => {
      mercado.mids = new Error('falha');
      const r = await sugestao(`/api/ativos/${assetId}/sugestao?carteira=${ids.a}`);
      mercado.mids = { BTC: 65_000 };
      expect(r.precoMercado).toMatchObject({ valor: 64_500, fonte: 'snapshot' });
      expect(r.sugestoes[0]!.sugestao.avisos.map((x) => x.codigo)).toContain('PRECO_DO_SNAPSHOT');
    });

    it('metadados indisponíveis → 503; ativo ausente do meta → inviável', async () => {
      mercado.erroMeta = new ErroCircuitoAberto(5_000);
      const r = await pedir('GET', `/api/ativos/${assetId}/sugestao`);
      mercado.erroMeta = null;
      expect(r.statusCode).toBe(503);

      const metas = mercado.metas.nativo!;
      mercado.metas.nativo = [];
      const s = await sugestao(`/api/ativos/${assetId}/sugestao?carteira=${ids.a}`);
      mercado.metas.nativo = metas;
      expect(s.sugestoes[0]!.sugestao.motivo?.codigo).toBe('METADADOS_INVALIDOS');
    });

    it('análise ativa: usa os snapshots do run atual', async () => {
      for (const n of [1, 2, 3, 4]) {
        cliente.definir(
          enderecoFicticio(n),
          estadoCarteira({
            tamanho: n === 4 ? 0 : 1,
            preco: 65_000,
            entryPx: 65_000,
            sl: 61_750,
          }),
        );
      }
      const r = await pedir('POST', `/api/ativos/${assetId}/analise/iniciar`);
      expect(r.statusCode).toBe(200);
      await esperarAte(() => analise.obterSaude(assetId)?.cicloEmCurso === false);
      const runId = analise.obterSaude(assetId)!.runId;

      const s = await sugestao(`/api/ativos/${assetId}/sugestao`);
      expect(s.analiseAtiva).toBe(true);
      expect(s.sugestoes).toHaveLength(3);
      for (const item of s.sugestoes) {
        expect(item.runId).toBe(runId);
        expect(item.sugestao.avisos.map((x) => x.codigo)).not.toContain('ANALISE_INATIVA');
      }
      await pedir('POST', `/api/ativos/${assetId}/analise/parar`);
    });
  },
);
