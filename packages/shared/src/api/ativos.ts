import { z } from 'zod';
import { dataIsoSchema } from './comum';

/** Estados de um ativo (secção 2): `idle` → `running` → `stopped`; `running` → `restarting`. */
export const ESTADOS_ATIVO = ['idle', 'running', 'stopped', 'restarting'] as const;
export const estadoAtivoSchema = z.enum(ESTADOS_ATIVO);
export type EstadoAtivoDto = z.infer<typeof estadoAtivoSchema>;

/** Ticker como a Hyperliquid o usa: `ATIVO` (nativo) ou `dex:ATIVO` (HIP-3). */
export const tickerSchema = z
  .string({ error: 'O ticker é obrigatório.' })
  .trim()
  .min(1, { error: 'O ticker é obrigatório.' })
  .max(64, { error: 'Ticker demasiado longo.' })
  .regex(/^[^\s:]+(:[^\s:]+)?$/, { error: 'Ticker inválido: use "ATIVO" ou "dex:ATIVO".' });

/** `POST /api/ativos`. */
export const criarAtivoPedidoSchema = z.strictObject({ ticker: tickerSchema });
export type CriarAtivoPedido = z.input<typeof criarAtivoPedidoSchema>;

/** Saúde da recolha de um ativo em análise (indicador "dados desatualizados"). */
export const saudeAnaliseSchema = z.object({
  runId: z.number().int(),
  cicloEmCurso: z.boolean(),
  /** Fim do último ciclo com sucesso. */
  ultimoCicloSucesso: dataIsoSchema.nullable(),
  ultimoErro: z.object({ mensagem: z.string(), instante: dataIsoSchema }).nullable(),
  /** Ids das carteiras cuja última leitura falhou. */
  carteirasDesatualizadas: z.array(z.number().int()),
});
export type SaudeAnaliseDto = z.infer<typeof saudeAnaliseSchema>;

/** Item de `GET /api/ativos` (e resposta de criar/iniciar/parar). */
export const ativoResumoSchema = z.object({
  id: z.number().int(),
  ticker: z.string(),
  /** DEX HIP-3, ou `null` para perps nativos. */
  dex: z.string().nullable(),
  estado: estadoAtivoSchema,
  criadoEm: dataIsoSchema,
  numeroCarteiras: z.number().int().nonnegative(),
  eventosNaoLidos: z.number().int().nonnegative(),
  /** `null` quando o ativo não está em análise neste processo. */
  saude: saudeAnaliseSchema.nullable(),
});
export type AtivoResumo = z.infer<typeof ativoResumoSchema>;

export const listaAtivosSchema = z.array(ativoResumoSchema);

export const posicaoDtoSchema = z.object({
  lado: z.enum(['long', 'short']),
  /** Tamanho absoluto, em unidades do ativo. */
  tamanho: z.number(),
  entryPx: z.number(),
  alavancagem: z.number(),
  tipoMargem: z.enum(['cross', 'isolated']),
  liquidationPx: z.number().nullable(),
  unrealizedPnl: z.number(),
  marginUsed: z.number(),
  notional: z.number(),
});
export type PosicaoDto = z.infer<typeof posicaoDtoSchema>;

export const ordemProtecaoDtoSchema = z.object({
  tipo: z.enum(['SL', 'TP']),
  triggerPx: z.number(),
  /** `null` = posição inteira. */
  tamanho: z.number().nullable(),
  reduceOnly: z.boolean(),
});
export type OrdemProtecaoDto = z.infer<typeof ordemProtecaoDtoSchema>;

/** Último snapshot conhecido de uma carteira no ativo. */
export const ultimoSnapshotDtoSchema = z.object({
  instante: dataIsoSchema,
  runId: z.number().int(),
  accountValue: z.number(),
  /**
   * `false` em conta unificada / margem de portfólio (o `accountValue` por DEX não representa o
   * saldo real); `null` quando não é conhecido.
   */
  accountValueRepresentativo: z.boolean().nullable(),
  precoMercado: z.number().nullable(),
  posicao: posicaoDtoSchema.nullable(),
  /** Só SL/TP colocados na exchange (stops geridos fora dela são invisíveis). */
  ordens: z.array(ordemProtecaoDtoSchema),
});
export type UltimoSnapshotDto = z.infer<typeof ultimoSnapshotDtoSchema>;

export const carteiraNoAtivoSchema = z.object({
  id: z.number().int(),
  endereco: z.string(),
  alias: z.string().nullable(),
  entidade: z.string().nullable(),
  /** A última leitura desta carteira falhou (dados possivelmente desatualizados). */
  desatualizada: z.boolean(),
  ultimoSnapshot: ultimoSnapshotDtoSchema.nullable(),
});
export type CarteiraNoAtivo = z.infer<typeof carteiraNoAtivoSchema>;

export const precoMercadoDtoSchema = z.object({
  valor: z.number(),
  instante: dataIsoSchema,
  /** `hyperliquid` = lido agora; `snapshot` = último preço gravado (API indisponível). */
  fonte: z.enum(['hyperliquid', 'snapshot']),
});
export type PrecoMercadoDto = z.infer<typeof precoMercadoDtoSchema>;

/** `GET /api/ativos/:id`. */
export const ativoDetalheSchema = ativoResumoSchema.extend({
  precoMercado: precoMercadoDtoSchema.nullable(),
  carteiras: z.array(carteiraNoAtivoSchema),
});
export type AtivoDetalhe = z.infer<typeof ativoDetalheSchema>;
