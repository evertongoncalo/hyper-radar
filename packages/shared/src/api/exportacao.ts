import { z } from 'zod';
import { enderecoCarteiraSchema } from '../endereco';
import { tickerSchema } from './ativos';
import { dataIsoSchema, textoCurtoOpcionalSchema } from './comum';
import { camposDefinicoesSchema } from './definicoes';

/** Versão do formato de exportação (secção 12: backup da lista de ativos e carteiras). */
export const VERSAO_EXPORTACAO = 1;

/**
 * Ficheiro de exportação/importação: ativos, carteiras, associações e definições.
 * Não inclui snapshots nem eventos.
 */
export const exportacaoSchema = z.strictObject({
  versao: z.literal(VERSAO_EXPORTACAO, { error: `Versão do ficheiro não suportada.` }),
  exportadoEm: dataIsoSchema,
  carteiras: z
    .array(
      z.strictObject({
        endereco: enderecoCarteiraSchema,
        alias: textoCurtoOpcionalSchema,
        entidade: textoCurtoOpcionalSchema,
      }),
    )
    .max(10_000),
  ativos: z
    .array(
      z.strictObject({
        ticker: tickerSchema,
        /** Endereços das carteiras associadas (têm de constar em `carteiras`). */
        carteiras: z.array(enderecoCarteiraSchema).max(10_000),
      }),
    )
    .max(1_000),
  /** Opcional na importação: se presente, substitui as definições atuais. */
  definicoes: camposDefinicoesSchema.optional(),
});
export type Exportacao = z.infer<typeof exportacaoSchema>;
export type ExportacaoEntrada = z.input<typeof exportacaoSchema>;

/** Validação extra: associações só a carteiras do ficheiro e sem tickers repetidos. */
export const importacaoPedidoSchema = exportacaoSchema.superRefine((dados, ctx) => {
  const enderecos = new Set(dados.carteiras.map((c) => c.endereco));
  const tickers = new Set<string>();
  dados.ativos.forEach((a, i) => {
    if (tickers.has(a.ticker)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ativos', i, 'ticker'],
        message: `Ticker repetido: "${a.ticker}".`,
      });
    }
    tickers.add(a.ticker);
    a.carteiras.forEach((e, j) => {
      if (!enderecos.has(e)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ativos', i, 'carteiras', j],
          message: `A carteira ${e} não consta da lista de carteiras.`,
        });
      }
    });
  });
});

/** Resultado de `POST /api/importacao` (contagens do que foi efetivamente criado/alterado). */
export const importacaoRespostaSchema = z.object({
  ativosCriados: z.number().int().nonnegative(),
  carteirasCriadas: z.number().int().nonnegative(),
  carteirasAtualizadas: z.number().int().nonnegative(),
  associacoesCriadas: z.number().int().nonnegative(),
  definicoesAtualizadas: z.boolean(),
  /** Ids dos ativos em análise que foram reiniciados por terem novas carteiras. */
  analisesReiniciadas: z.array(z.number().int()),
});
export type ImportacaoResposta = z.infer<typeof importacaoRespostaSchema>;
