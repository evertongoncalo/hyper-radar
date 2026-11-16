import { describe, expect, it } from 'vitest';
import { decimalHlSchema, separarTicker } from './index';

describe('separarTicker', () => {
  it('ativo HIP-3 mantém o prefixo no coin', () => {
    expect(separarTicker('xyz:NVDA')).toEqual({ dex: 'xyz', coin: 'xyz:NVDA' });
  });

  it('ativo nativo não tem dex', () => {
    expect(separarTicker(' BTC ')).toEqual({ dex: null, coin: 'BTC' });
  });

  it.each(['', '   ', ':NVDA', 'xyz:', 'a:b:c'])('rejeita ticker inválido "%s"', (ticker) => {
    expect(() => separarTicker(ticker)).toThrow(/Ticker inválido/);
  });
});

describe('decimalHlSchema', () => {
  it.each([
    ['65454.5', 65454.5],
    ['-2.37464', -2.37464],
    ['0.0', 0],
    ['1e-5', 0.00001],
  ])('converte "%s"', (texto, numero) => {
    expect(decimalHlSchema.parse(texto)).toBe(numero);
  });

  it.each(['abc', '', '1,5', '1e999'])('rejeita "%s"', (texto) => {
    expect(decimalHlSchema.safeParse(texto).success).toBe(false);
  });

  it('rejeita números (a API envia strings)', () => {
    expect(decimalHlSchema.safeParse(1.5).success).toBe(false);
  });
});
