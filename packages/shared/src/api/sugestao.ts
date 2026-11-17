import { z } from 'zod';
import { dataIsoSchema, idSchema } from './comum';
import { precoMercadoDtoSchema } from './ativos';

/*
 * Sugestão proporcional (secção 7.1): cálculo local e gratuito, nunca uma ordem.
 * Todos os números são finitos; o que não se consegue calcular vem a `null`.
 */

/** Aviso fixo (secção 1), incluído em todas as respostas. */
export const AVISO_LEGAL =
  'Informação para apoio à decisão. Não constitui aconselhamento financeiro.';

/** `GET /api/ativos/:id/sugestao?carteira=<id>` (sem `carteira`: todas as carteiras com posição). */
export const sugestaoQuerySchema = z.strictObject({ carteira: idSchema.optional() });
export type SugestaoQuery = z.input<typeof sugestaoQuerySchema>;

export const CODIGOS_AVISO_SUGESTAO = [
  'DADOS_DESATUALIZADOS',
  'ANALISE_INATIVA',
  'PRECO_DO_SNAPSHOT',
  'ACCOUNT_VALUE_NAO_REPRESENTATIVO',
  'SEM_POSICAO',
  'PROVAVEL_HEDGE',
  'SO_UMA_PERNA',
  'MARGEM_CRUZADA_BALEIA',
  'ALAVANCAGEM_LIMITADA',
  'MARGEM_LIMITADA_AO_CAPITAL',
  'SEM_STOP_LOSS',
  'SL_APOS_LIQUIDACAO',
  'SEM_TAKE_PROFIT',
  'SL_NAO_REAPLICAVEL',
  'TP_NAO_REAPLICAVEL',
  'TAMANHO_LIMITADO_PELO_RISCO',
  'RISCO_ACIMA_DO_MAXIMO',
  'ENTRADA_TARDIA',
  'PRECO_CONTRA_BALEIA',
  'LIQUIDACAO_ESTIMADA',
] as const;
export const codigoAvisoSugestaoSchema = z.enum(CODIGOS_AVISO_SUGESTAO);
export type CodigoAvisoSugestao = z.infer<typeof codigoAvisoSugestaoSchema>;

export const NIVEIS_AVISO = ['info', 'atencao', 'critico'] as const;
export const nivelAvisoSchema = z.enum(NIVEIS_AVISO);
export type NivelAviso = z.infer<typeof nivelAvisoSchema>;

export const avisoSugestaoSchema = z.object({
  codigo: codigoAvisoSugestaoSchema,
  nivel: nivelAvisoSchema,
  mensagem: z.string(),
});
export type AvisoSugestaoDto = z.infer<typeof avisoSugestaoSchema>;

/** Motivos pelos quais não há sugestão viável. */
export const MOTIVOS_INVIABILIDADE = [
  'CAPITAL_INVALIDO',
  'DEFINICOES_INVALIDAS',
  'SEM_POSICAO',
  'ACCOUNT_VALUE_INVALIDO',
  'PRECO_INVALIDO',
  'DADOS_POSICAO_INVALIDOS',
  'METADADOS_INVALIDOS',
  'ABAIXO_ORDEM_MINIMA',
] as const;
export const motivoInviabilidadeSchema = z.enum(MOTIVOS_INVIABILIDADE);
export type MotivoInviabilidade = z.infer<typeof motivoInviabilidadeSchema>;

/** SL ou TP: nível da baleia, distância relativa à entrada dela e preço reaplicado ao atual. */
export const nivelProtecaoSchema = z.object({
  precoBaleia: z.number(),
  /** `(triggerPx − entryPx) ÷ entryPx × 100`, com sinal. */
  distanciaPct: z.number(),
  /** Preço atual × (1 + distância), arredondado às regras de preço dos perps. */
  preco: z.number(),
});
export type NivelProtecaoDto = z.infer<typeof nivelProtecaoSchema>;

export const baleiaSugestaoSchema = z.object({
  accountValue: z.number(),
  accountValueRepresentativo: z.boolean(),
  modoConta: z.string().nullable(),
  /** `marginUsed ÷ accountValue × 100`. */
  percentagemMargemPct: z.number(),
  alavancagem: z.number(),
  tipoMargem: z.enum(['cross', 'isolated']),
  entryPx: z.number(),
  tamanho: z.number(),
  notional: z.number(),
  liquidationPx: z.number().nullable(),
});

export const posicaoSugeridaSchema = z.object({
  /** Preço de referência da entrada do utilizador (preço atual). */
  precoEntrada: z.number(),
  alavancagem: z.number(),
  alavancagemLimitada: z.boolean(),
  /** Margem isolada a alocar (notional ÷ alavancagem), em USD. */
  margemUsd: z.number(),
  notionalUsd: z.number(),
  /** Tamanho em unidades do ativo, arredondado para baixo ao `szDecimals`. */
  tamanho: z.number(),
  szDecimals: z.number().int(),
  stopLoss: nivelProtecaoSchema.nullable(),
  takeProfit: nivelProtecaoSchema.nullable(),
  /** Estimativa (margem isolada, sem escalões de margem); `null` se não houver liquidação. */
  liquidacaoEstimada: z.number().nullable(),
  /** Capital × risco máximo por operação. */
  riscoMaximoUsd: z.number(),
  /** Perda até ao SL (sem comissões nem slippage); `null` sem SL. */
  perdaAteStopUsd: z.number().nullable(),
  /** Só sem SL: perda até à liquidação estimada. */
  perdaAteLiquidacaoUsd: z.number().nullable(),
  limitadoPeloRisco: z.boolean(),
});
export type PosicaoSugeridaDto = z.infer<typeof posicaoSugeridaSchema>;

export const sugestaoProporcionalSchema = z.object({
  viavel: z.boolean(),
  motivo: z.object({ codigo: motivoInviabilidadeSchema, mensagem: z.string() }).nullable(),
  lado: z.enum(['long', 'short']).nullable(),
  /** Capital do utilizador ÷ accountValue da baleia. */
  fator: z.number().nullable(),
  baleia: baleiaSugestaoSchema.nullable(),
  posicao: posicaoSugeridaSchema.nullable(),
  entradaTardia: z
    .object({
      /** Quanto o preço já andou a favor da baleia desde a entrada dela (negativo = contra). */
      variacaoFavoravelPct: z.number(),
      limiarPct: z.number(),
      tardia: z.boolean(),
    })
    .nullable(),
  /** R:R = recompensa ÷ risco. */
  rr: z
    .object({
      /** Com o SL/TP reaplicados ao preço atual. */
      sugerido: z.number().nullable(),
      /** O que a baleia tinha na entrada dela. */
      baleia: z.number().nullable(),
      /** Entrar agora com os níveis absolutos da baleia (mostra o custo da entrada tardia). */
      aosNiveisDaBaleia: z.number().nullable(),
    })
    .nullable(),
  ordemMinimaUsd: z.number(),
  avisos: z.array(avisoSugestaoSchema),
  avisoLegal: z.string(),
});
export type SugestaoProporcionalDto = z.infer<typeof sugestaoProporcionalSchema>;

export const sugestaoCarteiraSchema = z.object({
  carteira: z.object({
    id: z.number().int(),
    endereco: z.string(),
    alias: z.string().nullable(),
    entidade: z.string().nullable(),
  }),
  /** Instante e run do snapshot usado; `null` se a carteira ainda não tem snapshots. */
  instanteSnapshot: dataIsoSchema.nullable(),
  runId: z.number().int().nullable(),
  sugestao: sugestaoProporcionalSchema,
});
export type SugestaoCarteiraDto = z.infer<typeof sugestaoCarteiraSchema>;

/** Resposta de `GET /api/ativos/:id/sugestao`. */
export const respostaSugestaoSchema = z.object({
  ativoId: z.number().int(),
  ticker: z.string(),
  /** `false` = sem análise em curso; os dados são do último snapshot disponível. */
  analiseAtiva: z.boolean(),
  precoMercado: precoMercadoDtoSchema.nullable(),
  definicoes: z.object({
    capitalUsd: z.number(),
    alavancagemMaxima: z.number(),
    riscoPorOperacaoPct: z.number(),
  }),
  /** Ordenadas por notional da baleia (maior primeiro). */
  sugestoes: z.array(sugestaoCarteiraSchema),
  avisoLegal: z.string(),
});
export type RespostaSugestao = z.infer<typeof respostaSugestaoSchema>;
