import {
  adicionarCarteiraRespostaSchema,
  agregadosAtivoRespostaSchema,
  ativoDetalheSchema,
  ativoResumoSchema,
  carteiraDtoSchema,
  contagemNaoLidosSchema,
  definicoesDtoSchema,
  eventoLidoRespostaSchema,
  eventosLidosRespostaSchema,
  exportacaoSchema,
  importacaoRespostaSchema,
  listaAtivosSchema,
  listaCarteirasSchema,
  paginaEventosSchema,
  type AdicionarCarteiraPedido,
  type AlterarCarteiraPedido,
  type AlterarDefinicoesPedido,
  type Exportacao,
  type TipoEventoDto,
} from '@hyper-radar/shared';
import { pedirApi } from './cliente';

/** Filtros do histórico de eventos (query de `GET /api/eventos`). */
export interface FiltrosEventos {
  ativo?: number | undefined;
  carteira?: number | undefined;
  tipos?: TipoEventoDto[] | undefined;
  naoLidos?: boolean | undefined;
  /** ISO 8601. */
  desde?: string | undefined;
  ate?: string | undefined;
  limite?: number | undefined;
}

/** Funções tipadas por rota da API (todas validam a resposta com os schemas partilhados). */
export const api = {
  listarAtivos: () => pedirApi('/ativos', listaAtivosSchema),
  obterAtivo: (id: number) => pedirApi(`/ativos/${id}`, ativoDetalheSchema),
  criarAtivo: (ticker: string) =>
    pedirApi('/ativos', ativoResumoSchema, { metodo: 'POST', corpo: { ticker } }),
  iniciarAnalise: (id: number) =>
    pedirApi(`/ativos/${id}/analise/iniciar`, ativoResumoSchema, { metodo: 'POST' }),
  pararAnalise: (id: number) =>
    pedirApi(`/ativos/${id}/analise/parar`, ativoResumoSchema, { metodo: 'POST' }),
  obterAgregados: (id: number) => pedirApi(`/ativos/${id}/agregados`, agregadosAtivoRespostaSchema),

  adicionarCarteira: (ativoId: number, pedido: AdicionarCarteiraPedido) =>
    pedirApi(`/ativos/${ativoId}/carteiras`, adicionarCarteiraRespostaSchema, {
      metodo: 'POST',
      corpo: pedido,
    }),
  removerCarteiraDoAtivo: (ativoId: number, carteiraId: number) =>
    pedirApi(`/ativos/${ativoId}/carteiras/${carteiraId}`, null, { metodo: 'DELETE' }),
  listarCarteiras: () => pedirApi('/carteiras', listaCarteirasSchema),
  alterarCarteira: (id: number, pedido: AlterarCarteiraPedido) =>
    pedirApi(`/carteiras/${id}`, carteiraDtoSchema, { metodo: 'PATCH', corpo: pedido }),
  apagarCarteira: (id: number) => pedirApi(`/carteiras/${id}`, null, { metodo: 'DELETE' }),

  listarEventos: (filtros: FiltrosEventos, cursor?: number | null) =>
    pedirApi('/eventos', paginaEventosSchema, {
      query: {
        ativo: filtros.ativo,
        carteira: filtros.carteira,
        tipos: filtros.tipos?.length ? filtros.tipos.join(',') : undefined,
        naoLidos: filtros.naoLidos ? true : undefined,
        desde: filtros.desde,
        ate: filtros.ate,
        limite: filtros.limite,
        cursor: cursor ?? undefined,
      },
    }),
  contarNaoLidos: () => pedirApi('/eventos/nao-lidos/contagem', contagemNaoLidosSchema),
  marcarEventoLido: (id: number) =>
    pedirApi(`/eventos/${id}/lido`, eventoLidoRespostaSchema, { metodo: 'POST' }),
  marcarEventosDoAtivoLidos: (ativoId: number) =>
    pedirApi(`/ativos/${ativoId}/eventos/lidos`, eventosLidosRespostaSchema, { metodo: 'POST' }),

  obterDefinicoes: () => pedirApi('/definicoes', definicoesDtoSchema),
  alterarDefinicoes: (pedido: AlterarDefinicoesPedido) =>
    pedirApi('/definicoes', definicoesDtoSchema, { metodo: 'PATCH', corpo: pedido }),

  exportar: () => pedirApi('/exportacao', exportacaoSchema),
  importar: (dados: Exportacao) =>
    pedirApi('/importacao', importacaoRespostaSchema, { metodo: 'POST', corpo: dados }),
};

/** Chaves das queries (prefixos usados nas invalidações). */
export const chaves = {
  ativos: ['ativos'] as const,
  ativo: (id: number) => ['ativo', id] as const,
  agregados: (id: number) => ['agregados', id] as const,
  carteiras: ['carteiras'] as const,
  eventos: ['eventos'] as const,
  eventosFiltrados: (f: FiltrosEventos) => ['eventos', f] as const,
  naoLidos: ['nao-lidos'] as const,
  definicoes: ['definicoes'] as const,
};
