import { z } from 'zod';
import { estadoAtivoSchema } from './ativos';
import { dataIsoSchema } from './comum';
import { eventoDtoSchema } from './eventos';

/*
 * `GET /api/stream` (text/event-stream). Eventos nomeados:
 * - `evento`: evento persistido (`id:` = id do evento; reenviado após `Last-Event-ID`);
 * - `estado-ativo`: mudança de estado de um ativo;
 * - `ciclo`: resumo de um ciclo de recolha terminado.
 * Comentários `: ping` servem de heartbeat.
 */

export const NOMES_EVENTOS_SSE = ['evento', 'estado-ativo', 'ciclo'] as const;
export type NomeEventoSse = (typeof NOMES_EVENTOS_SSE)[number];

/** Máximo de eventos reenviados ao religar com `Last-Event-ID`. */
export const LIMITE_REENVIO_SSE = 500;

export const sseEventoSchema = eventoDtoSchema;

export const sseEstadoAtivoSchema = z.object({
  assetId: z.number().int(),
  ticker: z.string(),
  anterior: estadoAtivoSchema,
  estado: estadoAtivoSchema,
  /** Run em curso após a mudança (`null` se parado). */
  runId: z.number().int().nullable(),
  instante: dataIsoSchema,
});
export type SseEstadoAtivo = z.infer<typeof sseEstadoAtivoSchema>;

export const sseCicloSchema = z.object({
  assetId: z.number().int(),
  ticker: z.string(),
  runId: z.number().int(),
  instante: dataIsoSchema,
  duracaoMs: z.number(),
  carteirasOk: z.number().int(),
  carteirasFalhadas: z.number().int(),
  /** Eventos inseridos (e publicados) neste ciclo. */
  eventos: z.number().int(),
  falhou: z.boolean(),
  erro: z.string().nullable(),
});
export type SseCiclo = z.infer<typeof sseCicloSchema>;

/** Dados (`data:` em JSON) de cada evento SSE, por nome. */
export const schemasEventosSse = {
  evento: sseEventoSchema,
  'estado-ativo': sseEstadoAtivoSchema,
  ciclo: sseCicloSchema,
} as const satisfies Record<NomeEventoSse, z.ZodType>;

export type DadosEventoSse = { [K in NomeEventoSse]: z.infer<(typeof schemasEventosSse)[K]> };
