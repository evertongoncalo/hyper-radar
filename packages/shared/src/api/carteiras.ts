import { z } from 'zod';
import { enderecoCarteiraSchema } from '../endereco';
import { dataIsoSchema, idSchema, textoCurtoOpcionalSchema } from './comum';

export const carteiraDtoSchema = z.object({
  id: z.number().int(),
  /** Endereço público normalizado em minúsculas. */
  endereco: z.string(),
  alias: z.string().nullable(),
  entidade: z.string().nullable(),
  criadoEm: dataIsoSchema,
});
export type CarteiraDto = z.infer<typeof carteiraDtoSchema>;

/** Item de `GET /api/carteiras`: carteira com os ativos a que pertence. */
export const carteiraComAtivosSchema = carteiraDtoSchema.extend({
  ativos: z.array(z.object({ id: z.number().int(), ticker: z.string() })),
});
export type CarteiraComAtivosDto = z.infer<typeof carteiraComAtivosSchema>;

export const listaCarteirasSchema = z.array(carteiraComAtivosSchema);

/** `POST /api/ativos/:id/carteiras`. Alias/entidade vazios passam a `null`. */
export const adicionarCarteiraPedidoSchema = z.strictObject({
  endereco: enderecoCarteiraSchema,
  alias: textoCurtoOpcionalSchema.optional(),
  entidade: textoCurtoOpcionalSchema.optional(),
});
export type AdicionarCarteiraPedido = z.input<typeof adicionarCarteiraPedidoSchema>;

export const adicionarCarteiraRespostaSchema = z.object({
  carteira: carteiraDtoSchema,
  /** `true` se a análise do ativo estava ativa e foi reiniciada (nova linha de base). */
  analiseReiniciada: z.boolean(),
});
export type AdicionarCarteiraResposta = z.infer<typeof adicionarCarteiraRespostaSchema>;

/** `PATCH /api/carteiras/:id`: `null` ou `""` limpa; campo omitido mantém. */
export const alterarCarteiraPedidoSchema = z.strictObject({
  alias: textoCurtoOpcionalSchema.optional(),
  entidade: textoCurtoOpcionalSchema.optional(),
});
export type AlterarCarteiraPedido = z.input<typeof alterarCarteiraPedidoSchema>;

export const paramsCarteiraDoAtivoSchema = z.object({ id: idSchema, carteiraId: idSchema });
