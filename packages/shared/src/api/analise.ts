import { z } from 'zod';
import { dataIsoSchema } from './comum';

const lado = z.enum(['long', 'short']);

export const agregadoLadoSchema = z.object({
  carteiras: z.number().int(),
  /** Soma dos tamanhos absolutos (unidades do ativo). */
  tamanho: z.number(),
  notionalUsd: z.number(),
  entradaMedia: z.number().nullable(),
  alavancagemMedia: z.number().nullable(),
});

export const zonaLiquidacaoSchema = z.object({
  preco: z.number(),
  lado,
  notional: z.number(),
  /** Endereços das carteiras. */
  carteiras: z.array(z.string()),
  distanciaPct: z.number(),
  notionalAcumulado: z.number(),
});

export const agregadoEntidadeSchema = z.object({
  entidade: z.string(),
  carteiras: z.array(z.string()),
  longUsd: z.number(),
  shortUsd: z.number(),
  netUsd: z.number(),
  hedgeInterno: z.boolean(),
  notionalHedgeado: z.number(),
});

export const agregadoAtivoSchema = z.object({
  ativo: z.string(),
  /** Instante mais recente entre os snapshots; `null` sem snapshots. */
  instante: dataIsoSchema.nullable(),
  precoReferencia: z.number().nullable(),
  totalCarteiras: z.number().int(),
  carteirasSemPosicao: z.number().int(),
  long: agregadoLadoSchema,
  short: agregadoLadoSchema,
  netUsd: z.number(),
  alavancagemMedia: z.number().nullable(),
  zonasLiquidacao: z.array(zonaLiquidacaoSchema),
  entidades: z.array(agregadoEntidadeSchema),
  entidadesComHedge: z.number().int(),
});
export type AgregadoAtivoDto = z.infer<typeof agregadoAtivoSchema>;

const deltaSchema = z.object({ absoluta: z.number(), pct: z.number().nullable() });

export const variacaoAgregadoSchema = z.object({
  intervaloMs: z.number().nullable(),
  netUsd: deltaSchema,
  longUsd: deltaSchema,
  shortUsd: deltaSchema,
  carteirasLong: z.number().int(),
  carteirasShort: z.number().int(),
  entradaMediaLong: deltaSchema.nullable(),
  entradaMediaShort: deltaSchema.nullable(),
  alavancagemMedia: deltaSchema.nullable(),
  precoReferencia: deltaSchema.nullable(),
});
export type VariacaoAgregadoDto = z.infer<typeof variacaoAgregadoSchema>;

/** `GET /api/ativos/:id/agregados`. */
export const agregadosAtivoRespostaSchema = z.object({
  atual: agregadoAtivoSchema,
  variacao1h: variacaoAgregadoSchema.nullable(),
  variacao24h: variacaoAgregadoSchema.nullable(),
});
export type AgregadosAtivoResposta = z.infer<typeof agregadosAtivoRespostaSchema>;
