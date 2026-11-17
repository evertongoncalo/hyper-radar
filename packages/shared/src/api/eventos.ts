import { z } from 'zod';
import { booleanoQuerySchema, dataIsoSchema, idEventoSchema, idSchema } from './comum';
/** Tipos de evento gerados pelo diff entre snapshots (secção 6.1). */
export const TIPOS_EVENTO_API = [
  'OPENED',
  'CLOSED',
  'INCREASED',
  'REDUCED',
  'FLIPPED',
  'SLTP_CHANGED',
  'LIQ_NEAR',
] as const;
export const tipoEventoSchema = z.enum(TIPOS_EVENTO_API, { error: 'Tipo de evento inválido.' });
export type TipoEventoDto = z.infer<typeof tipoEventoSchema>;

export const LIMITE_EVENTOS_OMISSAO = 50;
export const LIMITE_EVENTOS_MAXIMO = 200;

/** Evento persistido, com o contexto para o feed e as notificações. */
export const eventoDtoSchema = z.object({
  id: z.number().int(),
  tipo: tipoEventoSchema,
  assetId: z.number().int(),
  walletId: z.number().int(),
  runId: z.number().int().nullable(),
  ticker: z.string(),
  endereco: z.string(),
  alias: z.string().nullable(),
  /** Dados do evento (posição, tamanhos, preços, SL/TP…), dependentes do `tipo`. */
  payload: z.record(z.string(), z.unknown()),
  lido: z.boolean(),
  criadoEm: dataIsoSchema,
});
export type EventoDto = z.infer<typeof eventoDtoSchema>;

/** Lista separada por vírgulas e/ou parâmetro repetido (`tipos=OPENED,CLOSED&tipos=FLIPPED`). */
const tiposQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(z.array(tipoEventoSchema));

/** Query de `GET /api/eventos` (todos opcionais). */
export const listarEventosQuerySchema = z
  .object({
    ativo: idSchema.optional(),
    carteira: idSchema.optional(),
    tipos: tiposQuerySchema.optional(),
    naoLidos: booleanoQuerySchema.optional(),
    /** Intervalo inclusivo sobre `criadoEm`. */
    desde: dataIsoSchema.optional(),
    ate: dataIsoSchema.optional(),
    /** `proximoCursor` da página anterior. */
    cursor: idEventoSchema.optional(),
    limite: z.coerce
      .number({ error: 'Limite inválido.' })
      .int({ error: 'Limite inválido.' })
      .min(1, { error: `O limite tem de estar entre 1 e ${LIMITE_EVENTOS_MAXIMO}.` })
      .max(LIMITE_EVENTOS_MAXIMO, {
        error: `O limite tem de estar entre 1 e ${LIMITE_EVENTOS_MAXIMO}.`,
      })
      .optional(),
  })
  .refine((q) => !q.desde || !q.ate || Date.parse(q.desde) <= Date.parse(q.ate), {
    error: '"desde" tem de ser anterior ou igual a "ate".',
    path: ['desde'],
  });
export type ListarEventosQuery = z.input<typeof listarEventosQuerySchema>;

export const paginaEventosSchema = z.object({
  /** Do mais recente para o mais antigo. */
  itens: z.array(eventoDtoSchema),
  /** `null` quando não há mais páginas. */
  proximoCursor: z.number().int().nullable(),
});
export type PaginaEventosDto = z.infer<typeof paginaEventosSchema>;

/** `POST /api/eventos/:id/lido`. */
export const eventoLidoRespostaSchema = z.object({ id: z.number().int(), lido: z.literal(true) });
export type EventoLidoResposta = z.infer<typeof eventoLidoRespostaSchema>;

/** `POST /api/ativos/:id/eventos/lidos`. */
export const eventosLidosRespostaSchema = z.object({ marcados: z.number().int().nonnegative() });
export type EventosLidosResposta = z.infer<typeof eventosLidosRespostaSchema>;

/** `GET /api/eventos/nao-lidos/contagem`. */
export const contagemNaoLidosSchema = z.object({
  total: z.number().int().nonnegative(),
  /** Só ativos com pelo menos um evento não lido. */
  porAtivo: z.array(
    z.object({ assetId: z.number().int(), naoLidos: z.number().int().nonnegative() }),
  ),
});
export type ContagemNaoLidos = z.infer<typeof contagemNaoLidosSchema>;
