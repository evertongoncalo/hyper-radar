import { describe, expect, it } from 'vitest';
import { enderecoCarteiraSchema } from './index';

const valido = '0x' + 'a'.repeat(40);

describe('enderecoCarteiraSchema', () => {
  it('aceita um endereço válido', () => {
    expect(enderecoCarteiraSchema.parse(valido)).toBe(valido);
  });

  it('normaliza para minúsculas e remove espaços', () => {
    const misto = '  0x' + 'AbCdEf0123'.repeat(4) + '  ';
    expect(enderecoCarteiraSchema.parse(misto)).toBe('0x' + 'abcdef0123'.repeat(4));
  });

  it.each([
    ['sem prefixo', 'a'.repeat(40)],
    ['curto demais', '0x' + 'a'.repeat(39)],
    ['longo demais', '0x' + 'a'.repeat(41)],
    ['caracteres não hexadecimais', '0x' + 'g'.repeat(40)],
    ['vazio', ''],
  ])('rejeita endereço %s', (_caso, valor) => {
    const resultado = enderecoCarteiraSchema.safeParse(valor);
    expect(resultado.success).toBe(false);
  });

  it('rejeita valores que não são texto', () => {
    expect(enderecoCarteiraSchema.safeParse(123).success).toBe(false);
  });
});
