import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { CONFIG_OMISSAO, criarConfig } from './config';
import { atingeLimiar, quaseIgual, variacaoPct } from './numeros';

describe('config do motor', () => {
  it('omissões sensatas', () => {
    expect(CONFIG_OMISSAO).toEqual({
      limiarVariacaoPct: 5,
      limiarVariacaoUsd: 10_000,
      notionalMinimoUsd: 1_000,
      janelaAgregacaoMs: 300_000,
      janelaSltpMs: 120_000,
      liqNearPct: 5,
      liqRearmePct: 7,
      toleranciaPrecoSltpPct: 0.05,
      toleranciaRelativa: 1e-9,
    });
    expect(Object.isFrozen(CONFIG_OMISSAO)).toBe(true);
  });

  it('bucket de dedupe só existe se indicado (omissão: início exato da janela)', () => {
    expect(criarConfig({ janelaAgregacaoMs: 60_000 }).bucketDedupeMs).toBeUndefined();
    expect(criarConfig({ janelaAgregacaoMs: 60_000, bucketDedupeMs: 1_000 }).bucketDedupeMs).toBe(
      1_000,
    );
  });

  it.each([
    [{ limiarVariacaoPct: 0 }],
    [{ limiarVariacaoUsd: -1 }],
    [{ janelaAgregacaoMs: 1.5 }],
    [{ liqNearPct: 7, liqRearmePct: 7 }],
    [{ liqNearPct: 8 }],
    [{ toleranciaRelativa: 0.1 }],
    [{ limiarVariacaoPct: Number.NaN }],
    [{ desconhecido: 1 } as never],
  ])('rejeita configuração inválida %j', (entrada) => {
    expect(() => criarConfig(entrada)).toThrow(ZodError);
  });
});

describe('números com tolerância', () => {
  it.each([
    [0.1 + 0.2, 0.3, true],
    [1, 1 + 1e-12, true],
    [0, 1e-13, true],
    [1, 1.001, false],
    [100, 100.0000001, true],
  ])('quaseIgual(%d, %d) = %s', (a, b, esperado) => {
    expect(quaseIgual(a, b, 1e-9)).toBe(esperado);
  });

  it('atingeLimiar aceita resíduos de arredondamento', () => {
    expect(atingeLimiar(4.999999999999998, 5, 1e-9)).toBe(true);
    expect(atingeLimiar(4.99, 5, 1e-9)).toBe(false);
    expect(atingeLimiar(5.1, 5, 1e-9)).toBe(true);
  });

  it('variacaoPct é null com base zero', () => {
    expect(variacaoPct(110, 100)).toBeCloseTo(10);
    expect(variacaoPct(-50, -100)).toBeCloseTo(50);
    expect(variacaoPct(5, 0)).toBeNull();
  });
});
