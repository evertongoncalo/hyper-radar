import { listaAtivosSchema } from '@hyper-radar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ativoResumo } from '../test/dados';
import { erroApi, mockFetch } from '../test/utilitarios';
import { ErroApi, mensagemDeErro, pedirApi, urlApi } from './cliente';
import { api } from './recursos';

async function capturar(p: Promise<unknown>): Promise<ErroApi> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ErroApi) return e;
    throw e;
  }
  throw new Error('Era esperado um erro.');
}

describe('cliente HTTP', () => {
  it('devolve os dados validados em caso de sucesso', async () => {
    const chamadas = mockFetch([{ caminho: '/api/ativos', resposta: { corpo: [ativoResumo()] } }]);
    await expect(pedirApi('/ativos', listaAtivosSchema)).resolves.toEqual([ativoResumo()]);
    expect(chamadas[0]?.metodo).toBe('GET');
  });

  it('envia JSON no corpo das mutações', async () => {
    const chamadas = mockFetch([
      { metodo: 'POST', caminho: '/api/ativos', resposta: { estado: 201, corpo: ativoResumo() } },
    ]);
    await api.criarAtivo('BTC');
    expect(chamadas[0]?.corpo).toEqual({ ticker: 'BTC' });
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('aceita respostas 204 sem corpo', async () => {
    mockFetch([{ metodo: 'DELETE', caminho: '/api/carteiras/3', resposta: { estado: 204 } }]);
    await expect(api.apagarCarteira(3)).resolves.toBeUndefined();
  });

  it('converte o erro uniforme da API em ErroApi', async () => {
    mockFetch([
      {
        metodo: 'POST',
        caminho: '/api/ativos',
        resposta: erroApi(400, 'TICKER_INEXISTENTE', 'O ativo "btc" não existe. Quis dizer "BTC"?'),
      },
    ]);
    const e = await capturar(api.criarAtivo('btc'));
    expect(e.codigo).toBe('TICKER_INEXISTENTE');
    expect(e.estado).toBe(400);
    expect(e.message).toContain('Quis dizer "BTC"?');
    expect(mensagemDeErro(e)).toBe(e.message);
  });

  it('expõe os problemas de validação por campo', async () => {
    mockFetch([
      {
        metodo: 'PATCH',
        caminho: '/api/definicoes',
        resposta: erroApi(400, 'VALIDACAO', 'Pedido inválido', [
          { caminho: 'body.capitalUsd', mensagem: 'Capital: não pode ser negativo.' },
          { lixo: true },
        ]),
      },
    ]);
    const e = await capturar(api.alterarDefinicoes({ capitalUsd: -1 }));
    expect(e.problemas).toEqual([
      { caminho: 'body.capitalUsd', mensagem: 'Capital: não pode ser negativo.' },
    ]);
    expect(new ErroApi('REDE', 'x').problemas).toEqual([]);
  });

  it('erro HTTP com corpo fora do formato uniforme', async () => {
    mockFetch([{ caminho: '/api/ativos', resposta: { estado: 502, corpo: { qualquer: 1 } } }]);
    const e = await capturar(api.listarAtivos());
    expect(e.codigo).toBe('RESPOSTA_INVALIDA');
    expect(e.message).toContain('HTTP 502');
  });

  it('resposta com JSON inválido', async () => {
    mockFetch([{ caminho: '/api/ativos', resposta: { texto: '<html>' } }]);
    expect((await capturar(api.listarAtivos())).codigo).toBe('RESPOSTA_INVALIDA');
  });

  it('resposta que não cumpre o schema', async () => {
    mockFetch([{ caminho: '/api/ativos', resposta: { corpo: [{ id: 'x' }] } }]);
    const e = await capturar(api.listarAtivos());
    expect(e.codigo).toBe('RESPOSTA_INVALIDA');
    expect(e.message).toBe('Resposta do servidor em formato inesperado.');
  });

  it('falha de rede', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const e = await capturar(api.listarAtivos());
    expect(e.codigo).toBe('REDE');
    expect(e.estado).toBeNull();
  });

  it('pedidos cancelados propagam o AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('x', 'AbortError')));
    await expect(pedirApi('/ativos', listaAtivosSchema)).rejects.toBeInstanceOf(DOMException);
  });

  it('mensagem genérica para erros desconhecidos', () => {
    expect(mensagemDeErro('x')).toBe('Ocorreu um erro inesperado.');
  });

  it('urlApi omite parâmetros vazios', () => {
    expect(urlApi('/eventos', { a: 1, b: undefined, c: null, d: '', e: true })).toBe(
      '/api/eventos?a=1&e=true',
    );
    expect(urlApi('/ativos')).toBe('/api/ativos');
  });

  it('listarEventos constrói a query (tipos por vírgulas, cursor)', async () => {
    const chamadas = mockFetch([
      { caminho: '/api/eventos', resposta: { corpo: { itens: [], proximoCursor: null } } },
    ]);
    await api.listarEventos(
      { ativo: 1, carteira: 2, tipos: ['OPENED', 'CLOSED'], naoLidos: true, limite: 50 },
      99,
    );
    const q = chamadas[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      ativo: '1',
      carteira: '2',
      tipos: 'OPENED,CLOSED',
      naoLidos: 'true',
      limite: '50',
      cursor: '99',
    });
    await api.listarEventos({ tipos: [], naoLidos: false });
    expect(chamadas[1]!.url.search).toBe('');
  });
});
