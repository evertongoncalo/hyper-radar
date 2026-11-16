import { describe, expect, it } from 'vitest';
import {
  ATIVO,
  CARTEIRA_A,
  CARTEIRA_B,
  CARTEIRA_C,
  posicao,
  snapshot,
  T0,
} from './__testes__/construtores';
import { agruparZonasLiquidacao, calcularAgregados, calcularVariacao } from './agregados';

const D = '0x' + 'd'.repeat(40);

/** Ciclo misto: 2 longs, 1 short, 1 sem posição. */
function cicloMisto() {
  return [
    snapshot(T0, posicao('long', 10, { entryPx: 90, leverage: 10, liquidationPx: 80 }), {
      carteira: CARTEIRA_A,
    }),
    snapshot(T0 + 5, posicao('long', 30, { entryPx: 110, leverage: 2, liquidationPx: 60 }), {
      carteira: CARTEIRA_B,
    }),
    snapshot(T0 + 3, posicao('short', 20, { entryPx: 105, leverage: 5, liquidationPx: 125 }), {
      carteira: CARTEIRA_C,
    }),
    snapshot(T0 + 1, null, { carteira: D }),
  ];
}

describe('calcularAgregados', () => {
  it('carteiras mistas', () => {
    const a = calcularAgregados(ATIVO, cicloMisto());
    expect(a).toMatchObject({
      ativo: ATIVO,
      instante: T0 + 5,
      precoReferencia: 100,
      totalCarteiras: 4,
      carteirasSemPosicao: 1,
      netUsd: 2_000,
      entidadesComHedge: 0,
    });
    expect(a.long).toEqual({
      carteiras: 2,
      tamanho: 40,
      notionalUsd: 4_000,
      entradaMedia: 105, // (90×10 + 110×30) / 40
      alavancagemMedia: 4, // (10×1000 + 2×3000) / 4000
    });
    expect(a.short).toEqual({
      carteiras: 1,
      tamanho: 20,
      notionalUsd: 2_000,
      entradaMedia: 105,
      alavancagemMedia: 5,
    });
    // (10×1000 + 2×3000 + 5×2000) / 6000
    expect(a.alavancagemMedia).toBeCloseTo(26_000 / 6_000);
  });

  it('zonas de liquidação ordenadas por preço, com acumulado para fora do preço', () => {
    const extra = snapshot(T0, posicao('long', 5, { liquidationPx: 80 }), {
      carteira: '0x' + 'e'.repeat(40),
    });
    const a = calcularAgregados(ATIVO, [...cicloMisto(), extra]);
    expect(
      a.zonasLiquidacao.map((z) => [
        z.preco,
        z.lado,
        z.notional,
        z.notionalAcumulado,
        z.distanciaPct,
      ]),
    ).toEqual([
      [60, 'long', 3_000, 4_500, -40],
      [80, 'long', 1_500, 1_500, -20],
      [125, 'short', 2_000, 2_000, 25],
    ]);
    expect(a.zonasLiquidacao[1]!.carteiras).toEqual([CARTEIRA_A, '0x' + 'e'.repeat(40)]);
  });

  it('zero carteiras', () => {
    const a = calcularAgregados(ATIVO, []);
    expect(a).toEqual({
      ativo: ATIVO,
      instante: null,
      precoReferencia: null,
      totalCarteiras: 0,
      carteirasSemPosicao: 0,
      long: {
        carteiras: 0,
        tamanho: 0,
        notionalUsd: 0,
        entradaMedia: null,
        alavancagemMedia: null,
      },
      short: {
        carteiras: 0,
        tamanho: 0,
        notionalUsd: 0,
        entradaMedia: null,
        alavancagemMedia: null,
      },
      netUsd: 0,
      alavancagemMedia: null,
      zonasLiquidacao: [],
      entidades: [],
      entidadesComHedge: 0,
    });
  });

  it('só carteiras sem posição', () => {
    const a = calcularAgregados(ATIVO, [snapshot(T0, null)]);
    expect(a).toMatchObject({ carteirasSemPosicao: 1, alavancagemMedia: null, netUsd: 0 });
    expect(a.entidades).toEqual([
      {
        entidade: CARTEIRA_A,
        carteiras: [CARTEIRA_A],
        longUsd: 0,
        shortUsd: 0,
        netUsd: 0,
        hedgeInterno: false,
        notionalHedgeado: 0,
      },
    ]);
  });

  it('preço de referência: mediana (par) ou explícito; ignora preços inválidos', () => {
    const lista = [100, 102, 0, 104, 106].map((px, i) =>
      snapshot(T0, null, { carteira: `0x${String(i).repeat(40)}`, precoMercado: px }),
    );
    expect(calcularAgregados(ATIVO, lista).precoReferencia).toBe(103);
    expect(calcularAgregados(ATIVO, lista, { precoReferencia: 99 }).precoReferencia).toBe(99);
  });

  it('agrupamento por entidade com hedge interno', () => {
    const a = calcularAgregados(ATIVO, cicloMisto(), {
      entidades: { [CARTEIRA_A.toUpperCase()]: 'Baleia X', [CARTEIRA_C]: 'Baleia X' },
    });
    expect(a.entidades).toEqual([
      {
        entidade: CARTEIRA_B,
        carteiras: [CARTEIRA_B],
        longUsd: 3_000,
        shortUsd: 0,
        netUsd: 3_000,
        hedgeInterno: false,
        notionalHedgeado: 0,
      },
      {
        entidade: D,
        carteiras: [D],
        longUsd: 0,
        shortUsd: 0,
        netUsd: 0,
        hedgeInterno: false,
        notionalHedgeado: 0,
      },
      {
        entidade: 'Baleia X',
        carteiras: [CARTEIRA_A, CARTEIRA_C],
        longUsd: 1_000,
        shortUsd: 2_000,
        netUsd: -1_000,
        hedgeInterno: true,
        notionalHedgeado: 1_000,
      },
    ]);
    expect(a.entidadesComHedge).toBe(1);
  });

  it('rejeita ativo diferente e carteiras repetidas', () => {
    expect(() => calcularAgregados('ETH', cicloMisto())).toThrow(/agregado de ETH/);
    expect(() =>
      calcularAgregados(ATIVO, [
        snapshot(T0, null),
        snapshot(T0, null, { carteira: CARTEIRA_A.toUpperCase() }),
      ]),
    ).toThrow(/repetida/);
  });
});

describe('agruparZonasLiquidacao', () => {
  it('agrupa por buckets percentuais de distância', () => {
    const a = calcularAgregados(ATIVO, cicloMisto());
    expect(agruparZonasLiquidacao(a.zonasLiquidacao, 25)).toEqual([
      {
        inicioPct: -50,
        fimPct: -25,
        notionalLong: 3_000,
        notionalShort: 0,
        notional: 3_000,
        carteiras: 1,
      },
      {
        inicioPct: -25,
        fimPct: 0,
        notionalLong: 1_000,
        notionalShort: 0,
        notional: 1_000,
        carteiras: 1,
      },
      {
        inicioPct: 25,
        fimPct: 50,
        notionalLong: 0,
        notionalShort: 2_000,
        notional: 2_000,
        carteiras: 1,
      },
    ]);
    expect(agruparZonasLiquidacao(a.zonasLiquidacao, 100)).toEqual([
      {
        inicioPct: -100,
        fimPct: 0,
        notionalLong: 4_000,
        notionalShort: 0,
        notional: 4_000,
        carteiras: 2,
      },
      {
        inicioPct: 0,
        fimPct: 100,
        notionalLong: 0,
        notionalShort: 2_000,
        notional: 2_000,
        carteiras: 1,
      },
    ]);
  });

  it('ruído de arredondamento não muda de bucket; bucket inválido é rejeitado', () => {
    const zona = {
      preco: 1,
      lado: 'short' as const,
      notional: 1,
      carteiras: [CARTEIRA_A],
      distanciaPct: (0.1 + 0.2) * 10, // 3.0000000000000004
      notionalAcumulado: 1,
    };
    expect(agruparZonasLiquidacao([zona], 1)[0]).toMatchObject({ inicioPct: 3, fimPct: 4 });
    expect(agruparZonasLiquidacao([], 1)).toEqual([]);
    expect(() => agruparZonasLiquidacao([zona], 0)).toThrow(/positivo/);
  });
});

describe('calcularVariacao', () => {
  it('variação face a um agregado passado', () => {
    const passado = calcularAgregados(ATIVO, cicloMisto());
    const atualLista = cicloMisto();
    atualLista[2] = snapshot(T0 + 3_600_000, posicao('short', 60, { entryPx: 100, leverage: 5 }), {
      carteira: CARTEIRA_C,
      precoMercado: 100,
    });
    const atual = calcularAgregados(ATIVO, atualLista);
    const v = calcularVariacao(atual, passado);
    expect(v).toMatchObject({
      intervaloMs: 3_600_000 - 5,
      netUsd: { absoluta: -4_000, pct: -200 },
      longUsd: { absoluta: 0, pct: 0 },
      shortUsd: { absoluta: 4_000, pct: 200 },
      carteirasLong: 0,
      carteirasShort: 0,
      entradaMediaLong: { absoluta: 0, pct: 0 },
      precoReferencia: { absoluta: 0, pct: 0 },
    });
    expect(v!.entradaMediaShort!.absoluta).toBeCloseTo(-5);
    expect(v!.alavancagemMedia).not.toBeNull();
  });

  it('sem passado ⇒ null; valores nulos ou base zero tratados', () => {
    const vazio = calcularAgregados(ATIVO, []);
    const misto = calcularAgregados(ATIVO, cicloMisto());
    expect(calcularVariacao(misto, null)).toBeNull();
    const v = calcularVariacao(misto, vazio)!;
    expect(v.intervaloMs).toBeNull();
    expect(v.netUsd).toEqual({ absoluta: 2_000, pct: null });
    expect(v.carteirasLong).toBe(2);
    expect(v.entradaMediaLong).toBeNull();
    expect(v.alavancagemMedia).toBeNull();
    expect(v.precoReferencia).toBeNull();
  });

  it('rejeita ativos diferentes', () => {
    expect(() =>
      calcularVariacao(calcularAgregados(ATIVO, []), calcularAgregados('ETH', [])),
    ).toThrow(/ativos diferentes/);
  });
});
