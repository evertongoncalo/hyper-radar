import { z } from 'zod';

/*
 * Configuração do motor de análise. Todos os valores são omissões ajustáveis (secção 6.1); o
 * motor nunca usa constantes soltas para limiares ou janelas.
 */

const MINUTO = 60_000;

export const configMotorSchema = z
  .object({
    /** Variação acumulada mínima, em % do tamanho de referência, para `INCREASED`/`REDUCED`. */
    limiarVariacaoPct: z.number().positive().default(5),
    /** Variação acumulada mínima, em USD de notional, para `INCREASED`/`REDUCED`. */
    limiarVariacaoUsd: z.number().positive().default(10_000),
    /** Notional mínimo (USD) para `OPENED`, `CLOSED` e `FLIPPED`; abaixo disso é ruído. */
    notionalMinimoUsd: z.number().nonnegative().default(1_000),
    /** Janela de agregação de `INCREASED`/`REDUCED` desde a primeira divergência (ms). */
    janelaAgregacaoMs: z
      .number()
      .int()
      .positive()
      .default(5 * MINUTO),
    /** Janela de debounce de `SLTP_CHANGED` desde a primeira alteração (ms). */
    janelaSltpMs: z
      .number()
      .int()
      .positive()
      .default(2 * MINUTO),
    /** `LIQ_NEAR` dispara ao entrar abaixo desta distância (% do preço de mercado). */
    liqNearPct: z.number().positive().default(5),
    /** `LIQ_NEAR` só volta a armar quando a distância sobe a este valor (histerese). */
    liqRearmePct: z.number().positive().default(7),
    /** Tolerância relativa (%) para considerar dois `triggerPx` iguais. */
    toleranciaPrecoSltpPct: z.number().nonnegative().default(0.05),
    /** Tolerância relativa para comparar tamanhos/preços (ruído de vírgula flutuante). */
    toleranciaRelativa: z.number().nonnegative().max(1e-3).default(1e-9),
    /**
     * Bucket temporal (ms) opcional da chave de deduplicação dos tipos agregados (`INCREASED`,
     * `REDUCED`, `SLTP_CHANGED`). Omissão: o instante exato do início da janela, que é único por
     * janela; um bucket fixo faria colidir duas janelas legítimas no mesmo bucket (e a BD
     * descartaria a segunda). Os tipos imediatos usam sempre o instante exato do snapshot.
     */
    bucketDedupeMs: z.number().int().positive().optional(),
  })
  .strict()
  .refine((c) => c.liqRearmePct > c.liqNearPct, {
    message: 'O rearme de LIQ_NEAR tem de ser superior ao limiar.',
    path: ['liqRearmePct'],
  });

export type ConfigMotor = Readonly<z.output<typeof configMotorSchema>>;
export type ConfigMotorEntrada = z.input<typeof configMotorSchema>;

/** Valida e completa a configuração com as omissões; lança `ZodError` se for inválida. */
export function criarConfig(entrada: ConfigMotorEntrada = {}): ConfigMotor {
  return Object.freeze(configMotorSchema.parse(entrada));
}

export const CONFIG_OMISSAO: ConfigMotor = criarConfig();
