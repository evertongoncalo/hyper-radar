import { z } from 'zod';
import { dataIsoSchema, idSchema } from './comum';

/*
 * Análise IA (secção 7.2): só por pedido manual. O relatório tem um schema fixo (Structured
 * Outputs); os nomes dos campos do relatório seguem a especificação (snake_case).
 */

/** Aviso obrigatório presente em `avisos` de todos os relatórios. */
export const AVISO_IA_NAO_ACONSELHAMENTO =
  'Esta análise não constitui aconselhamento financeiro; a decisão é sempre sua.';

export const VIESES_IA = ['alta', 'baixa', 'neutro', 'misto'] as const;
export const NIVEIS_ALINHAMENTO_IA = [
  'forte',
  'moderado',
  'fraco',
  'divergente',
  'sem_dados',
] as const;

const texto = z.string().max(4_000);
const probabilidade = z.number().min(0).max(1);

/** Relatório devolvido pelo modelo (validado sempre antes de gravar). */
export const relatorioIaSchema = z.strictObject({
  resumo: texto,
  vies: z.enum(VIESES_IA),
  confianca: probabilidade,
  alinhamento_baleias: z.strictObject({
    nivel: z.enum(NIVEIS_ALINHAMENTO_IA),
    descricao: texto,
  }),
  riscos: z.array(texto).max(20),
  niveis_chave: z.array(z.strictObject({ preco: z.number(), descricao: texto })).max(20),
  cenarios: z
    .array(
      z.strictObject({
        nome: texto,
        probabilidade,
        descricao: texto,
        gatilho: texto,
      }),
    )
    .max(10),
  /** `null` quando não faz sentido sugerir um cenário de entrada. */
  cenario_entrada_sugerido: z
    .strictObject({
      lado: z.enum(['long', 'short']),
      entrada: z.number(),
      stop_loss: z.number(),
      take_profit: z.number(),
      justificacao: texto,
    })
    .nullable(),
  avisos: z.array(texto).min(1).max(20),
});
export type RelatorioIa = z.infer<typeof relatorioIaSchema>;

/** Relatório gravado (`ai_reports`). */
export const relatorioIaDtoSchema = z.object({
  id: z.number().int(),
  ativoId: z.number().int(),
  modelo: z.string(),
  hashInput: z.string(),
  criadoEm: dataIsoSchema,
  tokensEntrada: z.number().int().nonnegative(),
  tokensSaida: z.number().int().nonnegative(),
  /** `null` se o modelo não tiver preço conhecido. */
  custoEstimadoUsd: z.number().nonnegative().nullable(),
  relatorio: relatorioIaSchema,
});
export type RelatorioIaDto = z.infer<typeof relatorioIaDtoSchema>;

/** `POST /api/ativos/:id/ia/analise`. */
export const pedidoAnaliseIaSchema = z.strictObject({
  /** Ignora a cache e faz sempre uma nova chamada (conta para os limites diários). */
  forcar: z.boolean({ error: 'forcar: tem de ser true ou false.' }).optional(),
});
export type PedidoAnaliseIa = z.input<typeof pedidoAnaliseIaSchema>;

export const respostaAnaliseIaSchema = z.object({
  relatorio: relatorioIaDtoSchema,
  /** `true` = relatório anterior com o mesmo input e modelo (sem nova chamada nem custo). */
  daCache: z.boolean(),
  /** Custo desta operação: 0 na cache; `null` se o modelo não tiver preço conhecido. */
  custoEstimadoUsd: z.number().nonnegative().nullable(),
  avisoLegal: z.string(),
});
export type RespostaAnaliseIa = z.infer<typeof respostaAnaliseIaSchema>;

export const LIMITE_RELATORIOS_IA_MAXIMO = 100;

/** `GET /api/ativos/:id/ia/relatorios?cursor=&limite=`. */
export const listarRelatoriosIaQuerySchema = z.strictObject({
  /** `proximoCursor` da página anterior. */
  cursor: idSchema.optional(),
  limite: z.coerce
    .number({ error: 'Limite inválido.' })
    .int({ error: 'Limite inválido.' })
    .min(1, { error: `O limite tem de estar entre 1 e ${LIMITE_RELATORIOS_IA_MAXIMO}.` })
    .max(LIMITE_RELATORIOS_IA_MAXIMO, {
      error: `O limite tem de estar entre 1 e ${LIMITE_RELATORIOS_IA_MAXIMO}.`,
    })
    .optional(),
});
export type ListarRelatoriosIaQuery = z.input<typeof listarRelatoriosIaQuerySchema>;

export const resumoRelatorioIaSchema = relatorioIaDtoSchema
  .omit({ relatorio: true })
  .extend({ resumo: z.string(), vies: z.enum(VIESES_IA), confianca: probabilidade });
export type ResumoRelatorioIa = z.infer<typeof resumoRelatorioIaSchema>;

export const paginaRelatoriosIaSchema = z.object({
  /** Do mais recente para o mais antigo. */
  itens: z.array(resumoRelatorioIaSchema),
  proximoCursor: z.number().int().nullable(),
});
export type PaginaRelatoriosIa = z.infer<typeof paginaRelatoriosIaSchema>;

export const precoModeloIaSchema = z.object({
  modelo: z.string(),
  entradaUsdPorMilhao: z.number().nonnegative(),
  saidaUsdPorMilhao: z.number().nonnegative(),
});
export type PrecoModeloIa = z.infer<typeof precoModeloIaSchema>;

/** `GET /api/ia/estado`. */
export const estadoIaSchema = z.object({
  /** Há `OPENAI_API_KEY` configurada (o valor nunca é devolvido). */
  configurada: z.boolean(),
  modelo: z.string(),
  /** `false` = modelo sem preço conhecido (o custo fica por estimar). */
  modeloComPreco: z.boolean(),
  precos: z.array(precoModeloIaSchema),
  hoje: z.object({
    /** Dia corrente em `Europe/Lisbon` (`AAAA-MM-DD`). */
    dia: z.string(),
    chamadas: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    custoEstimadoUsd: z.number().nonnegative(),
    /** 0 = sem limite. */
    limiteChamadas: z.number().int().nonnegative(),
    limiteTokens: z.number().int().nonnegative(),
  }),
});
export type EstadoIa = z.infer<typeof estadoIaSchema>;
