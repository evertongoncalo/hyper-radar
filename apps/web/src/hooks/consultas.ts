import type {
  AdicionarCarteiraPedido,
  AlterarCarteiraPedido,
  AlterarDefinicoesPedido,
  AtivoResumo,
  Exportacao,
  RespostaSugestao,
} from '@hyper-radar/shared';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api, chaves, type FiltrosEventos } from '../api/recursos';

// ---------------------------------------------------------------- consultas

export function useAtivos() {
  return useQuery({ queryKey: chaves.ativos, queryFn: api.listarAtivos });
}

export function useAtivo(id: number) {
  return useQuery({ queryKey: chaves.ativo(id), queryFn: () => api.obterAtivo(id) });
}

export function useAgregados(id: number) {
  return useQuery({ queryKey: chaves.agregados(id), queryFn: () => api.obterAgregados(id) });
}

export function useCarteiras() {
  return useQuery({ queryKey: chaves.carteiras, queryFn: api.listarCarteiras });
}

export function useContagemNaoLidos() {
  return useQuery({ queryKey: chaves.naoLidos, queryFn: api.contarNaoLidos });
}

export function useDefinicoes() {
  return useQuery({ queryKey: chaves.definicoes, queryFn: api.obterDefinicoes });
}

/** Eventos com paginação por cursor ("carregar mais"). */
export function useEventos(filtros: FiltrosEventos) {
  return useInfiniteQuery({
    queryKey: chaves.eventosFiltrados(filtros),
    queryFn: ({ pageParam }) => api.listarEventos(filtros, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (ultima) => ultima.proximoCursor,
  });
}

/** Resultado de um cálculo de sugestão, com o instante (cliente) em que foi pedido. */
export interface CalculoSugestao {
  resposta: RespostaSugestao;
  /** `undefined` = todas as carteiras com posição. */
  carteira: number | undefined;
  calculadoEm: number;
}

/**
 * Sugestão proporcional só a pedido: é uma mutação (e não uma query) para nunca ser recalculada
 * sozinha por invalidações, foco da janela ou religação do SSE.
 */
export function useCalcularSugestao(ativoId: number) {
  return useMutation({
    mutationFn: async (carteira?: number): Promise<CalculoSugestao> => {
      const resposta = await api.obterSugestao(ativoId, carteira);
      return { resposta, carteira, calculadoEm: Date.now() };
    },
  });
}

// ---------------------------------------------------------------- invalidações

/** Tudo o que depende do estado/contagens de um ativo. */
function invalidarAtivo(qc: QueryClient, id: number) {
  void qc.invalidateQueries({ queryKey: chaves.ativos });
  void qc.invalidateQueries({ queryKey: chaves.ativo(id) });
  void qc.invalidateQueries({ queryKey: chaves.agregados(id) });
}

/** Atualiza o item da lista de ativos com o resumo devolvido pela API. */
function substituirNaLista(qc: QueryClient, resumo: AtivoResumo) {
  qc.setQueryData<AtivoResumo[]>(chaves.ativos, (lista) =>
    lista?.map((a) => (a.id === resumo.id ? resumo : a)),
  );
}

function invalidarEventos(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: chaves.eventos });
  void qc.invalidateQueries({ queryKey: chaves.naoLidos });
  void qc.invalidateQueries({ queryKey: chaves.ativos });
}

// ---------------------------------------------------------------- mutações

export function useCriarAtivo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ticker: string) => api.criarAtivo(ticker),
    onSuccess: () => qc.invalidateQueries({ queryKey: chaves.ativos }),
  });
}

/** Iniciar ou parar a análise de um ativo. */
export function useAlternarAnalise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, acao }: { id: number; acao: 'iniciar' | 'parar' }) =>
      acao === 'iniciar' ? api.iniciarAnalise(id) : api.pararAnalise(id),
    onSuccess: (resumo) => {
      substituirNaLista(qc, resumo);
      invalidarAtivo(qc, resumo.id);
    },
  });
}

export function useAdicionarCarteira(ativoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pedido: AdicionarCarteiraPedido) => api.adicionarCarteira(ativoId, pedido),
    onSuccess: () => {
      invalidarAtivo(qc, ativoId);
      void qc.invalidateQueries({ queryKey: chaves.carteiras });
    },
  });
}

export function useRemoverCarteiraDoAtivo(ativoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (carteiraId: number) => api.removerCarteiraDoAtivo(ativoId, carteiraId),
    onSuccess: () => {
      invalidarAtivo(qc, ativoId);
      void qc.invalidateQueries({ queryKey: chaves.carteiras });
    },
  });
}

export function useAlterarCarteira() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pedido }: { id: number; pedido: AlterarCarteiraPedido }) =>
      api.alterarCarteira(id, pedido),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chaves.carteiras });
      // Alias/entidade aparecem no detalhe dos ativos, nos agregados e no feed.
      void qc.invalidateQueries({ queryKey: ['ativo'] });
      void qc.invalidateQueries({ queryKey: ['agregados'] });
      void qc.invalidateQueries({ queryKey: chaves.eventos });
    },
  });
}

export function useApagarCarteira() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.apagarCarteira(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chaves.carteiras });
      void qc.invalidateQueries({ queryKey: ['ativo'] });
      void qc.invalidateQueries({ queryKey: ['agregados'] });
      invalidarEventos(qc);
    },
  });
}

export function useMarcarEventoLido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number; assetId: number }) => api.marcarEventoLido(id),
    onSuccess: (_r, { assetId }) => {
      invalidarEventos(qc);
      void qc.invalidateQueries({ queryKey: chaves.ativo(assetId) });
    },
  });
}

export function useMarcarEventosDoAtivoLidos(ativoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.marcarEventosDoAtivoLidos(ativoId),
    onSuccess: () => {
      invalidarEventos(qc);
      void qc.invalidateQueries({ queryKey: chaves.ativo(ativoId) });
    },
  });
}

export function useAlterarDefinicoes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pedido: AlterarDefinicoesPedido) => api.alterarDefinicoes(pedido),
    onSuccess: (d) => qc.setQueryData(chaves.definicoes, d),
  });
}

export function useImportar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dados: Exportacao) => api.importar(dados),
    // A importação pode tocar em ativos, carteiras, associações e definições.
    onSuccess: () => qc.invalidateQueries(),
  });
}
