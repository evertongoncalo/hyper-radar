import { enderecoCarteiraSchema } from '@hyper-radar/shared';
import { describe, expect, it } from 'vitest';

// Garante que o pacote partilhado é resolvido a partir da API.
describe('@hyper-radar/shared na API', () => {
  it('valida um endereço de carteira', () => {
    expect(enderecoCarteiraSchema.safeParse('0x' + '1'.repeat(40)).success).toBe(true);
  });
});
