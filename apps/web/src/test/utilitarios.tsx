import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { estadoIaBase } from './dados';
import { Aplicacao } from '../App';
import { ProvedorToasts } from '../componentes/Toasts';

// ------------------------------------------------------------------ fetch falso

export interface RespostaFalsa {
  estado?: number;
  corpo?: unknown;
  /** Corpo em texto cru (ex.: JSON inválido). */
  texto?: string;
}

export interface RotaFalsa {
  metodo?: string;
  /** Caminho sem query (ex.: `/api/ativos`) ou expressão regular sobre o URL completo. */
  caminho: string | RegExp;
  resposta: RespostaFalsa | ((url: URL, init: RequestInit | undefined) => RespostaFalsa);
}

export interface Chamada {
  metodo: string;
  url: URL;
  corpo: unknown;
}

/** Substitui `fetch` por um servidor falso; devolve as chamadas feitas. */
export function mockFetch(rotas: RotaFalsa[]): Chamada[] {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (entrada: string, init?: RequestInit) => {
      const url = new URL(entrada, 'http://127.0.0.1');
      const metodo = init?.method ?? 'GET';
      const corpo = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      chamadas.push({ metodo, url, corpo });
      // A última rota registada que corresponde ganha (permite substituir respostas).
      const rota = [...rotas]
        .reverse()
        .find(
          (r) =>
            (r.metodo ?? 'GET') === metodo &&
            (typeof r.caminho === 'string' ? r.caminho === url.pathname : r.caminho.test(url.href)),
        );
      if (!rota) {
        return new Response(
          JSON.stringify({
            erro: { codigo: 'NAO_ENCONTRADO', mensagem: `Sem rota: ${metodo} ${url.pathname}` },
          }),
          { status: 404 },
        );
      }
      const r = typeof rota.resposta === 'function' ? rota.resposta(url, init) : rota.resposta;
      const estado = r.estado ?? 200;
      const texto = r.texto ?? (r.corpo === undefined ? '' : JSON.stringify(r.corpo));
      return new Response(estado === 204 ? null : texto, { status: estado });
    }),
  );
  return chamadas;
}

export const erroApi = (estado: number, codigo: string, mensagem: string, detalhes?: unknown) => ({
  estado,
  corpo: { erro: detalhes === undefined ? { codigo, mensagem } : { codigo, mensagem, detalhes } },
});

export { EventSourceFalso } from './eventSourceFalso';

// ------------------------------------------------------------------ render

export function criarQueryClientTeste(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

/** Renderiza um componente com QueryClient, router em memória e toasts. */
export function renderizar(ui: ReactElement, { caminho = '/' }: { caminho?: string } = {}) {
  const qc = criarQueryClientTeste();
  const resultado = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[caminho]}>
        <ProvedorToasts>{ui}</ProvedorToasts>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...resultado, qc };
}

/** Renderiza a aplicação completa (layout, rotas, tempo real) num caminho. */
export function renderizarApp(caminho = '/') {
  const qc = criarQueryClientTeste();
  const resultado = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[caminho]}>
        <Aplicacao />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...resultado, qc };
}

/** Respostas por omissão das consultas globais (layout e listas), sem dados. */
export function rotasBase(): RotaFalsa[] {
  return [
    { caminho: '/api/ativos', resposta: { corpo: [] } },
    { caminho: '/api/carteiras', resposta: { corpo: [] } },
    { caminho: '/api/eventos', resposta: { corpo: { itens: [], proximoCursor: null } } },
    { caminho: '/api/eventos/nao-lidos/contagem', resposta: { corpo: { total: 0, porAtivo: [] } } },
    {
      caminho: '/api/definicoes',
      resposta: {
        corpo: {
          capitalUsd: 1000,
          alavancagemMaxima: 5,
          riscoPorOperacaoPct: 1,
          intervaloRecolhaSegundos: 60,
          limiteDiarioChamadasIa: 10,
          limiteDiarioTokensIa: 100000,
          atualizadoEm: '2026-11-17T12:00:00.000Z',
          modeloIa: 'gpt-6.1-sol',
        },
      },
    },
    { caminho: '/api/ia/estado', resposta: { corpo: estadoIaBase() } },
  ];
}
