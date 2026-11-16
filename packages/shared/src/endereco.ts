import { z } from 'zod';

/**
 * Endereço de carteira EVM/Hyperliquid: `0x` seguido de 40 caracteres hexadecimais.
 * Aceita maiúsculas e minúsculas e normaliza para minúsculas, para comparações consistentes.
 */
export const enderecoCarteiraSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, {
    message: 'Endereço inválido: deve ser 0x seguido de 40 caracteres hexadecimais.',
  })
  .transform((valor) => valor.toLowerCase());

export type EnderecoCarteira = z.output<typeof enderecoCarteiraSchema>;
