import { enderecoCarteiraSchema } from '@hyper-radar/shared';
import { describe, expect, it } from 'vitest';

// Garante que o pacote partilhado é resolvido a partir da web.
describe('@hyper-radar/shared na web', () => {
  it('rejeita um endereço de carteira inválido', () => {
    expect(enderecoCarteiraSchema.safeParse('0x123').success).toBe(false);
  });
});
