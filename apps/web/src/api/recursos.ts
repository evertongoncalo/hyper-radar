import {
  adicionarCarteiraRespostaSchema,
  agregadosAtivoRespostaSchema,
  ativoDetalheSchema,
  ativoResumoSchema,
  carteiraDtoSchema,
  contagemNaoLidosSchema,
  definicoesComIaDtoSchema,
  estadoIaSchema,
  eventoLidoRespostaSchema,
  eventosLidosRespostaSchema,
  exportacaoSchema,
  importacaoRespostaSchema,
  listaAtivosSchema,
  listaCarteirasSchema,
  paginaEventosSchema,
  paginaRelatoriosIaSchema,
  relatorioIaDtoSchema,
  respostaAnaliseIaSchema,
  respostaSugestaoSchema,
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
  /** Sugestão proporcional (cálculo local na API; nunca envia ordens). */
  obterSugestao: (id: number, carteira?: number) =>
    pedirApi(`/ativos/${id}/sugestao`, respostaSugestaoSchema, { query: { carteira } }),

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

  obterDefinicoes: () => pedirApi('/definicoes', definicoesComIaDtoSchema),
  alterarDefinicoes: (pedido: AlterarDefinicoesPedido) =>
    pedirApi('/definicoes', definicoesComIaDtoSchema, { metodo: 'PATCH', corpo: pedido }),

  /** Estado da Análise IA (chave configurada, modelo, preços, uso de hoje); não chama a OpenAI. */
  obterEstadoIa: () => pedirApi('/ia/estado', estadoIaSchema),
  /** Única rota que pode chamar a OpenAI: só por ação explícita do utilizador. */
  analisarComIa: (ativoId: number, forcar: boolean) =>
    pedirApi(`/ativos/${ativoId}/ia/analise`, respostaAnaliseIaSchema, {
      metodo: 'POST',
      corpo: forcar ? { forcar: true } : {},
    }),
  listarRelatoriosIa: (ativoId: number, cursor?: number | null) =>
    pedirApi(`/ativos/${ativoId}/ia/relatorios`, paginaRelatoriosIaSchema, {
      query: { cursor: cursor ?? undefined, limite: 10 },
    }),
  obterRelatorioIa: (id: number) => pedirApi(`/ia/relatorios/${id}`, relatorioIaDtoSchema),

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
  estadoIa: ['ia-estado'] as const,
  relatoriosIa: (ativoId: number) => ['ia-relatorios', ativoId] as const,
  relatorioIa: (id: number) => ['ia-relatorio', id] as const,
};
