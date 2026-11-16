import { describe, expect, it } from 'vitest';
import { CARTEIRA_B, posicao, protecao, snapshot, T0 } from './__testes__/construtores';
import { CONFIG_OMISSAO as cfg } from './config';
import {
  avaliarLiqNear,
  calcularDiff,
  diffPosicao,
  diffProtecoes,
  distanciaLiquidacaoPct,
} from './diff';

describe('diffPosicao', () => {
  const long10 = posicao('long', 10);
  it.each([
    ['sem posição em ambos', null, null, null],
    ['abertura', null, long10, 'OPENED'],
    ['fecho', long10, null, 'CLOSED'],
    ['inversão long→short', long10, posicao('short', 4), 'FLIPPED'],
    ['inversão short→long', posicao('short', 4), long10, 'FLIPPED'],
    ['aumento', long10, posicao('long', 12), 'INCREASED'],
    ['redução', long10, posicao('long', 3), 'REDUCED'],
    ['igual', long10, posicao('long', 10), null],
    [
      'igual a menos de ruído (0.1+0.2 vs 0.3)',
      posicao('long', 0.1 + 0.2),
      posicao('long', 0.3),
      null,
    ],
  ])('%s', (_nome, a, b, esperado) => {
    expect(diffPosicao(a, b, cfg)?.tipo ?? null).toBe(esperado);
  });

  it('delta com sinal', () => {
    expect(diffPosicao(long10, posicao('long', 7.5), cfg)).toMatchObject({ delta: -2.5 });
  });
});

describe('diffProtecoes', () => {
  it('iguais (mesmo com oids diferentes e dentro da tolerância de preço) ⇒ null', () => {
    expect(
      diffProtecoes(
        [protecao('SL', 90, { oid: 1 }), protecao('TP', 120, { oid: 2 })],
        [protecao('TP', 120.05, { oid: 7 }), protecao('SL', 90.04, { oid: 8 })],
        cfg,
      ),
    ).toBeNull();
    expect(diffProtecoes([], [], cfg)).toBeNull();
  });

  it('SL movido', () => {
    const r = diffProtecoes([protecao('SL', 90)], [protecao('SL', 95)], cfg);
    expect(r?.movidas).toEqual([
      {
        tipo: 'SL',
        antes: { tipo: 'SL', triggerPx: 90, tamanho: null },
        depois: { tipo: 'SL', triggerPx: 95, tamanho: null },
      },
    ]);
    expect(r?.adicionadas).toEqual([]);
    expect(r?.removidas).toEqual([]);
  });

  it('movido acima da tolerância (0,1 %) conta', () => {
    expect(diffProtecoes([protecao('SL', 100)], [protecao('SL', 100.1)], cfg)).not.toBeNull();
  });

  it('TP adicionado e SL removido', () => {
    const r = diffProtecoes([protecao('SL', 90)], [protecao('TP', 120)], cfg);
    expect(r?.adicionadas).toEqual([{ tipo: 'TP', triggerPx: 120, tamanho: null }]);
    expect(r?.removidas).toEqual([{ tipo: 'SL', triggerPx: 90, tamanho: null }]);
    expect(r?.movidas).toEqual([]);
  });

  it('alteração de tamanho do SL é movimento; null ≠ tamanho explícito', () => {
    expect(
      diffProtecoes([protecao('SL', 90, { tamanho: 1 })], [protecao('SL', 90, { tamanho: 2 })], cfg)
        ?.movidas,
    ).toHaveLength(1);
    expect(
      diffProtecoes([protecao('SL', 90)], [protecao('SL', 90, { tamanho: 2 })], cfg)?.movidas,
    ).toHaveLength(1);
    expect(
      diffProtecoes(
        [protecao('SL', 90, { tamanho: 0.1 + 0.2 })],
        [protecao('SL', 90, { tamanho: 0.3 })],
        cfg,
      ),
    ).toBeNull();
  });

  it('dois SL → um SL movido e um removido (emparelhados por preço)', () => {
    const r = diffProtecoes(
      [protecao('SL', 80), protecao('SL', 90), protecao('TP', 130)],
      [protecao('SL', 85), protecao('TP', 130)],
      cfg,
    );
    expect(r?.movidas.map((m) => [m.antes.triggerPx, m.depois.triggerPx])).toEqual([[80, 85]]);
    expect(r?.removidas.map((p) => p.triggerPx)).toEqual([90]);
    expect(r?.antes).toHaveLength(3);
    expect(r?.depois).toHaveLength(2);
  });
});

describe('distanciaLiquidacaoPct', () => {
  it.each([
    ['long', 90, 100, 10],
    ['long', 101, 100, -1],
    ['short', 110, 100, 10],
    ['short', 95, 100, -5],
  ] as const)('%s liq %d preço %d ⇒ %d %%', (lado, liq, preco, esperado) => {
    expect(distanciaLiquidacaoPct(posicao(lado, 1, { liquidationPx: liq }), preco)).toBeCloseTo(
      esperado,
    );
  });

  it.each([
    ['sem posição', null, 100],
    ['liquidationPx nulo', posicao('long', 1), 100],
    ['liquidationPx 0', posicao('long', 1, { liquidationPx: 0 }), 100],
    ['preço inválido', posicao('long', 1, { liquidationPx: 90 }), 0],
  ])('%s ⇒ null', (_nome, p, preco) => {
    expect(distanciaLiquidacaoPct(p, preco)).toBeNull();
  });
});

describe('avaliarLiqNear (histerese 5 % / 7 %)', () => {
  it.each([
    [null, true, false, true],
    [null, false, false, true],
    [4.9, true, true, false],
    [4.9, false, false, false],
    [5, true, false, true],
    [6, false, false, false],
    [7, false, false, true],
    [-2, true, true, false],
  ])('distância %s, armado %s ⇒ dispara %s, armado %s', (d, armado, disparar, novo) => {
    expect(avaliarLiqNear(d, armado, cfg)).toEqual({ disparar, armado: novo });
  });
});

describe('calcularDiff', () => {
  const liq = (preco: number, armado?: boolean) =>
    calcularDiff(
      snapshot(T0, posicao('long', 10, { liquidationPx: 90 }), { precoMercado: 100 }),
      snapshot(T0 + 1, posicao('long', 10, { liquidationPx: 90 }), { precoMercado: preco }),
      cfg,
      armado,
    );

  it('linha de base: sem alterações, mas inicializa LIQ_NEAR', () => {
    const dentro = snapshot(T0, posicao('long', 10, { liquidationPx: 97 }));
    expect(calcularDiff(null, dentro, cfg)).toEqual({ alteracoes: [], liqArmado: false });
    expect(calcularDiff(null, snapshot(T0, null), cfg)).toEqual({
      alteracoes: [],
      liqArmado: true,
    });
  });

  it('agrupa alterações de posição, SL/TP e liquidação', () => {
    const r = calcularDiff(
      snapshot(T0, posicao('long', 10), { ordensProtecao: [protecao('SL', 80)] }),
      snapshot(T0 + 1, posicao('long', 20, { liquidationPx: 96 }), {
        ordensProtecao: [protecao('SL', 85)],
      }),
      cfg,
    );
    expect(r.alteracoes.map((a) => a.tipo)).toEqual(['INCREASED', 'SLTP_CHANGED', 'LIQ_NEAR']);
    expect(r.liqArmado).toBe(false);
    expect(r.alteracoes[2]).toMatchObject({
      liquidationPx: 96,
      precoMercado: 100,
      distanciaPct: 4,
    });
  });

  it('sem alterações ⇒ lista vazia', () => {
    expect(liq(100).alteracoes).toEqual([]);
  });

  it('sem estado de histerese: deriva-o do snapshot anterior', () => {
    expect(liq(94).alteracoes.map((a) => a.tipo)).toEqual(['LIQ_NEAR']);
    // Com histerese desarmada vinda do ciclo anterior, não volta a disparar.
    expect(liq(94, false).alteracoes).toEqual([]);
    expect(liq(94, false).liqArmado).toBe(false);
  });

  it('posição aberta/invertida rearma a histerese', () => {
    const r = calcularDiff(
      snapshot(T0, posicao('short', 10, { liquidationPx: 103 })),
      snapshot(T0 + 1, posicao('long', 10, { liquidationPx: 97 })),
      cfg,
      false,
    );
    expect(r.alteracoes.map((a) => a.tipo)).toEqual(['FLIPPED', 'LIQ_NEAR']);
  });

  it('rejeita snapshots de chaves diferentes ou fora de ordem', () => {
    expect(() =>
      calcularDiff(snapshot(T0, null), snapshot(T0, null, { carteira: CARTEIRA_B }), cfg),
    ).toThrow(/chaves diferentes/);
    expect(() =>
      calcularDiff(snapshot(T0, null), snapshot(T0, null, { ativo: 'ETH' }), cfg),
    ).toThrow(/chaves diferentes/);
    expect(() => calcularDiff(snapshot(T0 + 1, null), snapshot(T0, null), cfg)).toThrow(
      /posterior/,
    );
  });
});
