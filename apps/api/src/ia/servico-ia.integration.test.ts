import { AVISO_IA_NAO_ACONSELHAMENTO, type MercadoAtivo } from '@hyper-radar/shared';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgregadosAtivo } from '../analise';
import { adiada, RelogioFalso } from '../analise/__testes__/auxiliares';
import { aiReports } from '../db/schema';
import { calcularAgregados } from '../motor';
import {
  atualizarDefinicoes,
  criarAtivo,
  ErroNaoEncontrado,
  gravarRelatorioIa,
  listarRelatoriosIa,
  obterRelatorioIa,
} from '../repositorios';
import { criarAmbiente, disponivel } from '../repositorios/__testes__/ambiente';
import { GeradorFalso, relatorioValido } from './__testes__/auxiliares';
import type { RespostaGeracao } from './cliente-openai';
import { ErroIa } from './erros';
import { ServicoIa, type FonteContextoMercado } from './servico-ia';

const T = Date.UTC(2026, 6, 10, 12, 0, 0);
const HORA = 3_600_000;

const mercadoBtc = (markPx = 100): MercadoAtivo => ({
  coin: 'BTC',
  dex: null,
  szDecimals: 5,
  maxLeverage: 40,
  onlyIsolated: false,
  isDelisted: false,
  markPx,
  midPx: markPx,
  oraclePx: markPx,
  funding: 0.00001,
  premium: null,
  openInterest: 1_000,
  prevDayPx: 99,
  dayNtlVlm: 1e9,
});

class MercadoFalso implements FonteContextoMercado {
  preco = 100;
  erro: Error | null = null;
  async metaAndAssetCtxs(): Promise<MercadoAtivo[]> {
    if (this.erro) throw this.erro;
    return [mercadoBtc(this.preco)];
  }
}

async function erroDe(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('devia ter falhado');
}

describe.skipIf(!disponivel)('ServicoIa (Postgres real, OpenAI falsa)', { timeout: 30_000 }, () => {
  const ambiente = criarAmbiente();
  const { db } = ambiente;
  const vazio: AgregadosAtivo = {
    atual: calcularAgregados('BTC', []),
    variacao1h: null,
    variacao24h: null,
  };
  const analise = { chamadas: 0, obterAgregados: async () => (analise.chamadas++, vazio) };
  let relogio: RelogioFalso;
  let gerador: GeradorFalso;
  let mercado: MercadoFalso;
  let btc: number;
  let eth: number;

  const servico = (extra: Partial<ConstructorParameters<typeof ServicoIa>[0]> = {}) =>
    new ServicoIa({ db, analise, gerador, mercado, relogio, modelo: 'gpt-6.1-sol', ...extra });

  beforeAll(async () => {
    await ambiente.preparar();
    btc = (await criarAtivo(db, 'BTC')).id;
    eth = (await criarAtivo(db, 'ETH')).id;
  });
  afterAll(() => ambiente.limpar());
  beforeEach(async () => {
    await db.delete(aiReports);
    await atualizarDefinicoes(db, { limiteDiarioChamadasIa: 10, limiteDiarioTokensIa: 200_000 });
    relogio = new RelogioFalso(T);
    gerador = new GeradorFalso();
    mercado = new MercadoFalso();
  });

  it('sem chave: NAO_CONFIGURADA sem construir input nem chamar', async () => {
    gerador.configurado = false;
    const s = servico();
    expect(s.configurada).toBe(false);
    const e = await erroDe(s.analisar(btc));
    expect(e).toBeInstanceOf(ErroIa);
    expect((e as ErroIa).codigo).toBe('NAO_CONFIGURADA');
    expect(gerador.pedidos).toHaveLength(0);
  });

  it('primeira análise chama e grava; a segunda vem da cache (mesmo hash e modelo)', async () => {
    const s = servico();
    const r1 = await s.analisar(btc);
    expect(r1.daCache).toBe(false);
    expect(r1.custoEstimadoUsd).toBe(0.007);
    expect(r1.relatorio).toMatchObject({
      assetId: btc,
      modelo: 'gpt-6.1-sol',
      tokensEntrada: 1_000,
      tokensSaida: 500,
      custoEstimadoUsd: 0.007,
      criadoEm: new Date(T),
    });
    expect(r1.relatorio.hashInput).toMatch(/^[0-9a-f]{64}$/);
    expect(await obterRelatorioIa(db, r1.relatorio.id)).toEqual(r1.relatorio);

    const p = gerador.pedidos[0]!;
    expect(p.modelo).toBe('gpt-6.1-sol');
    expect(p.schema.nome).toBe('relatorio_ia_hyperradar');
    expect(p.entrada).toContain('"at":"BTC"');
    expect(p.entrada).toContain('"mark":100');

    const r2 = await s.analisar(btc);
    expect(r2).toEqual({ relatorio: r1.relatorio, daCache: true, custoEstimadoUsd: 0 });
    expect(gerador.pedidos).toHaveLength(1);
  });

  it('forcar ignora a cache; input diferente ou outro modelo também chamam', async () => {
    const s = servico();
    const r1 = await s.analisar(btc);
    const r2 = await s.analisar(btc, { forcar: true });
    expect(r2.daCache).toBe(false);
    expect(r2.relatorio.id).not.toBe(r1.relatorio.id);
    expect(r2.relatorio.hashInput).toBe(r1.relatorio.hashInput);

    mercado.preco = 105;
    const r3 = await s.analisar(btc);
    expect(r3.daCache).toBe(false);
    expect(r3.relatorio.hashInput).not.toBe(r1.relatorio.hashInput);

    const astra = await servico({ modelo: 'gpt-6-astra' }).analisar(btc);
    expect(astra).toMatchObject({ daCache: false, custoEstimadoUsd: 0.035 });
    expect(gerador.pedidos).toHaveLength(4);
    // A cache do modelo por omissão continua válida.
    expect((await s.analisar(btc)).daCache).toBe(true);
  });

  it('modelo sem preço conhecido: custo null gravado', async () => {
    const r = await servico({ modelo: 'modelo-futuro' }).analisar(btc);
    expect(r.custoEstimadoUsd).toBeNull();
    expect((await obterRelatorioIa(db, r.relatorio.id))?.custoEstimadoUsd).toBeNull();
    const e = await servico({ modelo: 'modelo-futuro' }).estado();
    expect(e.modeloComPreco).toBe(false);
  });

  it('acrescenta o aviso de não-aconselhamento quando o modelo o omite', async () => {
    gerador.resposta = async () => ({
      dados: relatorioValido({ avisos: ['Dados parciais.'] }),
      modelo: 'x',
      tokensEntrada: 1,
      tokensSaida: 1,
    });
    const r = await servico().analisar(btc);
    expect(r.relatorio.resposta['avisos']).toEqual([
      AVISO_IA_NAO_ACONSELHAMENTO,
      'Dados parciais.',
    ]);
  });

  it('resposta fora do schema: RESPOSTA_INVALIDA, nada gravado, tokens contam no uso do dia', async () => {
    gerador.resposta = async () => ({
      dados: { resumo: 'só isto' },
      modelo: 'x',
      tokensEntrada: 700,
      tokensSaida: 300,
    });
    const s = servico();
    const e = await erroDe(s.analisar(btc));
    expect((e as ErroIa).codigo).toBe('RESPOSTA_INVALIDA');
    expect((await listarRelatoriosIa(db, btc)).itens).toHaveLength(0);
    expect((await s.estado()).hoje).toMatchObject({ chamadas: 1, tokens: 1_000 });
  });

  it('erro da OpenAI com uso (recusa) conta; sem uso (timeout) não; o erro propaga', async () => {
    const s = servico();
    gerador.resposta = async () => {
      throw new ErroIa('RECUSA', 'recusado', { uso: { tokensEntrada: 50, tokensSaida: 5 } });
    };
    expect(((await erroDe(s.analisar(btc))) as ErroIa).codigo).toBe('RECUSA');
    gerador.resposta = async () => {
      throw new ErroIa('TIMEOUT', 'tempo');
    };
    expect(((await erroDe(s.analisar(btc))) as ErroIa).codigo).toBe('TIMEOUT');
    gerador.resposta = async () => {
      throw new Error('inesperado');
    };
    expect((await erroDe(s.analisar(btc))).message).toBe('inesperado');
    expect((await s.estado()).hoje).toMatchObject({ chamadas: 1, tokens: 55 });
  });

  it('limite diário de chamadas (0 = sem limite); a cache não conta', async () => {
    await atualizarDefinicoes(db, { limiteDiarioChamadasIa: 2 });
    const s = servico();
    await s.analisar(btc);
    await s.analisar(btc, { forcar: true });
    expect((await s.analisar(btc)).daCache).toBe(true);
    const e = (await erroDe(s.analisar(btc, { forcar: true }))) as ErroIa;
    expect(e.codigo).toBe('LIMITE_DIARIO');
    expect(e.message).toContain('Limite diário de 2 análises IA');
    expect(gerador.pedidos).toHaveLength(2);

    await atualizarDefinicoes(db, { limiteDiarioChamadasIa: 0, limiteDiarioTokensIa: 0 });
    await expect(s.analisar(btc, { forcar: true })).resolves.toMatchObject({ daCache: false });
  });

  it('limite diário de tokens: bloqueia quando o usado + estimativa excede', async () => {
    await atualizarDefinicoes(db, { limiteDiarioTokensIa: 2_000 });
    const s = servico();
    await s.analisar(btc); // 1500 tokens
    const e = (await erroDe(s.analisar(btc, { forcar: true }))) as ErroIa;
    expect(e.codigo).toBe('LIMITE_DIARIO');
    expect(e.message).toContain('tokens');
    expect(gerador.pedidos).toHaveLength(1);
  });

  it('o dia conta em Lisboa (verão: 23:00 UTC já é o dia seguinte)', async () => {
    await atualizarDefinicoes(db, { limiteDiarioChamadasIa: 1 });
    relogio = new RelogioFalso(Date.UTC(2026, 6, 10, 22, 59));
    const s = servico();
    await s.analisar(btc);
    expect(((await erroDe(s.analisar(btc, { forcar: true }))) as ErroIa).codigo).toBe(
      'LIMITE_DIARIO',
    );
    relogio.avancar(60_000); // 23:00 UTC = 00:00 em Lisboa
    const r = await s.analisar(btc, { forcar: true });
    expect(r.daCache).toBe(false);
    const e = await s.estado();
    expect(e.hoje).toMatchObject({ dia: '2026-07-11', chamadas: 1, tokens: 1_500 });
  });

  it('dia da mudança de hora (25 h): relatórios das 23:30 UTC do dia anterior contam', async () => {
    // 2026-10-25 em Lisboa vai de 2026-10-24T23:00Z a 2026-10-26T00:00Z.
    await gravarRelatorioIa(db, {
      assetId: eth,
      modelo: 'gpt-6.1-sol',
      hashInput: 'h1',
      resposta: relatorioValido(),
      tokensEntrada: 10,
      tokensSaida: 0,
      custoEstimadoUsd: 0.5,
      criadoEm: new Date(Date.UTC(2026, 9, 24, 23, 30)),
    });
    await gravarRelatorioIa(db, {
      assetId: eth,
      modelo: 'gpt-6.1-sol',
      hashInput: 'h2',
      resposta: relatorioValido(),
      tokensEntrada: 20,
      tokensSaida: 0,
      custoEstimadoUsd: 0.25,
      criadoEm: new Date(Date.UTC(2026, 9, 24, 22, 59)),
    });
    relogio = new RelogioFalso(Date.UTC(2026, 9, 25, 23, 59));
    const e = await servico().estado();
    expect(e.hoje).toEqual({
      dia: '2026-10-25',
      chamadas: 1,
      tokens: 10,
      custoEstimadoUsd: 0.5,
      limiteChamadas: 10,
      limiteTokens: 200_000,
    });
  });

  it('pedidos concorrentes do mesmo ativo partilham uma única chamada', async () => {
    const pendente = adiada<RespostaGeracao>();
    gerador.resposta = () => pendente.promessa;
    const s = servico();
    const a = s.analisar(btc, { forcar: true });
    const b = s.analisar(btc);
    await new Promise((r) => setTimeout(r, 50));
    pendente.resolver({ dados: relatorioValido(), modelo: 'x', tokensEntrada: 1, tokensSaida: 1 });
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toBe(ra);
    expect(gerador.pedidos).toHaveLength(1);
    // Terminado o pedido, um novo pedido volta a ser independente.
    expect((await s.analisar(btc)).daCache).toBe(true);
  });

  it('ativos diferentes em simultâneo: chamadas serializadas (limites exatos)', async () => {
    await atualizarDefinicoes(db, { limiteDiarioChamadasIa: 1 });
    const s = servico();
    const resultados = await Promise.allSettled([s.analisar(btc), s.analisar(eth)]);
    expect(resultados.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(gerador.pedidos).toHaveLength(1);
  });

  it('contexto de mercado indisponível ou sem fonte: input com mk nulo, análise continua', async () => {
    mercado.erro = new Error('HL em baixo');
    await servico().analisar(btc);
    expect(gerador.pedidos[0]!.entrada).toContain('"mk":null');
    await servico({ mercado: null }).analisar(eth);
    expect(gerador.pedidos[1]!.entrada).toContain('"mk":null');
    // ETH não está na lista de mercado devolvida.
    await servico().analisar(eth, { forcar: true });
    expect(gerador.pedidos[2]!.entrada).toContain('"mk":null');
  });

  it('ativo inexistente: ErroNaoEncontrado', async () => {
    expect(await erroDe(servico().analisar(999_999))).toBeInstanceOf(ErroNaoEncontrado);
  });

  it('estado: configuração, preços e uso de hoje vs limites', async () => {
    const s = servico();
    await s.analisar(btc);
    relogio.avancar(HORA);
    expect(await s.estado()).toEqual({
      configurada: true,
      modelo: 'gpt-6.1-sol',
      modeloComPreco: true,
      hoje: {
        dia: '2026-07-10',
        chamadas: 1,
        tokens: 1_500,
        custoEstimadoUsd: 0.007,
        limiteChamadas: 10,
        limiteTokens: 200_000,
      },
    });
    expect(s.precos().map((p) => p.modelo)).toContain('gpt-6.1-sol');
  });
});
