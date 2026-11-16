import { describe, expect, it } from 'vitest';
import {
  CARTEIRA_COM_POSICAO,
  carregarFixture,
  criarFetchFalso,
  descarregar,
  RelogioFalso,
  type RespostaFalsa,
} from './__testes__/auxiliares';
import { ClienteHyperliquid, type OpcoesCliente } from './cliente';
import {
  ErroCircuitoAberto,
  ErroHttp,
  ErroLimiteTaxa,
  ErroRede,
  ErroTempoEsgotado,
  type ErroHyperliquid,
} from './erros';
import { FilaPedidos } from './fila';
import { esperar, relogioSistema } from './relogio';
import type { CorpoInfo } from './transporte';

const MIDS = { corpo: carregarFixture('allMids-nativo') };

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
    ttlCacheMs: { allMids: 0, clearinghouseState: 0, perpDexs: 0, userFills: 0 },
    ...opcoes,
  });
  return { cliente, relogio, ...falso };
}

/** Lança o pedido e devolve uma promessa que nunca rejeita (para inspecionar com tempo falso). */
function capturar<T>(promessa: Promise<T>) {
  const estado: { valor?: T; erro?: unknown; terminado: boolean } = { terminado: false };
  promessa.then(
    (valor) => Object.assign(estado, { valor, terminado: true }),
    (erro: unknown) => Object.assign(estado, { erro, terminado: true }),
  );
  return estado;
}

describe('retry e backoff', () => {
  it('repete após 429 e 5xx com backoff exponencial e depois tem sucesso', async () => {
    const respostas: RespostaFalsa[] = [
      { estado: 429, texto: '' },
      { estado: 502, texto: 'x' },
      MIDS,
    ];
    const { cliente, relogio, chamadas } = preparar((_c, n) => respostas[n - 1]!, {
      atrasoBaseMs: 100,
    });
    const r = capturar(cliente.allMids());
    await descarregar();
    expect(chamadas).toHaveLength(1);
    await relogio.avancar(99);
    expect(chamadas).toHaveLength(1);
    await relogio.avancar(1); // 1.ª espera: 100 ms
    expect(chamadas).toHaveLength(2);
    await relogio.avancar(199);
    expect(chamadas).toHaveLength(2);
    await relogio.avancar(1); // 2.ª espera: 200 ms
    expect(r.terminado).toBe(true);
    expect(r.valor).toHaveProperty('BTC');
    expect(chamadas).toHaveLength(3);
  });

  it('aplica jitter entre 50 % e 100 % do atraso', async () => {
    const respostas: RespostaFalsa[] = [{ estado: 500, texto: '' }, MIDS];
    const { cliente, relogio, chamadas } = preparar((_c, n) => respostas[n - 1]!, {
      atrasoBaseMs: 1000,
      aleatorio: () => 0,
    });
    capturar(cliente.allMids());
    await relogio.avancar(499);
    expect(chamadas).toHaveLength(1);
    await relogio.avancar(1);
    expect(chamadas).toHaveLength(2);
  });

  it('respeita Retry-After em 429 (limitado ao atraso máximo)', async () => {
    const respostas: RespostaFalsa[] = [
      { estado: 429, texto: '', cabecalhos: { 'retry-after': '3' } },
      MIDS,
    ];
    const { cliente, relogio, chamadas } = preparar((_c, n) => respostas[n - 1]!, {
      atrasoBaseMs: 100,
    });
    capturar(cliente.allMids());
    await relogio.avancar(2999);
    expect(chamadas).toHaveLength(1);
    await relogio.avancar(1);
    expect(chamadas).toHaveLength(2);
  });

  it('desiste após o número máximo de tentativas com o último erro tipado', async () => {
    const { cliente, relogio, chamadas } = preparar(() => ({ estado: 429, texto: '' }), {
      maxTentativas: 3,
      atrasoBaseMs: 10,
      atrasoMaximoMs: 15,
    });
    const r = capturar(cliente.allMids());
    await relogio.avancar(1000);
    expect(chamadas).toHaveLength(3);
    expect(r.erro).toBeInstanceOf(ErroLimiteTaxa);
    expect((r.erro as ErroHyperliquid).message).toMatch(/Limite de pedidos/);
  });

  it('repete erros de rede', async () => {
    const respostas: RespostaFalsa[] = [new TypeError('fetch failed'), MIDS];
    const { cliente, relogio, chamadas } = preparar((_c, n) => respostas[n - 1]!);
    const r = capturar(cliente.allMids());
    await relogio.avancar(1000);
    expect(chamadas).toHaveLength(2);
    expect(r.valor).toBeDefined();
  });

  it('erro de rede persistente devolve ErroRede com a causa', async () => {
    const causa = new TypeError('fetch failed');
    const { cliente, relogio } = preparar(() => causa, { maxTentativas: 1 });
    const r = capturar(cliente.allMids());
    await relogio.avancar(0);
    expect(r.erro).toBeInstanceOf(ErroRede);
    expect((r.erro as Error).cause).toBe(causa);
  });

  it('falha ao ler o corpo é tratada como erro de rede', async () => {
    const relogio = new RelogioFalso();
    const resposta = { status: 200, ok: true, text: () => Promise.reject(new Error('reset')) };
    const cliente = new ClienteHyperliquid({
      fetch: (() => Promise.resolve(resposta)) as unknown as typeof fetch,
      relogio,
      maxTentativas: 1,
    });
    await expect(cliente.allMids()).rejects.toBeInstanceOf(ErroRede);
  });

  it('não repete 4xx de validação (422)', async () => {
    const { cliente, chamadas } = preparar(() => ({
      estado: 422,
      texto: 'Failed to deserialize the JSON body into the target type',
    }));
    const erro = await cliente.allMids().catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroHttp);
    expect((erro as ErroHttp).estado).toBe(422);
    expect((erro as ErroHttp).repetivel).toBe(false);
    expect((erro as Error).message).toMatch(/rejeitado pela Hyperliquid/);
    expect(chamadas).toHaveLength(1);
  });

  it('não repete HTTP 500 com corpo null (DEX inexistente)', async () => {
    const { cliente, chamadas } = preparar(() => ({ estado: 500, texto: 'null' }));
    await expect(cliente.allMids('naoexiste')).rejects.toThrow(/verifique o parâmetro dex/);
    expect(chamadas).toHaveLength(1);
  });

  it('não repete respostas malformadas', async () => {
    const { cliente, chamadas } = preparar(() => ({ corpo: { BTC: 'abc' } }));
    await expect(cliente.allMids()).rejects.toThrow(/não tem o formato esperado/);
    expect(chamadas).toHaveLength(1);
  });
});

describe('timeout', () => {
  it('aborta o pedido após timeoutMs e lança ErroTempoEsgotado', async () => {
    const { cliente, relogio } = preparar(() => 'pendurar', { timeoutMs: 5000, maxTentativas: 1 });
    const r = capturar(cliente.allMids());
    await relogio.avancar(4999);
    expect(r.terminado).toBe(false);
    await relogio.avancar(1);
    expect(r.erro).toBeInstanceOf(ErroTempoEsgotado);
    expect((r.erro as Error).message).toBe('A Hyperliquid não respondeu em 5000 ms.');
  });

  it('timeout é repetível e o temporizador é cancelado em caso de sucesso', async () => {
    const respostas: RespostaFalsa[] = ['pendurar', MIDS];
    const { cliente, relogio, chamadas } = preparar((_c, n) => respostas[n - 1]!, {
      timeoutMs: 100,
      atrasoBaseMs: 10,
    });
    const r = capturar(cliente.allMids());
    await relogio.avancar(200);
    expect(chamadas).toHaveLength(2);
    expect(r.valor).toBeDefined();
    expect(relogio.pendentes).toBe(0);
  });

  it('abortar durante a leitura do corpo conta como timeout', async () => {
    const relogio = new RelogioFalso();
    const fetchFalso = (_u: unknown, init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        ok: true,
        text: () =>
          new Promise((_, rejeitar) =>
            init?.signal?.addEventListener('abort', () => rejeitar(new Error('abortado'))),
          ),
      });
    const cliente = new ClienteHyperliquid({
      fetch: fetchFalso as unknown as typeof fetch,
      relogio,
      timeoutMs: 50,
      maxTentativas: 1,
    });
    const r = capturar(cliente.allMids());
    await relogio.avancar(50);
    expect(r.erro).toBeInstanceOf(ErroTempoEsgotado);
  });
});

describe('orçamento de peso e concorrência', () => {
  it('não ultrapassa o orçamento por minuto (pesos oficiais com margem)', async () => {
    // Orçamento 100 × 0,8 = 80; clearinghouseState pesa 2 → 40 pedidos por minuto.
    const { cliente, relogio, chamadas } = preparar(
      () => ({ corpo: carregarFixture('clearinghouseState-sem-posicoes') }),
      { pesoMaximoPorMinuto: 100, concorrencia: 100 },
    );
    const resultados = Array.from({ length: 50 }, (_, i) =>
      capturar(cliente.clearinghouseState('0x' + i.toString(16).padStart(40, '0'))),
    );
    await relogio.avancar(0);
    expect(chamadas).toHaveLength(40);
    expect(cliente.pesoUsado).toBe(80);
    await relogio.avancar(59_999);
    expect(chamadas).toHaveLength(40);
    await relogio.avancar(2);
    expect(chamadas).toHaveLength(50);
    expect(resultados.every((r) => r.terminado)).toBe(true);
  });

  it('acrescenta peso por cada 20 fills devolvidos', async () => {
    const fill = (carregarFixture('userFills') as unknown[])[0];
    const { cliente } = preparar(() => ({ corpo: Array.from({ length: 45 }, () => fill) }));
    await cliente.userFills(CARTEIRA_COM_POSICAO);
    expect(cliente.pesoUsado).toBe(20 + 2);
  });

  it('limita os pedidos em simultâneo', async () => {
    let ativos = 0;
    let maximo = 0;
    const { cliente, relogio } = preparar(
      async () => {
        ativos++;
        maximo = Math.max(maximo, ativos);
        await esperar(relogio, 10);
        ativos--;
        return { corpo: carregarFixture('clearinghouseState-sem-posicoes') };
      },
      { concorrencia: 2 },
    );
    const todos = Array.from({ length: 6 }, (_, i) =>
      capturar(cliente.clearinghouseState('0x' + String(i).repeat(40))),
    );
    await relogio.avancar(100);
    expect(maximo).toBe(2);
    expect(todos.every((t) => t.terminado)).toBe(true);
  });

  it('pedido com peso superior ao orçamento não fica bloqueado', async () => {
    const relogio = new RelogioFalso();
    const fila = new FilaPedidos({ concorrencia: 1, orcamentoPeso: 5, janelaMs: 1000, relogio });
    await expect(fila.executar(50, () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(fila.pesoUsado()).toBe(5);
    fila.acrescentarPeso(0);
    expect(fila.pesoUsado()).toBe(5);
  });

  it('erros síncronos da tarefa rejeitam a promessa e libertam a vaga', async () => {
    const fila = new FilaPedidos({
      concorrencia: 1,
      orcamentoPeso: 10,
      janelaMs: 1000,
      relogio: new RelogioFalso(),
    });
    await expect(
      fila.executar(1, () => {
        throw new Error('falhou');
      }),
    ).rejects.toThrow('falhou');
    await expect(fila.executar(1, () => Promise.resolve(2))).resolves.toBe(2);
    expect(fila.emEspera).toBe(0);
  });
});

describe('circuit breaker', () => {
  it('abre após N falhas seguidas, rejeita sem pedidos e passa a meio-aberto', async () => {
    let falhar = true;
    const { cliente, relogio, chamadas } = preparar(
      () => (falhar ? { estado: 503, texto: '' } : MIDS),
      { maxTentativas: 1, limiarFalhasCircuito: 3, intervaloMeioAbertoMs: 10_000 },
    );
    for (let i = 0; i < 3; i++) await expect(cliente.allMids()).rejects.toBeInstanceOf(ErroHttp);
    expect(cliente.estadoCircuito).toBe('aberto');

    const erro = await cliente.allMids().catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroCircuitoAberto);
    expect((erro as Error).message).toMatch(/nova tentativa dentro de 10 s/);
    expect(chamadas).toHaveLength(3);

    await relogio.avancar(10_000);
    expect(cliente.estadoCircuito).toBe('meio-aberto');
    falhar = false;
    await expect(cliente.allMids()).resolves.toHaveProperty('BTC');
    expect(cliente.estadoCircuito).toBe('fechado');
  });

  it('em meio-aberto só deixa passar um pedido de teste; se falhar reabre', async () => {
    let libertar: (r: RespostaFalsa) => void = () => {};
    let n = 0;
    const { cliente, relogio, chamadas } = preparar(
      () => {
        n++;
        if (n <= 2) return { estado: 500, texto: '' };
        return new Promise<RespostaFalsa>((r) => (libertar = r));
      },
      { maxTentativas: 1, limiarFalhasCircuito: 2, intervaloMeioAbertoMs: 1000 },
    );
    await cliente.allMids().catch(() => {});
    await cliente.allMids().catch(() => {});
    await relogio.avancar(1000);

    const teste = capturar(cliente.allMids());
    await descarregar();
    await expect(cliente.perpDexs()).rejects.toBeInstanceOf(ErroCircuitoAberto);
    expect(chamadas).toHaveLength(3);

    libertar({ estado: 500, texto: '' });
    await descarregar();
    expect(teste.erro).toBeInstanceOf(ErroHttp);
    expect(cliente.estadoCircuito).toBe('aberto');
  });

  it('interrompe as tentativas quando o circuito abre a meio', async () => {
    const { cliente, relogio, chamadas } = preparar(() => ({ estado: 500, texto: '' }), {
      maxTentativas: 10,
      limiarFalhasCircuito: 2,
      atrasoBaseMs: 10,
    });
    const r = capturar(cliente.allMids());
    await relogio.avancar(1000);
    expect(chamadas).toHaveLength(2);
    expect(r.erro).toBeInstanceOf(ErroCircuitoAberto);
  });

  it('respostas 4xx não contam como falhas do servidor', async () => {
    const { cliente } = preparar(() => ({ estado: 422, texto: 'x' }), {
      limiarFalhasCircuito: 1,
    });
    await cliente.allMids().catch(() => {});
    await cliente.allMids().catch(() => {});
    expect(cliente.estadoCircuito).toBe('fechado');
  });
});

describe('cache e deduplicação', () => {
  it('reutiliza a resposta dentro do TTL e volta a pedir depois', async () => {
    const { cliente, relogio, chamadas } = preparar(() => MIDS, { ttlCacheMs: { allMids: 2000 } });
    await cliente.allMids();
    await relogio.avancar(1999);
    await cliente.allMids();
    expect(chamadas).toHaveLength(1);
    await relogio.avancar(1);
    await cliente.allMids();
    expect(chamadas).toHaveLength(2);
  });

  it('a cache distingue o parâmetro dex e pode ser limpa', async () => {
    const { cliente, chamadas } = preparar(() => MIDS, { ttlCacheMs: { allMids: 60_000 } });
    await cliente.allMids();
    await cliente.allMids('xyz');
    await cliente.allMids();
    expect(chamadas).toHaveLength(2);
    cliente.limparCache();
    await cliente.allMids();
    expect(chamadas).toHaveLength(3);
  });

  it('deduplica pedidos idênticos em curso (mesmo com TTL 0)', async () => {
    let libertar: (r: RespostaFalsa) => void = () => {};
    const { cliente, chamadas } = preparar(() => new Promise<RespostaFalsa>((r) => (libertar = r)));
    const a = cliente.allMids();
    const b = cliente.allMids();
    await descarregar();
    expect(chamadas).toHaveLength(1);
    libertar(MIDS);
    expect(await a).toBe(await b);
    void cliente.allMids().catch(() => {});
    await descarregar();
    expect(chamadas).toHaveLength(2);
  });

  it('erros não ficam em cache', async () => {
    const respostas: RespostaFalsa[] = [{ estado: 422, texto: '' }, MIDS];
    const { cliente, chamadas } = preparar((_c, n) => respostas[n - 1]!, {
      ttlCacheMs: { allMids: 60_000 },
    });
    await expect(cliente.allMids()).rejects.toBeInstanceOf(ErroHttp);
    await expect(cliente.allMids()).resolves.toHaveProperty('BTC');
    expect(chamadas).toHaveLength(2);
  });
});

describe('configuração', () => {
  it('usa a URL base configurada (sem barra final duplicada)', async () => {
    const { cliente, urls } = preparar(() => MIDS, { urlBase: 'http://localhost:9999/' });
    await cliente.allMids();
    expect(urls).toEqual(['http://localhost:9999/info']);
  });

  it('relogioSistema agenda e cancela temporizadores reais', async () => {
    const inicio = relogioSistema.agora();
    await esperar(relogioSistema, 5);
    expect(relogioSistema.agora()).toBeGreaterThanOrEqual(inicio);
    let chamado = false;
    relogioSistema.agendar(() => (chamado = true), 1)();
    await new Promise((r) => setTimeout(r, 10));
    expect(chamado).toBe(false);
  });

  it('sem opções usa o fetch global', () => {
    expect(() => new ClienteHyperliquid()).not.toThrow();
  });
});
