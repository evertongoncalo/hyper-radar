import { AVISO_LEGAL, sugestaoProporcionalSchema } from '@hyper-radar/shared';
import { describe, expect, it } from 'vitest';
import {
  arredondarPreco,
  arredondarTamanho,
  calcularSugestao,
  casasDecimaisPreco,
  estimarLiquidacaoIsolada,
  type EntradaSugestao,
  type PosicaoBaleia,
} from './calculo';

/*
 * Casos conferidos à mão. Base: capital 1000 USD, alavancagem máx. 10x, risco 2 % (20 USD);
 * baleia long com accountValue 100 000, margem 10 000 (10 %), 5x, entrada 100.
 */

const posLong: PosicaoBaleia = {
  lado: 'long',
  tamanho: 500,
  entryPx: 100,
  alavancagem: 5,
  tipoMargem: 'isolated',
  marginUsed: 10_000,
  notional: 50_000,
  liquidationPx: 80,
};

function entrada(
  extra: Partial<EntradaSugestao> = {},
  baleia: Partial<EntradaSugestao['baleia']> = {},
): EntradaSugestao {
  return {
    definicoes: { capitalUsd: 1000, alavancagemMaxima: 10, riscoPorOperacaoPct: 2 },
    baleia: {
      posicao: posLong,
      accountValue: 100_000,
      accountValueRepresentativo: true,
      modoConta: null,
      protecoes: [],
      ...baleia,
    },
    precoAtual: 100,
    ativo: { szDecimals: 2, maxLeverage: 20 },
    entidade: { nome: null, ladosOutrasCarteiras: [] },
    frescura: null,
    ...extra,
  };
}

const codigos = (r: ReturnType<typeof calcularSugestao>) => r.avisos.map((a) => a.codigo);
const SL_TP = [
  { tipo: 'SL' as const, triggerPx: 95 },
  { tipo: 'TP' as const, triggerPx: 110 },
];

/** Todos os números do resultado (recursivamente) são finitos. */
function todosFinitos(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(todosFinitos);
  if (v && typeof v === 'object') return Object.values(v).every(todosFinitos);
  return true;
}

describe('arredondamentos (regras oficiais de tick e lot size)', () => {
  it.each([
    [1.23456, 3, 1.234],
    [0.3 / 0.1, 0, 3],
    [0.999, 0, 0],
    [4.8543689, 2, 4.85],
    [-1, 2, 0],
    [Number.NaN, 2, 0],
    [Number.POSITIVE_INFINITY, 2, 0],
  ])('tamanho %d com szDecimals %d → %d (sempre para baixo)', (t, sz, esperado) => {
    expect(arredondarTamanho(t, sz)).toBe(esperado);
  });

  it.each([
    [1234.56, 0, 1234.6], // 5 algarismos significativos
    [123456.7, 0, 123457], // inteiros sempre válidos
    [0.00123456, 0, 0.001235], // máx. 6 casas
    [0.0123456, 1, 0.01235], // máx. 6 − 1 = 5 casas
    [97.850000001, 2, 97.85],
    [9.99996, 0, 10],
  ])('preço %d com szDecimals %d → %d', (p, sz, esperado) => {
    expect(arredondarPreco(p, sz)).toBe(esperado);
  });

  it('preço inválido ou que arredonda a 0 → null', () => {
    expect(arredondarPreco(0, 2)).toBeNull();
    expect(arredondarPreco(-5, 2)).toBeNull();
    expect(arredondarPreco(1e-9, 0)).toBeNull();
  });

  it('casas decimais nunca negativas (szDecimals > 6)', () => {
    expect(casasDecimaisPreco(0.5, 8)).toBe(0);
  });
});

describe('liquidação estimada (isolada)', () => {
  it('long: (P − margem/s)/(1 − l) com l = 1/(2 × maxLeverage)', () => {
    // margem 100, 5 unidades a 100, l = 0,025 → 100 − 87,5/5/0,975 = 82,0513
    const liq = estimarLiquidacaoIsolada({
      lado: 'long',
      precoEntrada: 100,
      tamanho: 5,
      margem: 100,
      maxLeverageAtivo: 20,
    });
    expect(liq).toBeCloseTo(82.051282, 5);
  });

  it('short: (P + margem/s)/(1 + l)', () => {
    // margem 40, 2 unidades a 200 → 200 + 30/2/1,025 = 214,6341
    const liq = estimarLiquidacaoIsolada({
      lado: 'short',
      precoEntrada: 200,
      tamanho: 2,
      margem: 40,
      maxLeverageAtivo: 20,
    });
    expect(liq).toBeCloseTo(214.634146, 5);
  });

  it('long a 1x não tem liquidação; entradas inválidas → null', () => {
    const base = {
      lado: 'long' as const,
      precoEntrada: 100,
      tamanho: 1,
      margem: 100,
      maxLeverageAtivo: 20,
    };
    expect(estimarLiquidacaoIsolada(base)).toBeNull();
    expect(estimarLiquidacaoIsolada({ ...base, tamanho: 0 })).toBeNull();
    expect(estimarLiquidacaoIsolada({ ...base, maxLeverageAtivo: Number.NaN })).toBeNull();
  });
});

describe('calcularSugestao — long', () => {
  it('sem SL/TP: replica % de margem e alavancagem; avisa fortemente e usa a liquidação', () => {
    const r = calcularSugestao(entrada());
    expect(sugestaoProporcionalSchema.parse(r)).toBeTruthy();
    expect(r).toMatchObject({ viavel: true, motivo: null, lado: 'long', fator: 0.01 });
    expect(r.baleia?.percentagemMargemPct).toBe(10);
    expect(r.posicao).toMatchObject({
      alavancagem: 5,
      alavancagemLimitada: false,
      tamanho: 5,
      notionalUsd: 500,
      margemUsd: 100,
      stopLoss: null,
      takeProfit: null,
      riscoMaximoUsd: 20,
      perdaAteStopUsd: null,
      limitadoPeloRisco: false,
    });
    expect(r.posicao?.liquidacaoEstimada).toBeCloseTo(82.051282, 5);
    expect(r.posicao?.perdaAteLiquidacaoUsd).toBeCloseTo(89.74359, 4);
    expect(r.rr).toBeNull();
    expect(codigos(r)).toEqual(
      expect.arrayContaining([
        'SO_UMA_PERNA',
        'SEM_STOP_LOSS',
        'RISCO_ACIMA_DO_MAXIMO',
        'SEM_TAKE_PROFIT',
        'LIQUIDACAO_ESTIMADA',
      ]),
    );
    expect(r.avisos.find((a) => a.codigo === 'SEM_STOP_LOSS')?.nivel).toBe('critico');
    expect(r.avisoLegal).toBe(AVISO_LEGAL);
  });

  it('com SL/TP: reaplica % ao preço atual e limita o tamanho pelo risco', () => {
    // SL −5 % → 95; perda 5 × 5 = 25 > 20 → tamanho 20/5 = 4
    const r = calcularSugestao(entrada({}, { protecoes: SL_TP }));
    expect(r.viavel).toBe(true);
    expect(r.posicao).toMatchObject({
      tamanho: 4,
      notionalUsd: 400,
      margemUsd: 80,
      stopLoss: { precoBaleia: 95, distanciaPct: -5, preco: 95 },
      takeProfit: { precoBaleia: 110, distanciaPct: 10, preco: 110 },
      perdaAteStopUsd: 20,
      perdaAteLiquidacaoUsd: null,
      limitadoPeloRisco: true,
    });
    expect(r.rr).toEqual({ sugerido: 2, baleia: 2, aosNiveisDaBaleia: 2 });
    expect(r.entradaTardia).toEqual({ variacaoFavoravelPct: 0, limiarPct: 2, tardia: false });
    expect(codigos(r)).toContain('TAMANHO_LIMITADO_PELO_RISCO');
    expect(codigos(r)).not.toContain('SEM_STOP_LOSS');
  });

  it('SL dentro do risco: não limita', () => {
    const r = calcularSugestao(
      entrada(
        { definicoes: { capitalUsd: 1000, alavancagemMaxima: 10, riscoPorOperacaoPct: 5 } },
        { protecoes: SL_TP },
      ),
    );
    expect(r.posicao).toMatchObject({ tamanho: 5, perdaAteStopUsd: 25, limitadoPeloRisco: false });
  });

  it('entrada tardia (preço +3 %): sinaliza, reaplica e piora o R:R aos níveis da baleia', () => {
    // SL 103 × 0,95 = 97,85; TP 103 × 1,1 = 113,3; tamanho 500/103 = 4,85 → risco 4,85 × 5,15 > 20
    // → 20/5,15 = 3,883 → 3,88. Níveis absolutos: (110 − 103)/(103 − 95) = 0,875.
    const r = calcularSugestao(entrada({ precoAtual: 103 }, { protecoes: SL_TP }));
    expect(r.posicao?.stopLoss?.preco).toBe(97.85);
    expect(r.posicao?.takeProfit?.preco).toBe(113.3);
    expect(r.posicao?.tamanho).toBe(3.88);
    expect(r.entradaTardia?.tardia).toBe(true);
    expect(r.entradaTardia?.variacaoFavoravelPct).toBeCloseTo(3, 10);
    expect(r.rr?.sugerido).toBeCloseTo(2, 6);
    expect(r.rr?.baleia).toBeCloseTo(2, 10);
    expect(r.rr?.aosNiveisDaBaleia).toBeCloseTo(0.875, 10);
    expect(codigos(r)).toContain('ENTRADA_TARDIA');
  });

  it('preço contra a baleia (−6 %): não é tardia; R:R aos níveis da baleia sem risco → null', () => {
    const r = calcularSugestao(entrada({ precoAtual: 94 }, { protecoes: SL_TP }));
    expect(r.entradaTardia?.tardia).toBe(false);
    expect(codigos(r)).toContain('PRECO_CONTRA_BALEIA');
    expect(codigos(r)).not.toContain('ENTRADA_TARDIA');
    expect(r.rr?.aosNiveisDaBaleia).toBeNull();
  });

  it('limiar configurável', () => {
    const r = calcularSugestao(entrada({ precoAtual: 103, opcoes: { limiarEntradaTardiaPct: 5 } }));
    expect(r.entradaTardia).toMatchObject({ limiarPct: 5, tardia: false });
  });

  it('vários SL: usa o mais próximo da entrada; SL do lado do lucro e TP do lado da perda são ignorados', () => {
    const r = calcularSugestao(
      entrada(
        {},
        {
          protecoes: [
            { tipo: 'SL', triggerPx: 90 },
            { tipo: 'SL', triggerPx: 95 },
            { tipo: 'SL', triggerPx: 105 },
            { tipo: 'TP', triggerPx: 99 },
          ],
        },
      ),
    );
    expect(r.posicao?.stopLoss?.preco).toBe(95);
    expect(r.posicao?.takeProfit).toBeNull();
    expect(codigos(r)).toEqual(
      expect.arrayContaining(['SL_NAO_REAPLICAVEL', 'TP_NAO_REAPLICAVEL', 'SEM_TAKE_PROFIT']),
    );
    expect(r.rr).toBeNull();
  });

  it('só SL do lado do lucro → tratado como sem SL', () => {
    const r = calcularSugestao(entrada({}, { protecoes: [{ tipo: 'SL', triggerPx: 105 }] }));
    expect(r.posicao?.stopLoss).toBeNull();
    expect(codigos(r)).toEqual(expect.arrayContaining(['SL_NAO_REAPLICAVEL', 'SEM_STOP_LOSS']));
  });
});

describe('calcularSugestao — short', () => {
  const posShort: PosicaoBaleia = {
    lado: 'short',
    tamanho: 250,
    entryPx: 200,
    alavancagem: 10,
    tipoMargem: 'isolated',
    marginUsed: 5_000,
    notional: 50_000,
    liquidationPx: 218,
  };
  const protecoes = [
    { tipo: 'SL' as const, triggerPx: 210 },
    { tipo: 'TP' as const, triggerPx: 180 },
  ];
  const curta = (precoAtual: number) =>
    calcularSugestao(
      entrada(
        { precoAtual, ativo: { szDecimals: 1, maxLeverage: 20 } },
        { posicao: posShort, accountValue: 50_000, protecoes },
      ),
    );

  it('SL +5 %, TP −10 %: limita pelo risco (perda 10/unidade → 2 unidades)', () => {
    const r = curta(200);
    expect(r).toMatchObject({ viavel: true, lado: 'short', fator: 0.02 });
    expect(r.posicao).toMatchObject({
      alavancagem: 10,
      tamanho: 2,
      notionalUsd: 400,
      margemUsd: 40,
      stopLoss: { preco: 210, distanciaPct: 5 },
      takeProfit: { preco: 180, distanciaPct: -10 },
      perdaAteStopUsd: 20,
      limitadoPeloRisco: true,
    });
    expect(r.posicao?.liquidacaoEstimada).toBeCloseTo(214.634146, 5);
    expect(r.rr).toEqual({ sugerido: 2, baleia: 2, aosNiveisDaBaleia: 2 });
  });

  it('entrada tardia num short: preço desceu 2,5 %', () => {
    const r = curta(195);
    expect(r.entradaTardia?.variacaoFavoravelPct).toBeCloseTo(2.5, 10);
    expect(r.entradaTardia?.tardia).toBe(true);
    // (195 − 180)/(210 − 195) = 1
    expect(r.rr?.aosNiveisDaBaleia).toBeCloseTo(1, 10);
  });

  it('preço subiu 3 % (contra o short) e exatamente no limiar (2 %) não é tardia', () => {
    expect(codigos(curta(206))).toContain('PRECO_CONTRA_BALEIA');
    expect(curta(196).entradaTardia?.tardia).toBe(false);
  });
});

describe('calcularSugestao — limites e avisos', () => {
  it.each([
    [10, 20, 'das suas definições', 10],
    [100, 20, 'do ativo', 20],
  ])(
    'baleia a 50x, utilizador %dx, ativo %dx → limitada (%s)',
    (maxUtil, maxAtivo, origem, esperado) => {
      const r = calcularSugestao(
        entrada(
          {
            definicoes: { capitalUsd: 1000, alavancagemMaxima: maxUtil, riscoPorOperacaoPct: 2 },
            ativo: { szDecimals: 2, maxLeverage: maxAtivo },
          },
          { posicao: { ...posLong, alavancagem: 50 } },
        ),
      );
      expect(r.posicao).toMatchObject({ alavancagem: esperado, alavancagemLimitada: true });
      // margem 10 % de 1000 = 100 × alavancagem
      expect(r.posicao?.notionalUsd).toBeCloseTo(100 * esperado, 8);
      const aviso = r.avisos.find((a) => a.codigo === 'ALAVANCAGEM_LIMITADA');
      expect(aviso?.mensagem).toContain(origem);
    },
  );

  it('abaixo da ordem mínima: inviável, sem arredondar para cima, mas com os valores', () => {
    // capital 50 → margem 10 % = 5 USD a 1x → notional 5 < 10.
    const r = calcularSugestao(
      entrada({ definicoes: { capitalUsd: 50, alavancagemMaxima: 1, riscoPorOperacaoPct: 2 } }),
    );
    expect(r.viavel).toBe(false);
    expect(r.motivo?.codigo).toBe('ABAIXO_ORDEM_MINIMA');
    expect(r.posicao).toMatchObject({ tamanho: 0.05, notionalUsd: 5, alavancagem: 1 });
    // A 1x num long não há liquidação: a perda máxima é a margem.
    expect(r.posicao?.liquidacaoEstimada).toBeNull();
    expect(r.posicao?.perdaAteLiquidacaoUsd).toBe(5);
  });

  it('ordem mínima configurável e limite exato (10 USD) é viável', () => {
    const base = {
      definicoes: { capitalUsd: 100, alavancagemMaxima: 1, riscoPorOperacaoPct: 100 },
    };
    expect(calcularSugestao(entrada(base)).viavel).toBe(true);
    expect(calcularSugestao(entrada({ ...base, opcoes: { ordemMinimaUsd: 11 } })).viavel).toBe(
      false,
    );
  });

  it('limitado pelo risco até ficar abaixo do mínimo → inviável', () => {
    const r = calcularSugestao(
      entrada(
        { definicoes: { capitalUsd: 1000, alavancagemMaxima: 10, riscoPorOperacaoPct: 0.1 } },
        { protecoes: SL_TP },
      ),
    );
    // risco 1 USD / 5 por unidade = 0,2 unidades = 20 USD ≥ 10: viável; com 0,04 % já não.
    expect(r).toMatchObject({ viavel: true, posicao: { tamanho: 0.2, limitadoPeloRisco: true } });
    const r2 = calcularSugestao(
      entrada(
        { definicoes: { capitalUsd: 1000, alavancagemMaxima: 10, riscoPorOperacaoPct: 0.04 } },
        { protecoes: SL_TP },
      ),
    );
    expect(r2.motivo?.codigo).toBe('ABAIXO_ORDEM_MINIMA');
  });

  it('accountValue não representativo: aviso crítico mas calcula', () => {
    const r = calcularSugestao(
      entrada({}, { accountValueRepresentativo: false, modoConta: 'unifiedAccount' }),
    );
    expect(r.viavel).toBe(true);
    expect(r.baleia).toMatchObject({
      accountValueRepresentativo: false,
      modoConta: 'unifiedAccount',
    });
    expect(r.avisos.find((a) => a.codigo === 'ACCOUNT_VALUE_NAO_REPRESENTATIVO')?.nivel).toBe(
      'critico',
    );
  });

  it('hedge: outra carteira da mesma entidade no lado oposto', () => {
    const hedge = calcularSugestao(
      entrada({ entidade: { nome: 'Fundo X', ladosOutrasCarteiras: ['long', 'short'] } }),
    );
    expect(hedge.avisos.find((a) => a.codigo === 'PROVAVEL_HEDGE')?.mensagem).toContain('Fundo X');
    const mesmoLado = calcularSugestao(
      entrada({ entidade: { nome: 'Fundo X', ladosOutrasCarteiras: ['long'] } }),
    );
    expect(codigos(mesmoLado)).not.toContain('PROVAVEL_HEDGE');
  });

  it('margem cruzada e margem acima do accountValue', () => {
    const r = calcularSugestao(
      entrada({}, { posicao: { ...posLong, tipoMargem: 'cross', marginUsed: 150_000 } }),
    );
    expect(codigos(r)).toEqual(
      expect.arrayContaining(['MARGEM_CRUZADA_BALEIA', 'MARGEM_LIMITADA_AO_CAPITAL']),
    );
    expect(r.posicao?.margemUsd).toBe(1000);
  });

  it.each([
    [{ instanteSnapshotMs: 0, agoraMs: 60_000, intervaloRecolhaSegundos: 60 }, false],
    [{ instanteSnapshotMs: 0, agoraMs: 121_000, intervaloRecolhaSegundos: 60 }, true],
    [
      { instanteSnapshotMs: 0, agoraMs: 1_000, intervaloRecolhaSegundos: 60, leituraFalhou: true },
      true,
    ],
    [{ instanteSnapshotMs: Number.NaN, agoraMs: 1_000, intervaloRecolhaSegundos: 60 }, true],
  ])('frescura %j → desatualizado %s', (frescura, esperado) => {
    expect(codigos(calcularSugestao(entrada({ frescura }))).includes('DADOS_DESATUALIZADOS')).toBe(
      esperado,
    );
  });

  it('baleia sem posição', () => {
    const r = calcularSugestao(entrada({}, { posicao: null }));
    expect(r).toMatchObject({
      viavel: false,
      motivo: { codigo: 'SEM_POSICAO' },
      posicao: null,
      lado: null,
    });
    expect(codigos(r)).toContain('SEM_POSICAO');
  });
});

describe('calcularSugestao — valores degenerados (nunca NaN/Infinity)', () => {
  const casos: [string, EntradaSugestao, string][] = [
    [
      'capital 0',
      entrada({ definicoes: { capitalUsd: 0, alavancagemMaxima: 10, riscoPorOperacaoPct: 2 } }),
      'CAPITAL_INVALIDO',
    ],
    [
      'capital NaN',
      entrada({
        definicoes: { capitalUsd: Number.NaN, alavancagemMaxima: 10, riscoPorOperacaoPct: 2 },
      }),
      'CAPITAL_INVALIDO',
    ],
    [
      'alavancagem 0',
      entrada({ definicoes: { capitalUsd: 1000, alavancagemMaxima: 0, riscoPorOperacaoPct: 2 } }),
      'DEFINICOES_INVALIDAS',
    ],
    [
      'risco 0',
      entrada({ definicoes: { capitalUsd: 1000, alavancagemMaxima: 10, riscoPorOperacaoPct: 0 } }),
      'DEFINICOES_INVALIDAS',
    ],
    [
      'risco 150',
      entrada({
        definicoes: { capitalUsd: 1000, alavancagemMaxima: 10, riscoPorOperacaoPct: 150 },
      }),
      'DEFINICOES_INVALIDAS',
    ],
    ['accountValue 0', entrada({}, { accountValue: 0 }), 'ACCOUNT_VALUE_INVALIDO'],
    ['accountValue negativo', entrada({}, { accountValue: -5 }), 'ACCOUNT_VALUE_INVALIDO'],
    ['accountValue subnormal', entrada({}, { accountValue: 1e-320 }), 'ACCOUNT_VALUE_INVALIDO'],
    ['preço 0', entrada({ precoAtual: 0 }), 'PRECO_INVALIDO'],
    ['preço NaN', entrada({ precoAtual: Number.NaN }), 'PRECO_INVALIDO'],
    ['entryPx 0', entrada({}, { posicao: { ...posLong, entryPx: 0 } }), 'DADOS_POSICAO_INVALIDOS'],
    ['tamanho 0', entrada({}, { posicao: { ...posLong, tamanho: 0 } }), 'DADOS_POSICAO_INVALIDOS'],
    [
      'alavancagem baleia 0',
      entrada({}, { posicao: { ...posLong, alavancagem: 0 } }),
      'DADOS_POSICAO_INVALIDOS',
    ],
    [
      'margem negativa',
      entrada({}, { posicao: { ...posLong, marginUsed: -1 } }),
      'DADOS_POSICAO_INVALIDOS',
    ],
    [
      'notional infinito',
      entrada({}, { posicao: { ...posLong, notional: Number.POSITIVE_INFINITY } }),
      'DADOS_POSICAO_INVALIDOS',
    ],
    ['sem metadados', entrada({ ativo: null }), 'METADADOS_INVALIDOS'],
    [
      'szDecimals fracionário',
      entrada({ ativo: { szDecimals: 1.5, maxLeverage: 20 } }),
      'METADADOS_INVALIDOS',
    ],
    [
      'szDecimals negativo',
      entrada({ ativo: { szDecimals: -1, maxLeverage: 20 } }),
      'METADADOS_INVALIDOS',
    ],
    ['szDecimals 9', entrada({ ativo: { szDecimals: 9, maxLeverage: 20 } }), 'METADADOS_INVALIDOS'],
    ['maxLeverage 0', entrada({ ativo: { szDecimals: 2, maxLeverage: 0 } }), 'METADADOS_INVALIDOS'],
    ['margem 0', entrada({}, { posicao: { ...posLong, marginUsed: 0 } }), 'ABAIXO_ORDEM_MINIMA'],
  ];

  it.each(casos)('%s → inviável (%s)', (_, e, motivo) => {
    const r = calcularSugestao(e);
    expect(r.viavel).toBe(false);
    expect(r.motivo?.codigo).toBe(motivo);
    expect(todosFinitos(r)).toBe(true);
    expect(sugestaoProporcionalSchema.safeParse(r).success).toBe(true);
    expect(r.avisoLegal).toBe(AVISO_LEGAL);
  });

  it('liquidationPx da baleia inválido passa a null; SL com trigger inválido é ignorado', () => {
    const r = calcularSugestao(
      entrada(
        {},
        {
          posicao: { ...posLong, liquidationPx: Number.NaN },
          protecoes: [{ tipo: 'SL', triggerPx: Number.NaN }],
        },
      ),
    );
    expect(r.baleia?.liquidationPx).toBeNull();
    expect(r.posicao?.stopLoss).toBeNull();
    expect(todosFinitos(r)).toBe(true);
  });
});
