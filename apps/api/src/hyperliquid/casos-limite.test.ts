import { describe, expect, it } from 'vitest';
import {
  CARTEIRA_COM_POSICAO,
  carregarFixture,
  criarFetchFalso,
  descarregar,
  RelogioFalso,
  type RespostaFalsa,
} from './__testes__/auxiliares';
import { CacheCurta } from './cache';
import { Circuito } from './circuito';
import { ClienteHyperliquid, type OpcoesCliente } from './cliente';
import { ErroCircuitoAberto, ErroHttp, ErroRede } from './erros';
import { FilaPedidos } from './fila';
import type { CorpoInfo } from './transporte';

const MIDS = { corpo: carregarFixture('allMids-nativo') };
const SEM_POSICOES = { corpo: carregarFixture('clearinghouseState-sem-posicoes') };
const carteira = (i: number) => '0x' + i.toString(16).padStart(40, '0');

function preparar(
  responder: (corpo: CorpoInfo, n: number) => RespostaFalsa | Promise<RespostaFalsa>,
  opcoes: OpcoesCliente = {},
) {
  const relogio = new RelogioFalso();
  const falso = criarFetchFalso(responder);
  const cliente = new ClienteHyperliquid({
    fetch: falso.fetch,
    relogio,
    aleatorio: () => 1,
    ttlCacheMs: { allMids: 0, clearinghouseState: 0, userFills: 0, userFillsByTime: 0 },
    ...opcoes,
  });
  return { cliente, relogio, ...falso };
}

function capturar<T>(promessa: Promise<T>) {
  const estado: { valor?: T; erro?: unknown; terminado: boolean } = { terminado: false };
  promessa.then(
    (valor) => Object.assign(estado, { valor, terminado: true }),
    (erro: unknown) => Object.assign(estado, { erro, terminado: true }),
  );
  return estado;
}

describe('transporte: casos-limite de HTTP', () => {
  it('Retry-After em formato de data é ignorado (usa o backoff exponencial)', async () => {
    const respostas: RespostaFalsa[] = [
      { estado: 429, texto: '', cabecalhos: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
      MIDS,
    ];
    const { cliente, relogio, chamadas } = preparar((_c, n) => respostas[n - 1]!, {
      atrasoBaseMs: 100,
    });
    capturar(cliente.allMids());
    await relogio.avancar(100);
    expect(chamadas).toHaveLength(2);
  });

  it('Retry-After acima do atraso máximo é limitado ao máximo', async () => {
    const respostas: RespostaFalsa[] = [
      { estado: 429, texto: '', cabecalhos: { 'retry-after': '120' } },
      MIDS,
    ];
    const { cliente, relogio, chamadas } = preparar((_c, n) => respostas[n - 1]!, {
      atrasoBaseMs: 10,
      atrasoMaximoMs: 1000,
    });
    const r = capturar(cliente.allMids());
    await relogio.avancar(999);
    expect(chamadas).toHaveLength(1);
    await relogio.avancar(1);
    expect(chamadas).toHaveLength(2);
    expect(r.valor).toHaveProperty('BTC');
  });

  it('500 com corpo "null" (com espaços) não repete nem conta como falha do circuito', async () => {
    const { cliente, chamadas } = preparar(() => ({ estado: 500, texto: ' null\n' }), {
      limiarFalhasCircuito: 1,
    });
    const erro = await cliente.allMids('naoexiste').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroHttp);
    expect((erro as ErroHttp).estado).toBe(500);
    expect((erro as ErroHttp).repetivel).toBe(false);
    expect(chamadas).toHaveLength(1);
    expect(cliente.estadoCircuito).toBe('fechado');
  });

  it('422 em texto: a mensagem inclui o corpo truncado a 200 caracteres', async () => {
    const { cliente } = preparar(() => ({ estado: 422, texto: 'x'.repeat(500) }));
    const erro = (await cliente.allMids().catch((e: unknown) => e)) as Error;
    expect(erro.message).toContain('"allMids"');
    expect(erro.message).toContain('HTTP 422');
    expect(erro.message.endsWith('x'.repeat(200))).toBe(true);
    expect(erro.message).not.toContain('x'.repeat(201));
  });

  it('o temporizador de timeout é cancelado também quando o pedido falha', async () => {
    const { cliente, relogio } = preparar(() => ({ estado: 422, texto: '' }), { timeoutMs: 5000 });
    await cliente.allMids().catch(() => {});
    expect(relogio.pendentes).toBe(0);
  });

  it('exceção inesperada do transporte é convertida em ErroRede', async () => {
    // Resposta sem cabeçalhos: ler `Retry-After` lança TypeError fora dos erros tipados.
    const relogio = new RelogioFalso();
    const resposta = { status: 429, ok: false, text: () => Promise.resolve('') };
    const cliente = new ClienteHyperliquid({
      fetch: (() => Promise.resolve(resposta)) as unknown as typeof fetch,
      relogio,
      maxTentativas: 1,
    });
    const erro = await cliente.allMids().catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroRede);
    expect((erro as Error).cause).toBeInstanceOf(TypeError);
  });
});

describe('fila: janela deslizante e peso', () => {
  it('cada registo expira ao fim da sua própria janela (não é uma janela fixa)', async () => {
    const relogio = new RelogioFalso();
    const fila = new FilaPedidos({
      concorrencia: 10,
      orcamentoPeso: 10,
      janelaMs: 60_000,
      relogio,
    });
    await fila.executar(6, () => Promise.resolve());
    await relogio.avancar(30_000);
    await fila.executar(4, () => Promise.resolve());
    expect(fila.pesoUsado()).toBe(10);

    const bloqueado = capturar(fila.executar(5, () => Promise.resolve('ok')));
    await descarregar();
    expect(bloqueado.terminado).toBe(false);
    expect(fila.emEspera).toBe(1);

    await relogio.avancar(30_000); // t = 60 000: sai o registo de peso 6, fica o de peso 4.
    expect(fila.pesoUsado()).toBe(4);
    await relogio.avancar(1);
    expect(bloqueado.valor).toBe('ok');
    expect(fila.pesoUsado()).toBe(9);

    await relogio.avancar(30_000); // sai o registo de peso 4.
    expect(fila.pesoUsado()).toBe(5);
    expect(relogio.pendentes).toBe(0);
  });

  it('peso extra acima do orçamento atrasa os pedidos seguintes até expirar', async () => {
    const relogio = new RelogioFalso();
    const fila = new FilaPedidos({ concorrencia: 1, orcamentoPeso: 10, janelaMs: 1000, relogio });
    await fila.executar(2, () => Promise.resolve());
    fila.acrescentarPeso(15);
    const r = capturar(fila.executar(1, () => Promise.resolve('ok')));
    await relogio.avancar(1000);
    expect(r.terminado).toBe(false);
    await relogio.avancar(1);
    expect(r.valor).toBe('ok');
  });

  it('userFillsByTime soma 1 de peso por cada 20 fills; menos de 20 não soma', async () => {
    const fill = (carregarFixture('userFills') as unknown[])[0];
    let quantidade = 19;
    const { cliente, relogio } = preparar(() => ({
      corpo: Array.from({ length: quantidade }, () => fill),
    }));
    await cliente.userFillsByTime(CARTEIRA_COM_POSICAO, 0);
    expect(cliente.pesoUsado).toBe(20);
    await relogio.avancar(60_000);
    quantidade = 2000;
    await cliente.userFillsByTime(CARTEIRA_COM_POSICAO, 0);
    expect(cliente.pesoUsado).toBe(20 + 100);
  });

  it('cada tentativa repetida consome peso', async () => {
    const respostas: RespostaFalsa[] = [{ estado: 502, texto: '' }, MIDS];
    const { cliente, relogio } = preparar((_c, n) => respostas[n - 1]!, { atrasoBaseMs: 10 });
    const r = capturar(cliente.allMids());
    await relogio.avancar(100);
    expect(r.valor).toBeDefined();
    expect(cliente.pesoUsado).toBe(4);
  });
});

describe('circuito', () => {
  it('pedidos em fila quando o circuito abre não chegam a ser enviados', async () => {
    let libertar: (r: RespostaFalsa) => void = () => {};
    const { cliente, chamadas } = preparar(
      (_c, n) => (n === 1 ? new Promise<RespostaFalsa>((r) => (libertar = r)) : SEM_POSICOES),
      { concorrencia: 1, maxTentativas: 1, limiarFalhasCircuito: 1 },
    );
    const primeiro = capturar(cliente.clearinghouseState(carteira(1)));
    const emFila = [2, 3].map((i) => capturar(cliente.clearinghouseState(carteira(i))));
    await descarregar();
    expect(chamadas).toHaveLength(1);

    libertar({ estado: 503, texto: '' });
    await descarregar();
    expect(primeiro.erro).toBeInstanceOf(ErroHttp);
    expect(cliente.estadoCircuito).toBe('aberto');
    expect(emFila.every((r) => r.erro instanceof ErroCircuitoAberto)).toBe(true);
    expect(chamadas).toHaveLength(1);
  });

  it('libertarTeste devolve a vaga do pedido de teste sem fechar o circuito', async () => {
    const relogio = new RelogioFalso();
    const circuito = new Circuito({ limiarFalhas: 1, intervaloMeioAbertoMs: 100, relogio });
    circuito.registarFalha();
    expect(circuito.estado).toBe('aberto');
    expect(() => circuito.autorizar()).toThrow(ErroCircuitoAberto);
    await relogio.avancar(100);
    expect(circuito.estado).toBe('meio-aberto');
    circuito.autorizar();
    expect(() => circuito.autorizar()).toThrow(ErroCircuitoAberto);
    circuito.libertarTeste();
    expect(circuito.estado).toBe('meio-aberto');
    expect(() => circuito.autorizar()).not.toThrow();
  });
});

describe('cache curta', () => {
  it('erro na produção não fica em cache nem em curso', async () => {
    const relogio = new RelogioFalso();
    const cache = new CacheCurta(relogio);
    let n = 0;
    const produzir = () => (++n === 1 ? Promise.reject(new Error('falhou')) : Promise.resolve(n));
    const [a, b] = [cache.obter('k', 1000, produzir), cache.obter('k', 1000, produzir)];
    await expect(a).rejects.toThrow('falhou');
    await expect(b).rejects.toThrow('falhou');
    await expect(cache.obter('k', 1000, produzir)).resolves.toBe(2);
    await expect(cache.obter('k', 1000, produzir)).resolves.toBe(2);
    expect(n).toBe(2);
  });

  it('o TTL conta a partir da resposta e expira exatamente no limite', async () => {
    const relogio = new RelogioFalso();
    const cache = new CacheCurta(relogio);
    let n = 0;
    const produzir = async () => {
      await new Promise<void>((r) => relogio.agendar(r, 500));
      return ++n;
    };
    const primeiro = cache.obter('k', 1000, produzir);
    await relogio.avancar(500);
    expect(await primeiro).toBe(1);
    await relogio.avancar(999);
    await expect(cache.obter('k', 1000, produzir)).resolves.toBe(1);
    await relogio.avancar(1);
    const segundo = cache.obter('k', 1000, produzir);
    await relogio.avancar(500);
    expect(await segundo).toBe(2);
  });
});

describe('normalização: casos-limite', () => {
  it('meta sem collateralToken devolve null', async () => {
    const meta = carregarFixture('meta-nativo') as Record<string, unknown>;
    delete meta.collateralToken;
    const { cliente } = preparar(() => ({ corpo: meta }));
    expect((await cliente.meta()).collateralToken).toBeNull();
  });

  it('metaAndAssetCtxs com elemento extra no tuplo continua a funcionar', async () => {
    const bruto = carregarFixture('metaAndAssetCtxs-nativo') as unknown[];
    const { cliente } = preparar(() => ({ corpo: [...bruto, { novo: true }] }));
    const mercados = await cliente.metaAndAssetCtxs();
    expect(mercados.find((m) => m.coin === 'BTC')?.markPx).toBeGreaterThan(0);
  });

  it('posição com szi "-0.0" é ignorada; szi negativo isolado é short com tamanho absoluto', async () => {
    const bruto = carregarFixture('clearinghouseState-xyz') as {
      assetPositions: { position: Record<string, unknown> }[];
    };
    const original = bruto.assetPositions[0]!;
    bruto.assetPositions = [
      { ...original, position: { ...original.position, szi: '-0.0' } },
      { ...original, position: { ...original.position, coin: 'xyz:TSLA', szi: '-12.5' } },
    ];
    const { cliente } = preparar(() => ({ corpo: bruto }));
    const estado = await cliente.clearinghouseState(carteira(9), 'xyz');
    expect(estado.posicoes).toHaveLength(1);
    expect(estado.posicoes[0]).toMatchObject({
      coin: 'xyz:TSLA',
      dex: 'xyz',
      lado: 'short',
      tamanho: 12.5,
      szi: -12.5,
      leverage: { tipo: 'isolated' },
    });
  });
});

describe('isolamento de rede', () => {
  it('o fetch global está bloqueado nos testes', async () => {
    const cliente = new ClienteHyperliquid({ maxTentativas: 1 });
    const erro = await cliente.allMids().catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroRede);
    expect(String((erro as Error).cause)).toMatch(/fetch real bloqueado/);
  });
});
