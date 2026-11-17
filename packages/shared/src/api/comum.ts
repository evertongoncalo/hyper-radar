import { z } from 'zod';

/*
 * Blocos comuns dos contratos da API REST/SSE. Datas em ISO 8601 (string, UTC), números como
 * `number`, campos em camelCase PT.
 */

const MAX_INT4 = 2_147_483_647;

/** Data ISO 8601 com fuso (ex.: `2026-01-10T12:00:00.000Z`). */
export const dataIsoSchema = z.iso.datetime({ offset: true, error: 'Data ISO 8601 inválida.' });
export type DataIso = z.infer<typeof dataIsoSchema>;

/** Id inteiro positivo de ativos/carteiras (coluna `integer`); aceita string em params/query. */
export const idSchema = z.coerce
  .number({ error: 'Identificador inválido.' })
  .int({ error: 'Identificador inválido.' })
  .min(1, { error: 'Identificador inválido.' })
  .max(MAX_INT4, { error: 'Identificador inválido.' });

/** Id de evento (coluna `bigint`, seguro como number). */
export const idEventoSchema = z.coerce
  .number({ error: 'Identificador inválido.' })
  .int({ error: 'Identificador inválido.' })
  .min(1, { error: 'Identificador inválido.' })
  .max(Number.MAX_SAFE_INTEGER, { error: 'Identificador inválido.' });

export const paramsIdSchema = z.object({ id: idSchema });
export type ParamsId = z.infer<typeof paramsIdSchema>;

export const paramsIdEventoSchema = z.object({ id: idEventoSchema });

/** Booleano em query string (`true`/`false`/`1`/`0`). */
export const booleanoQuerySchema = z
  .enum(['true', 'false', '1', '0'], { error: 'Use true ou false.' })
  .transform((v) => v === 'true' || v === '1');

/** Texto opcional (alias/entidade): sem espaços nas pontas; vazio passa a `null`. */
export const textoCurtoOpcionalSchema = z
  .string({ error: 'Tem de ser texto.' })
  .trim()
  .max(100, { error: 'Máximo de 100 caracteres.' })
  .transform((v) => (v === '' ? null : v))
  .nullable();

/** Códigos de erro devolvidos pela API (`erro.codigo`). */
export const CODIGOS_ERRO_API = [
  'VALIDACAO',
  'PEDIDO_INVALIDO',
  'JSON_INVALIDO',
  'TICKER_INVALIDO',
  'TICKER_INEXISTENTE',
  'ENDERECO_INVALIDO',
  'VALOR_INVALIDO',
  'RESTRICAO_VIOLADA',
  'NAO_ENCONTRADO',
  'TICKER_DUPLICADO',
  'CARTEIRA_JA_ASSOCIADA',
  'RUN_JA_ABERTO',
  'RUN_FECHADO',
  'SEM_CARTEIRAS',
  'CAPITAL_NAO_CONFIGURADO',
  'JA_EM_CURSO',
  'NAO_EM_CURSO',
  'HOST_INVALIDO',
  'ORIGEM_INVALIDA',
  'CORPO_DEMASIADO_GRANDE',
  'TIPO_CONTEUDO_INVALIDO',
  'HYPERLIQUID_INDISPONIVEL',
  'SERVICO_INDISPONIVEL',
  'IA_NAO_CONFIGURADA',
  'LIMITE_IA_ATINGIDO',
  'IA_RECUSA',
  'IA_RESPOSTA_INVALIDA',
  'IA_INDISPONIVEL',
  'ERRO_INTERNO',
] as const;

export const codigoErroApiSchema = z.enum(CODIGOS_ERRO_API);
export type CodigoErroApi = z.infer<typeof codigoErroApiSchema>;

export const problemaValidacaoSchema = z.object({
  /** Caminho do campo (ex.: `body.ticker`, `query.limite`). */
  caminho: z.string(),
  mensagem: z.string(),
});
export type ProblemaValidacao = z.infer<typeof problemaValidacaoSchema>;

/** Resposta de erro uniforme: `{ erro: { codigo, mensagem, detalhes? } }` (mensagem em PT-PT). */
export const respostaErroSchema = z.object({
  erro: z.object({
    codigo: codigoErroApiSchema,
    mensagem: z.string(),
    detalhes: z.unknown().optional(),
  }),
});
export type RespostaErro = z.infer<typeof respostaErroSchema>;

/** `GET /health` (na raiz, fora de `/api`). */
export const respostaSaudeServidorSchema = z.object({
  status: z.enum(['ok', 'degradado']),
  bd: z.enum(['ok', 'indisponivel']),
  ativosEmAnalise: z.number().int().nonnegative(),
});
export type RespostaSaudeServidor = z.infer<typeof respostaSaudeServidorSchema>;
