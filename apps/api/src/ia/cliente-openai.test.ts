import { describe, expect, it } from 'vitest';
import { corpoResposta, fetchFalso, json, relatorioValido } from './__testes__/auxiliares';
import { ClienteOpenAi, type FuncaoFetch, type PedidoGeracao } from './cliente-openai';
import { ErroIa } from './erros';

const CHAVE = 'sk-teste-nao-real-123';
const pedido: PedidoGeracao = {
  modelo: 'gpt-6.1-sol',
  instrucoes: 'Instruções',
  entrada: '<dados>{}</dados>',
  schema: { nome: 'relatorio', schema: { type: 'object' } },
  maxTokensSaida: 1_000,
};

function cliente(
  fn: FuncaoFetch,
  extra: Partial<ConstructorParameters<typeof ClienteOpenAi>[0]> = {},
) {
  const esperas: number[] = [];
  const c = new ClienteOpenAi({
    chave: CHAVE,
    fetch: fn,
    esperar: async (ms) => {
      esperas.push(ms);
    },
    ...extra,
  });
  return { c, esperas };
}

async function erroDe(p: Promise<unknown>): Promise<ErroIa> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ErroIa);
    // A chave nunca aparece em mensagens de erro.
    expect(
      JSON.stringify({ m: (e as Error).message, c: String((e as Error).cause) }),
    ).not.toContain(CHAVE);
    return e as ErroIa;
  }
  throw new Error('devia ter falhado');
}

const ok = () => json(corpoResposta(JSON.stringify(relatorioValido())));

describe('ClienteOpenAi', () => {
  it('pedido à Responses API com Structured Outputs strict e resposta interpretada', async () => {
    const { fn, pedidos } = fetchFalso(ok());
    const { c } = cliente(fn, { urlBase: 'https://exemplo.invalido/v1/' });
    expect(c.configurado).toBe(true);
    const r = await c.gerar(pedido);
    expect(r).toEqual({
      dados: relatorioValido(),
      modelo: 'gpt-6.1-sol-2026-10-01',
      tokensEntrada: 1_000,
      tokensSaida: 500,
    });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.url).toBe('https://exemplo.invalido/v1/responses');
    expect(pedidos[0]!.init.method).toBe('POST');
    expect((pedidos[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${CHAVE}`,
    );
    const corpo = JSON.parse(pedidos[0]!.init.body as string);
    expect(corpo).toEqual({
      model: 'gpt-6.1-sol',
      instructions: 'Instruções',
      input: '<dados>{}</dados>',
      max_output_tokens: 1_000,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'relatorio',
          schema: { type: 'object' },
          strict: true,
        },
      },
    });
  });

  it('sem chave: NAO_CONFIGURADA sem qualquer pedido', async () => {
    const { fn, pedidos } = fetchFalso(ok());
    const c = new ClienteOpenAi({ chave: null, fetch: fn });
    expect(c.configurado).toBe(false);
    expect((await erroDe(c.gerar(pedido))).codigo).toBe('NAO_CONFIGURADA');
    expect(pedidos).toHaveLength(0);
  });

  it('sem fetch injetado usa o global (bloqueado nos testes)', async () => {
    const c = new ClienteOpenAi({ chave: CHAVE });
    expect((await erroDe(c.gerar(pedido))).codigo).toBe('INDISPONIVEL');
  });

  it('429 repete com backoff (Retry-After respeitado) e depois sucede', async () => {
    const { fn, pedidos } = fetchFalso(
      json({ error: { code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '3' }),
      json({}, 503),
      ok(),
    );
    const { c, esperas } = cliente(fn);
    await expect(c.gerar(pedido)).resolves.toMatchObject({ tokensEntrada: 1_000 });
    expect(pedidos).toHaveLength(3);
    expect(esperas).toEqual([3_000, 2_000]);
  });

  it('429 persistente: LIMITE_OPENAI após 1 + 2 tentativas; backoff limitado', async () => {
    const { fn, pedidos } = fetchFalso(json({}, 429, { 'retry-after': '999' }));
    const { c, esperas } = cliente(fn);
    const e = await erroDe(c.gerar(pedido));
    expect(e.codigo).toBe('LIMITE_OPENAI');
    expect(e.estadoHttp).toBe(429);
    expect(pedidos).toHaveLength(3);
    expect(esperas).toEqual([10_000, 10_000]);
  });

  it('429 por falta de quota não repete', async () => {
    const { fn, pedidos } = fetchFalso(json({ error: { code: 'insufficient_quota' } }, 429));
    const e = await erroDe(cliente(fn).c.gerar(pedido));
    expect(e.codigo).toBe('LIMITE_OPENAI');
    expect(e.message).toContain('quota');
    expect(pedidos).toHaveLength(1);
  });

  it('500 persistente: INDISPONIVEL após as tentativas; corpo não-JSON tolerado', async () => {
    const { fn, pedidos } = fetchFalso(new Response('erro', { status: 500 }));
    const { c, esperas } = cliente(fn, { tentativasExtra: 1 });
    expect((await erroDe(c.gerar(pedido))).codigo).toBe('INDISPONIVEL');
    expect(pedidos).toHaveLength(2);
    expect(esperas).toEqual([1_000]);
  });

  it('401: AUTENTICACAO sem ecoar a mensagem da OpenAI; 400 com código simples', async () => {
    const eco = {
      error: { message: `Incorrect API key provided: ${CHAVE}`, code: 'invalid_api_key' },
    };
    const e401 = await erroDe(cliente(fetchFalso(json(eco, 401)).fn).c.gerar(pedido));
    expect(e401.codigo).toBe('AUTENTICACAO');
    const e400 = await erroDe(
      cliente(fetchFalso(json({ error: { code: 'invalid_json_schema' } }, 400)).fn).c.gerar(pedido),
    );
    expect(e400.codigo).toBe('RESPOSTA_INVALIDA');
    expect(e400.message).toContain('invalid_json_schema');
    const estranho = await erroDe(
      cliente(fetchFalso(json({ error: { code: 'texto livre <x>' } }, 400)).fn).c.gerar(pedido),
    );
    expect(estranho.message).toBe('A OpenAI rejeitou o pedido (HTTP 400).');
  });

  it('recusa do modelo: RECUSA com o uso de tokens', async () => {
    const { fn } = fetchFalso(
      json(corpoResposta('', { recusa: 'Não posso ajudar.', uso: [10, 5] })),
    );
    const e = await erroDe(cliente(fn).c.gerar(pedido));
    expect(e.codigo).toBe('RECUSA');
    expect(e.uso).toEqual({ tokensEntrada: 10, tokensSaida: 5 });
  });

  it('resposta incompleta, JSON inválido, formato inesperado e corpo não-JSON', async () => {
    const casos: [Response, string][] = [
      [json(corpoResposta('{}', { status: 'incomplete' })), 'limite de tokens'],
      [json(corpoResposta('{}', { status: 'failed' })), 'failed'],
      [json(corpoResposta('{"resumo": ')), 'não é JSON'],
      [json({ output: 'x' }), 'formato inesperado'],
      [new Response('<html>', { status: 200 }), 'não é JSON'],
    ];
    for (const [resposta, trecho] of casos) {
      const e = await erroDe(cliente(fetchFalso(resposta).fn).c.gerar(pedido));
      expect(e.codigo).toBe('RESPOSTA_INVALIDA');
      expect(e.message).toContain(trecho);
    }
  });

  it('sem modelo nem status no corpo: aceita e devolve modelo vazio', async () => {
    const corpo = corpoResposta(JSON.stringify(relatorioValido())) as Record<string, unknown>;
    delete corpo['model'];
    delete corpo['status'];
    const r = await cliente(fetchFalso(json(corpo)).fn).c.gerar(pedido);
    expect(r.modelo).toBe('');
  });

  it('timeout: TIMEOUT sem novas tentativas (inclui leitura lenta do corpo)', async () => {
    const pendente: FuncaoFetch = (_url, init) =>
      new Promise((_r, rejeitar) => {
        init.signal?.addEventListener('abort', () => rejeitar(new Error('abortado')));
      });
    const { c } = cliente(pendente, { timeoutMs: 20 });
    const e = await erroDe(c.gerar(pedido));
    expect(e.codigo).toBe('TIMEOUT');

    let chamadas = 0;
    const corpoLento: FuncaoFetch = async (_url, init) => {
      chamadas++;
      const corpo = new ReadableStream({
        start(ctrl) {
          init.signal?.addEventListener('abort', () => ctrl.error(new Error('abortado')));
        },
      });
      return new Response(corpo, { status: 200 });
    };
    expect((await erroDe(cliente(corpoLento, { timeoutMs: 20 }).c.gerar(pedido))).codigo).toBe(
      'TIMEOUT',
    );
    expect(chamadas).toBe(1);
  });

  it('erro de rede: INDISPONIVEL sem repetir', async () => {
    const { fn, pedidos } = fetchFalso(new TypeError('fetch failed'));
    expect((await erroDe(cliente(fn).c.gerar(pedido))).codigo).toBe('INDISPONIVEL');
    expect(pedidos).toHaveLength(1);
  });
});
