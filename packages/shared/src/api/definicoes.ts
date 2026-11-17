import { z } from 'zod';
import { dataIsoSchema } from './comum';

/** Intervalo mínimo de recolha (segundos), para respeitar os limites da Hyperliquid. */
export const INTERVALO_RECOLHA_MINIMO_S = 15;
export const INTERVALO_RECOLHA_MAXIMO_S = 86_400;
const MAX_INT4 = 2_147_483_647;

const inteiro = (min: number, max: number, campo: string) =>
  z
    .number({ error: `${campo}: tem de ser um número.` })
    .int({ error: `${campo}: tem de ser um número inteiro.` })
    .min(min, { error: `${campo}: mínimo ${min}.` })
    .max(max, { error: `${campo}: máximo ${max}.` });

/** Campos editáveis das definições, com os mesmos limites que a BD aplica. */
export const camposDefinicoesSchema = z.strictObject({
  /** Capital disponível para a sugestão proporcional, em USD. */
  capitalUsd: z
    .number({ error: 'Capital: tem de ser um número.' })
    .min(0, { error: 'Capital: não pode ser negativo.' })
    .max(1e15, { error: 'Capital: valor demasiado alto.' }),
  alavancagemMaxima: inteiro(1, 100, 'Alavancagem máxima'),
  /** Risco máximo por operação, em % do capital (ex.: 1 = 1 %). */
  riscoPorOperacaoPct: z
    .number({ error: 'Risco por operação: tem de ser um número.' })
    .gt(0, { error: 'Risco por operação: tem de ser maior do que 0.' })
    .max(100, { error: 'Risco por operação: máximo 100 %.' }),
  intervaloRecolhaSegundos: inteiro(
    INTERVALO_RECOLHA_MINIMO_S,
    INTERVALO_RECOLHA_MAXIMO_S,
    'Intervalo de recolha',
  ),
  limiteDiarioChamadasIa: inteiro(0, MAX_INT4, 'Limite diário de chamadas IA'),
  limiteDiarioTokensIa: inteiro(0, MAX_INT4, 'Limite diário de tokens IA'),
});

/** `GET /api/definicoes` (e resposta do `PATCH`). */
export const definicoesDtoSchema = z.object({
  ...camposDefinicoesSchema.shape,
  atualizadoEm: dataIsoSchema,
});
export type DefinicoesDto = z.infer<typeof definicoesDtoSchema>;

/**
 * Resposta real de `GET/PATCH /api/definicoes`: as definições mais o modelo OpenAI configurado
 * (`OPENAI_MODEL`, só de leitura). Compatível com `definicoesDtoSchema` (campo extra).
 */
export const definicoesComIaDtoSchema = definicoesDtoSchema.extend({ modeloIa: z.string() });
export type DefinicoesComIaDto = z.infer<typeof definicoesComIaDtoSchema>;

/** `PATCH /api/definicoes`: alteração parcial (campos omitidos mantêm-se). */
export const alterarDefinicoesPedidoSchema = camposDefinicoesSchema.partial();
export type AlterarDefinicoesPedido = z.input<typeof alterarDefinicoesPedidoSchema>;
