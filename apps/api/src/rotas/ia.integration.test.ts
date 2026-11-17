import {
  adicionarCarteiraRespostaSchema,
  ativoResumoSchema,
  AVISO_LEGAL,
  definicoesComIaDtoSchema,
  estadoIaSchema,
  paginaRelatoriosIaSchema,
  relatorioIaDtoSchema,
  respostaAnaliseIaSchema,
  respostaErroSchema,
} from '@hyper-radar/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServicoAnalise } from '../analise';
import { estadoCarteira, MINUTO } from '../analise/__testes__/auxiliares';
import { aiReports } from '../db/schema';
import { GeradorFalso, relatorioValido } from '../ia/__testes__/auxiliares';
import { ErroIa } from '../ia/erros';
import { ServicoIa } from '../ia/servico-ia';
import { atualizarDefinicoes } from '../repositorios';
import { criarAmbiente, disponivel, enderecoFicticio } from '../repositorios/__testes__/ambiente';
import { criarApp, esperarAte } from './__testes__/auxiliares';

describe.skipIf(!disponivel)(
  'rotas da Análise IA (Postgres real, OpenAI falsa)',
  { timeout: 30_000 },
  () => {
    const ambiente = criarAmbiente();
    const { db } = ambiente;
    const gerador = new GeradorFalso();
    let analiseRef: ServicoAnalise | null = null;
    const ia = new ServicoIa({
      db,
      analise: { obterAgregados: (id) => analiseRef!.obterAgregados(id) },
      gerador,
      modelo: 'gpt-6.1-sol',
    });
    const { app, analise, cliente, relogio } = criarApp(db, { ia });
    analiseRef = analise;
    // App sem serviço IA injetado: equivalente a arrancar sem OPENAI_API_KEY.
    const semChave = criarApp(db);

    beforeAll(() => ambiente.preparar());
    afterAll(async () => {
      await Promise.all([app.close(), semChave.app.close()]);
      await Promise.all([analise.encerrar(), semChave.analise.encerrar()]);
      await ambiente.limpar();
    });

    type Metodo = 'GET' | 'POST';
    const pedir = (method: Metodo, url: string, payload?: object, alvo = app) =>
      alvo.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    const erro = (r: { json: () => unknown }) => respostaErroSchema.parse(r.json()).erro;

    let assetId = 0;
    const endereco = enderecoFicticio(0xabc);

    it('prepara: ativo com uma carteira long em análise (um ciclo concluído)', async () => {
      const r = await pedir('POST', '/api/ativos', { ticker: 'BTC' });
      assetId = ativoResumoSchema.parse(r.json()).id;
      const c = await pedir('POST', `/api/ativos/${assetId}/carteiras`, { endereco });
      expect(adicionarCarteiraRespostaSchema.parse(c.json()).carteira.id).toBeGreaterThan(0);
      cliente.definir(
        endereco,
        estadoCarteira({ tamanho: 2, entryPx: 64_000, preco: 65_000, sl: 60_000 }),
      );
      expect((await pedir('POST', `/api/ativos/${assetId}/analise/iniciar`)).statusCode).toBe(200);
      relogio.avancar(MINUTO);
      await esperarAte(() => analise.obterSaude(assetId)?.ultimoCicloSucesso != null);
      await esperarAte(() => !analise.obterSaude(assetId)?.cicloEmCurso);
      // O polling nunca chama a IA.
      expect(gerador.pedidos).toHaveLength(0);
    });

    it('sem chave: estado "não configurada" e POST → 503 IA_NAO_CONFIGURADA', async () => {
      const e = estadoIaSchema.parse(
        (await pedir('GET', '/api/ia/estado', undefined, semChave.app)).json(),
      );
      expect(e).toMatchObject({ configurada: false, modelo: 'gpt-6.1-sol', modeloComPreco: true });
      const r = await pedir('POST', `/api/ativos/${assetId}/ia/analise`, {}, semChave.app);
      expect(r.statusCode).toBe(503);
      expect(erro(r)).toMatchObject({ codigo: 'IA_NAO_CONFIGURADA' });
      expect(erro(r).mensagem).toContain('OPENAI_API_KEY');
    });

    it('definições expõem o modelo IA (só de leitura)', async () => {
      const d = definicoesComIaDtoSchema.parse((await pedir('GET', '/api/definicoes')).json());
      expect(d.modeloIa).toBe('gpt-6.1-sol');
    });

    it('validação: ativo inexistente 404, corpo inválido 400, id inválido 400', async () => {
      expect((await pedir('POST', '/api/ativos/999999/ia/analise', {})).statusCode).toBe(404);
      const r = await pedir('POST', `/api/ativos/${assetId}/ia/analise`, { forcar: 'sim' });
      expect(r.statusCode).toBe(400);
      expect(erro(r).codigo).toBe('VALIDACAO');
      expect(
        (await pedir('POST', `/api/ativos/${assetId}/ia/analise`, { extra: 1 })).statusCode,
      ).toBe(400);
      expect((await pedir('POST', '/api/ativos/abc/ia/analise', {})).statusCode).toBe(400);
      expect(gerador.pedidos).toHaveLength(0);
    });

    let primeiroId = 0;

    it('POST: relatório + custo; input sem o endereço completo; repetição vem da cache', async () => {
      const r = await app.inject({ method: 'POST', url: `/api/ativos/${assetId}/ia/analise` });
      expect(r.statusCode).toBe(200);
      const corpo = respostaAnaliseIaSchema.parse(r.json());
      expect(corpo).toMatchObject({
        daCache: false,
        custoEstimadoUsd: 0.007,
        avisoLegal: AVISO_LEGAL,
      });
      expect(corpo.relatorio).toMatchObject({
        ativoId: assetId,
        modelo: 'gpt-6.1-sol',
        tokensEntrada: 1000,
      });
      expect(corpo.relatorio.relatorio).toEqual(relatorioValido());
      primeiroId = corpo.relatorio.id;

      const entrada = gerador.pedidos[0]!.entrada;
      expect(entrada).not.toContain(endereco);
      expect(entrada).toContain(`${endereco.slice(0, 6)}…${endereco.slice(-4)}`);
      expect(entrada).toContain('"l":"L"');
      expect(entrada).toContain('"sl":[60000]');

      const r2 = respostaAnaliseIaSchema.parse(
        (await pedir('POST', `/api/ativos/${assetId}/ia/analise`, {})).json(),
      );
      expect(r2).toMatchObject({ daCache: true, custoEstimadoUsd: 0 });
      expect(r2.relatorio.id).toBe(primeiroId);

      const r3 = respostaAnaliseIaSchema.parse(
        (await pedir('POST', `/api/ativos/${assetId}/ia/analise`, { forcar: true })).json(),
      );
      expect(r3.daCache).toBe(false);
      expect(gerador.pedidos).toHaveLength(2);
    });

    it('histórico paginado (resumo) e detalhe por id', async () => {
      const p1 = paginaRelatoriosIaSchema.parse(
        (await pedir('GET', `/api/ativos/${assetId}/ia/relatorios?limite=1`)).json(),
      );
      expect(p1.itens).toHaveLength(1);
      expect(p1.itens[0]).toMatchObject({ vies: 'alta', confianca: 0.6, ativoId: assetId });
      expect(p1.itens[0]).not.toHaveProperty('relatorio');
      expect(p1.proximoCursor).not.toBeNull();
      const p2 = paginaRelatoriosIaSchema.parse(
        (
          await pedir('GET', `/api/ativos/${assetId}/ia/relatorios?cursor=${p1.proximoCursor}`)
        ).json(),
      );
      expect(p2.itens.map((i) => i.id)).toEqual([primeiroId]);
      expect(p2.proximoCursor).toBeNull();

      expect((await pedir('GET', `/api/ativos/${assetId}/ia/relatorios?limite=0`)).statusCode).toBe(
        400,
      );
      expect((await pedir('GET', '/api/ativos/999999/ia/relatorios')).statusCode).toBe(404);

      const d = await pedir('GET', `/api/ia/relatorios/${primeiroId}`);
      expect(relatorioIaDtoSchema.parse(d.json()).id).toBe(primeiroId);
      const n = await pedir('GET', '/api/ia/relatorios/999999');
      expect(n.statusCode).toBe(404);
      expect(erro(n).codigo).toBe('NAO_ENCONTRADO');
    });

    it('relatório gravado com formato inválido → 500 sem detalhes internos', async () => {
      const [linha] = await db
        .insert(aiReports)
        .values({
          assetId,
          model: 'x',
          inputHash: 'y',
          response: { lixo: true },
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: null,
        })
        .returning();
      const r = await pedir('GET', `/api/ia/relatorios/${linha!.id}`);
      expect(r.statusCode).toBe(500);
      expect(erro(r).codigo).toBe('ERRO_INTERNO');
      await db.delete(aiReports).where(eq(aiReports.id, linha!.id));
    });

    it('estado: configurada, preços e uso de hoje', async () => {
      const e = estadoIaSchema.parse((await pedir('GET', '/api/ia/estado')).json());
      expect(e).toMatchObject({ configurada: true, modelo: 'gpt-6.1-sol', modeloComPreco: true });
      expect(e.precos.map((p) => p.modelo)).toEqual([
        'gpt-6.1-sol',
        'gpt-6.1-terra',
        'gpt-6-astra',
      ]);
      expect(e.hoje).toMatchObject({
        chamadas: 2,
        tokens: 3_000,
        custoEstimadoUsd: 0.014,
        limiteChamadas: 10,
      });
      expect(JSON.stringify(e)).not.toMatch(/sk-/);
    });

    it('erros mapeados: limite 429, recusa/inválida 502, indisponível 503, timeout 504', async () => {
      await atualizarDefinicoes(db, { limiteDiarioChamadasIa: 2 });
      const limite = await pedir('POST', `/api/ativos/${assetId}/ia/analise`, { forcar: true });
      expect(limite.statusCode).toBe(429);
      expect(erro(limite).codigo).toBe('LIMITE_IA_ATINGIDO');
      await atualizarDefinicoes(db, { limiteDiarioChamadasIa: 0 });

      const casos: [ErroIa, number, string][] = [
        [new ErroIa('RECUSA', 'r'), 502, 'IA_RECUSA'],
        [new ErroIa('RESPOSTA_INVALIDA', 'i'), 502, 'IA_RESPOSTA_INVALIDA'],
        [new ErroIa('AUTENTICACAO', 'a'), 502, 'IA_INDISPONIVEL'],
        [new ErroIa('LIMITE_OPENAI', 'l'), 503, 'IA_INDISPONIVEL'],
        [new ErroIa('INDISPONIVEL', 'd'), 503, 'IA_INDISPONIVEL'],
        [new ErroIa('TIMEOUT', 't'), 504, 'IA_INDISPONIVEL'],
      ];
      for (const [e, estado, codigo] of casos) {
        gerador.resposta = async () => {
          throw e;
        };
        const r = await pedir('POST', `/api/ativos/${assetId}/ia/analise`, { forcar: true });
        expect(r.statusCode, codigo).toBe(estado);
        expect(erro(r)).toEqual({ codigo, mensagem: e.message });
      }
    });

    it('nenhum ciclo de polling posterior invoca a IA', async () => {
      const antes = gerador.pedidos.length;
      for (let i = 0; i < 3; i++) {
        relogio.avancar(MINUTO);
        await esperarAte(() => !analise.obterSaude(assetId)?.cicloEmCurso);
      }
      expect(gerador.pedidos).toHaveLength(antes);
    });
  },
);
