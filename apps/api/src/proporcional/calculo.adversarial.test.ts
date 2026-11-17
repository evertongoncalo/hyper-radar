import { readFileSync } from 'node:fs';
import { sugestaoProporcionalSchema } from '@hyper-radar/shared';
import { describe, expect, it } from 'vitest';
import {
  calcularSugestao,
  estimarLiquidacaoIsolada,
  type EntradaSugestao,
  type PosicaoBaleia,
  type ProtecaoBaleia,
} from './calculo';

/*
 * Revisão adversarial da sugestão proporcional (secção 7.1). Os valores esperados foram calculados
 * à mão a partir da especificação ANTES de correr o código; as contas estão em comentário.
 * Notação: l = 1/(2 × maxLeverage); liq long = (P − m/t)/(1 − l); liq short = (P + m/t)/(1 + l),
 * equivalente a `liq = P − lado × (m − t·P·l)/t/(1 − l × lado)` da documentação.
 */

const codigos = (r: ReturnType<typeof calcularSugestao>) => r.avisos.map((a) => a.codigo);

function caso(p: {
  capital: number;
  alavMax: number;
  risco: number;
  posicao: PosicaoBaleia;
  accountValue: number;
  protecoes?: ProtecaoBaleia[];
  preco: number;
  szDecimals: number;
  maxLeverage: number;
}): ReturnType<typeof calcularSugestao> {
  const r = calcularSugestao({
    definicoes: {
      capitalUsd: p.capital,
      alavancagemMaxima: p.alavMax,
      riscoPorOperacaoPct: p.risco,
    },
    baleia: {
      posicao: p.posicao,
      accountValue: p.accountValue,
      accountValueRepresentativo: true,
      modoConta: null,
      protecoes: p.protecoes ?? [],
    },
    precoAtual: p.preco,
    ativo: { szDecimals: p.szDecimals, maxLeverage: p.maxLeverage },
    entidade: { nome: null, ladosOutrasCarteiras: [] },
    frescura: null,
  });
  expect(sugestaoProporcionalSchema.safeParse(r).success).toBe(true);
  return r;
}

const pos = (
  p: Partial<PosicaoBaleia> & Pick<PosicaoBaleia, 'lado' | 'entryPx'>,
): PosicaoBaleia => ({
  tamanho: 1,
  alavancagem: 10,
  tipoMargem: 'isolated',
  marginUsed: 0,
  notional: 1,
  liquidationPx: null,
  ...p,
});

describe('casos conferidos à mão', () => {
  it('1. BTC long (sz 5), capital 1000, baleia 20x > utilizador 10x, sem SL/TP', () => {
    // fator = 1000/1e6; margem 10 % → 100 USD; alav = min(20, 10, 40) = 10 → notional 1000.
    // t = 1000/60000 = 0,016666… → para baixo a 5 casas = 0,01666; notional = 999,6; margem = 99,96.
    // l = 1/80 = 0,0125; m/t = 6000 → liq = (60000 − 6000)/0,9875 = 54683,5443038.
    // perda até liq = 0,01666 × 5316,4556962 = 88,5721519 > risco 20 → RISCO_ACIMA_DO_MAXIMO.
    const r = caso({
      capital: 1000,
      alavMax: 10,
      risco: 2,
      posicao: pos({ lado: 'long', entryPx: 60_000, alavancagem: 20, marginUsed: 100_000 }),
      accountValue: 1_000_000,
      preco: 60_000,
      szDecimals: 5,
      maxLeverage: 40,
    });
    expect(r.viavel).toBe(true);
    expect(r.lado).toBe('long');
    expect(r.posicao).toMatchObject({
      alavancagem: 10,
      alavancagemLimitada: true,
      tamanho: 0.01666,
    });
    expect(r.posicao?.notionalUsd).toBeCloseTo(999.6, 9);
    expect(r.posicao?.margemUsd).toBeCloseTo(99.96, 9);
    expect(r.posicao?.liquidacaoEstimada).toBeCloseTo(54683.5443038, 6);
    expect(r.posicao?.perdaAteLiquidacaoUsd).toBeCloseTo(88.5721519, 6);
    expect(codigos(r)).toEqual(
      expect.arrayContaining(['ALAVANCAGEM_LIMITADA', 'SEM_STOP_LOSS', 'RISCO_ACIMA_DO_MAXIMO']),
    );
  });

  it('2. BTC short (sz 5), capital 100, SL +2 % e TP −5 % reaplicados, dentro do risco', () => {
    // margem 10 % de 100 = 10; alav = min(40, 5, 40) = 5 → notional 50; t = 50/64000 = 0,00078125
    // → 0,00078; notional = 49,92 ≥ 10; margem = 9,984.
    // SL: (66300 − 65000)/65000 = +2 % → 64000 × 1,02 = 65280; TP: −5 % → 60800.
    // perda = 0,00078 × 1280 = 0,9984 ≤ 1 (1 %) → não limita. R:R = 3200/1280 = 2,5;
    // baleia 5/2 = 2,5; aos níveis da baleia (64000 − 61750)/(66300 − 64000) = 0,97826.
    // liq short: l = 1/80; (64000 + 12800)/1,0125 = 75851,8518519.
    // variação favorável = −(64000 − 65000)/65000 = 1,538 % ≤ 2 → nem tardia nem contra.
    const r = caso({
      capital: 100,
      alavMax: 5,
      risco: 1,
      posicao: pos({ lado: 'short', entryPx: 65_000, alavancagem: 40, marginUsed: 50_000 }),
      accountValue: 500_000,
      protecoes: [
        { tipo: 'SL', triggerPx: 66_300 },
        { tipo: 'TP', triggerPx: 61_750 },
      ],
      preco: 64_000,
      szDecimals: 5,
      maxLeverage: 40,
    });
    expect(r.viavel).toBe(true);
    expect(r.lado).toBe('short');
    expect(r.posicao).toMatchObject({ tamanho: 0.00078, alavancagem: 5, limitadoPeloRisco: false });
    expect(r.posicao?.stopLoss?.preco).toBe(65_280);
    expect(r.posicao?.takeProfit?.preco).toBe(60_800);
    expect(r.posicao?.notionalUsd).toBeCloseTo(49.92, 9);
    expect(r.posicao?.perdaAteStopUsd).toBeCloseTo(0.9984, 9);
    expect(r.posicao?.liquidacaoEstimada).toBeCloseTo(75851.8518519, 6);
    expect(r.rr?.sugerido).toBeCloseTo(2.5, 9);
    expect(r.rr?.baleia).toBeCloseTo(2.5, 9);
    expect(r.rr?.aosNiveisDaBaleia).toBeCloseTo(0.9782609, 6);
    expect(r.entradaTardia?.variacaoFavoravelPct).toBeCloseTo(1.5384615, 6);
    expect(codigos(r)).not.toContain('ENTRADA_TARDIA');
    expect(codigos(r)).not.toContain('PRECO_CONTRA_BALEIA');
  });

  it('3. HIP-3 xyz:NVDA (sz 3) long, margem 100 %, SL obriga a reduzir, preço contra a baleia', () => {
    // fixture clearinghouseState-xyz: av = marginUsed = 40806,214439 → 100 % → margem 1000; 5x.
    // SL 150: fração = −9,859/159,859 → 155,93 × 150/159,859 = 146,3133 → 2 casas (5 alg.) = 146,31.
    // t = 5000/155,93 = 32,0657 → 32,065; perda 32,065 × 9,62 = 308,47 > 20 → 20/9,62 = 2,07900
    // → 2,079; notional = 324,17847; perda até SL = 19,99998.
    // liq: l = 1/20; P × (1 − 1/5)/0,95 = 131,3094737. Variação = −3,929/159,859 = −2,4578 %.
    const r = caso({
      capital: 1000,
      alavMax: 10,
      risco: 2,
      posicao: pos({
        lado: 'long',
        entryPx: 159.859,
        alavancagem: 5,
        marginUsed: 40806.214439,
      }),
      accountValue: 40806.214439,
      protecoes: [{ tipo: 'SL', triggerPx: 150 }],
      preco: 155.93,
      szDecimals: 3,
      maxLeverage: 10,
    });
    expect(r.viavel).toBe(true);
    expect(r.posicao).toMatchObject({ tamanho: 2.079, limitadoPeloRisco: true, alavancagem: 5 });
    expect(r.posicao?.stopLoss?.preco).toBe(146.31);
    expect(r.posicao?.notionalUsd).toBeCloseTo(324.17847, 6);
    expect(r.posicao?.perdaAteStopUsd).toBeCloseTo(19.99998, 6);
    expect(r.posicao?.perdaAteStopUsd).toBeLessThanOrEqual(20);
    expect(r.posicao?.liquidacaoEstimada).toBeCloseTo(131.3094737, 6);
    expect(r.entradaTardia?.variacaoFavoravelPct).toBeCloseTo(-2.4577909, 6);
    expect(codigos(r)).toEqual(
      expect.arrayContaining([
        'TAMANHO_LIMITADO_PELO_RISCO',
        'PRECO_CONTRA_BALEIA',
        'SEM_TAKE_PROFIT',
      ]),
    );
  });

  it('4. memecoin (sz 0, preço < 1), capital 100, entrada tardia a favor, só TP', () => {
    // margem 10 % de 100 = 10; 3x → 30; t = 30/0,012345 = 2430,13 → 2430; notional = 29,99835.
    // TP +25 % → 0,012345 × 1,25 = 0,01543125 → 6 casas (sz 0) = 0,015431.
    // Variação = 0,000345/0,012 = 2,875 % > 2 → tardia. l = 1/20; liq = P × (2/3)/0,95 = 0,0086631579;
    // perda até liq = 2430 × 0,0036818421 = 8,9468763 > 5 → RISCO_ACIMA_DO_MAXIMO.
    const r = caso({
      capital: 100,
      alavMax: 10,
      risco: 5,
      posicao: pos({ lado: 'long', entryPx: 0.012, alavancagem: 3, marginUsed: 20_000 }),
      accountValue: 200_000,
      protecoes: [{ tipo: 'TP', triggerPx: 0.015 }],
      preco: 0.012345,
      szDecimals: 0,
      maxLeverage: 10,
    });
    expect(r.viavel).toBe(true);
    expect(r.posicao?.tamanho).toBe(2430);
    expect(r.posicao?.notionalUsd).toBeCloseTo(29.99835, 9);
    expect(r.posicao?.takeProfit?.preco).toBe(0.015431);
    expect(r.posicao?.liquidacaoEstimada).toBeCloseTo(0.0086631579, 9);
    expect(r.posicao?.perdaAteLiquidacaoUsd).toBeCloseTo(8.9468763, 6);
    expect(r.entradaTardia).toMatchObject({ tardia: true });
    expect(r.entradaTardia?.variacaoFavoravelPct).toBeCloseTo(2.875, 9);
    expect(codigos(r)).toEqual(
      expect.arrayContaining(['ENTRADA_TARDIA', 'SEM_STOP_LOSS', 'RISCO_ACIMA_DO_MAXIMO']),
    );
  });

  it('5. ETH (sz 4), capital 100, baleia 50x limitada a 3x → abaixo da ordem mínima', () => {
    // margem 3 % de 100 = 3; alav 3 → notional 9; t = 9/3000 = 0,003; 9 < 10 → inviável.
    const r = caso({
      capital: 100,
      alavMax: 3,
      risco: 2,
      posicao: pos({ lado: 'long', entryPx: 3000, alavancagem: 50, marginUsed: 300 }),
      accountValue: 10_000,
      preco: 3000,
      szDecimals: 4,
      maxLeverage: 25,
    });
    expect(r).toMatchObject({ viavel: false, motivo: { codigo: 'ABAIXO_ORDEM_MINIMA' } });
    expect(r.posicao).toMatchObject({ tamanho: 0.003, alavancagem: 3 });
    expect(r.posicao?.notionalUsd).toBeCloseTo(9, 9);
    expect(r.avisos.find((a) => a.codigo === 'ALAVANCAGEM_LIMITADA')?.mensagem).toContain(
      'das suas definições',
    );
  });

  it('6. ETH short tardio a favor (−3 %), SL +3 % reduz pelo risco, TP −10 %', () => {
    // margem 100, 10x → 1000; t = 1000/2910 = 0,34364 → 0,3436.
    // SL 2910 × 1,03 = 2997,3 (4 inteiros → 1 casa); perda 0,3436 × 87,3 = 29,996 > 20
    // → 20/87,3 = 0,229095 → 0,2290; notional = 666,39; perda até SL = 19,9917.
    // TP 2910 × 0,9 = 2619. R:R = 291/87,3 = 3,3333; aos níveis da baleia 210/180 = 1,16667.
    // liq short: l = 1/50; 2910 × 1,1/1,02 = 3138,2352941.
    const r = caso({
      capital: 1000,
      alavMax: 10,
      risco: 2,
      posicao: pos({ lado: 'short', entryPx: 3000, alavancagem: 10, marginUsed: 10_000 }),
      accountValue: 100_000,
      protecoes: [
        { tipo: 'SL', triggerPx: 3090 },
        { tipo: 'TP', triggerPx: 2700 },
      ],
      preco: 2910,
      szDecimals: 4,
      maxLeverage: 25,
    });
    expect(r.viavel).toBe(true);
    expect(r.posicao).toMatchObject({ tamanho: 0.229, limitadoPeloRisco: true });
    expect(r.posicao?.stopLoss?.preco).toBe(2997.3);
    expect(r.posicao?.takeProfit?.preco).toBe(2619);
    expect(r.posicao?.notionalUsd).toBeCloseTo(666.39, 9);
    expect(r.posicao?.perdaAteStopUsd).toBeCloseTo(19.9917, 9);
    expect(r.posicao?.liquidacaoEstimada).toBeCloseTo(3138.2352941, 6);
    expect(r.rr?.sugerido).toBeCloseTo(3.3333333, 6);
    expect(r.rr?.baleia).toBeCloseTo(3.3333333, 6);
    expect(r.rr?.aosNiveisDaBaleia).toBeCloseTo(1.1666667, 6);
    expect(r.entradaTardia).toMatchObject({ tardia: true });
    expect(r.entradaTardia?.variacaoFavoravelPct).toBeCloseTo(3, 9);
  });

  it('7. BTC long a 40x com SL −2 %: a liquidação estimada fica ANTES do SL', () => {
    // margem 5 % de 1000 = 50; 40x → 2000; t = 0,03333; perda 0,03333 × 1200 = 40 > 20
    // → 20/1200 = 0,016666 → 0,01666. liq = 60000 × (1 − 1/40)/(1 − 1/80) = 59240,5063291 > SL 58800.
    // O utilizador é liquidado antes de o SL disparar; a perda real ≈ margem (24,99), não 19,992.
    const r = caso({
      capital: 1000,
      alavMax: 50,
      risco: 2,
      posicao: pos({ lado: 'long', entryPx: 60_000, alavancagem: 40, marginUsed: 50_000 }),
      accountValue: 1_000_000,
      protecoes: [
        { tipo: 'SL', triggerPx: 58_800 },
        { tipo: 'TP', triggerPx: 63_000 },
      ],
      preco: 60_000,
      szDecimals: 5,
      maxLeverage: 40,
    });
    expect(r.posicao).toMatchObject({ tamanho: 0.01666, alavancagem: 40 });
    expect(r.posicao?.stopLoss?.preco).toBe(58_800);
    expect(r.posicao?.liquidacaoEstimada).toBeCloseTo(59240.5063291, 6);
    expect(r.posicao?.perdaAteStopUsd).toBeCloseTo(19.992, 9);
    expect(r.posicao?.liquidacaoEstimada ?? 0).toBeGreaterThan(r.posicao?.stopLoss?.preco ?? 0);
    expect(r.avisos.find((a) => a.codigo === 'SL_APOS_LIQUIDACAO')?.nivel).toBe('critico');
  });

  it('8. BTC com preço mid fora do tick (65454,5): o preço de entrada sugerido é válido', () => {
    // BTC (sz 5): ≥ 10000 → 5 algarismos significativos = inteiro. Mid 65454,5 → 65455.
    // margem 10 % de 1000 = 100 × 10 = 1000; t = 1000/65455 = 0,015277… → 0,01527; notional 999,49785.
    const r = caso({
      capital: 1000,
      alavMax: 10,
      risco: 2,
      posicao: pos({ lado: 'long', entryPx: 65_000, alavancagem: 10, marginUsed: 100_000 }),
      accountValue: 1_000_000,
      preco: 65_454.5,
      szDecimals: 5,
      maxLeverage: 40,
    });
    expect(r.posicao?.precoEntrada).toBe(65_455);
    expect(r.posicao?.tamanho).toBe(0.01527);
    expect(r.posicao?.notionalUsd).toBeCloseTo(999.49785, 6);
  });

  it('9. preço positivo que arredonda a 0 pelas regras de tick → PRECO_INVALIDO', () => {
    // 1e−9 com sz 0: máx. 6 casas → 0,000000 → sem preço válido.
    const r = caso({
      capital: 1000,
      alavMax: 10,
      risco: 2,
      posicao: pos({ lado: 'long', entryPx: 1e-9, marginUsed: 100 }),
      accountValue: 1000,
      preco: 1e-9,
      szDecimals: 0,
      maxLeverage: 10,
    });
    expect(r).toMatchObject({ viavel: false, motivo: { codigo: 'PRECO_INVALIDO' } });
  });
});

describe('liquidação estimada vs real (fixture isolada xyz:NVDA)', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../hyperliquid/__fixtures__/clearinghouseState-xyz.json', import.meta.url),
      'utf8',
    ),
  ) as {
    assetPositions: {
      position: {
        szi: string;
        entryPx: string;
        positionValue: string;
        marginUsed: string;
        liquidationPx: string;
        maxLeverage: number;
      };
    }[];
  };
  const p = fixture.assetPositions[0]!.position;
  const tamanho = Number(p.szi);
  const mark = Number(p.positionValue) / tamanho;
  const real = Number(p.liquidationPx);

  it('a fórmula aplicada ao estado atual (marca, margem isolada atual) reproduz a liquidationPx', () => {
    // mark = 227156,48505/1456,785 = 155,9303; manutenção = 0,05 × 227156,49 = 11357,82;
    // disponível = 40806,21 − 11357,82 = 29448,39 → /1456,785/0,95 = 21,2789 → 134,6514.
    const liq = estimarLiquidacaoIsolada({
      lado: 'long',
      precoEntrada: mark,
      tamanho,
      margem: Number(p.marginUsed),
      maxLeverageAtivo: p.maxLeverage,
    });
    expect(Math.abs((liq ?? 0) - real)).toBeLessThan(1e-6);
  });

  it('a estimativa de uma posição nova à entrada da baleia (5x) difere < 0,05 % da real', () => {
    // 159,859 × (1 − 1/5)/(1 − 1/20) = 134,6181 vs real 134,6514 (diferença −0,0333, −0,025 %).
    const liq = estimarLiquidacaoIsolada({
      lado: 'long',
      precoEntrada: Number(p.entryPx),
      tamanho,
      margem: (tamanho * Number(p.entryPx)) / 5,
      maxLeverageAtivo: p.maxLeverage,
    });
    expect(liq).toBeCloseTo(134.6181053, 6);
    expect(Math.abs((liq ?? 0) - real) / real).toBeLessThan(5e-4);
  });

  it('short: no preço de liquidação o capital da posição iguala a margem de manutenção', () => {
    const [P, t, m, maxLev] = [200, 3, 75, 20];
    const liq = estimarLiquidacaoIsolada({
      lado: 'short',
      precoEntrada: P,
      tamanho: t,
      margem: m,
      maxLeverageAtivo: maxLev,
    })!;
    expect(liq).toBeGreaterThan(P);
    // equity = m − (liq − P) × t = l × liq × t
    expect(m - (liq - P) * t).toBeCloseTo((liq * t) / (2 * maxLev), 9);
  });
});

/* ---------------------------------------------------------------------------------------------- */

/** PRNG determinístico (mulberry32). */
function mulberry32(semente: number) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Preço válido para a Hyperliquid: inteiro, ou ≤ 5 alg. significativos e ≤ 6 − sz casas. */
function precoValido(p: number, sz: number): boolean {
  if (Number.isInteger(p)) return true;
  // Igualdade exata: o valor tem de ser o mesmo double depois de cortar casas e algarismos.
  return Number(p.toFixed(6 - sz)) === p && Number(p.toPrecision(5)) === p;
}

function todosFinitos(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(todosFinitos);
  if (v && typeof v === 'object') return Object.values(v).every(todosFinitos);
  return true;
}

describe('invariantes (gerador pseudo-aleatório, semente fixa)', () => {
  const N = 3000;
  const rnd = mulberry32(20261117);
  const entre = (a: number, b: number) => a + (b - a) * rnd();
  const logEntre = (a: number, b: number) => 10 ** entre(Math.log10(a), Math.log10(b));
  const inteiro = (a: number, b: number) => Math.floor(entre(a, b + 1));
  const casos: EntradaSugestao[] = [];
  for (let i = 0; i < N; i++) {
    const sz = inteiro(0, 5);
    // Preço realista para o szDecimals (≥ 3 alg. significativos possíveis).
    const preco = Number(logEntre(10 ** (sz - 3), 10 ** (sz + 1)).toPrecision(6));
    const lado = rnd() < 0.5 ? 'long' : 'short';
    const entryPx = preco * entre(0.9, 1.1);
    const accountValue = logEntre(1e3, 1e8);
    const protecoes: ProtecaoBaleia[] = [];
    for (let k = inteiro(0, 3); k > 0; k--) {
      protecoes.push({
        tipo: rnd() < 0.5 ? 'SL' : 'TP',
        triggerPx: entryPx * entre(0.7, 1.3),
      });
    }
    casos.push({
      definicoes: {
        capitalUsd: logEntre(10, 1e5),
        alavancagemMaxima: inteiro(1, 100),
        riscoPorOperacaoPct: entre(0.1, 10),
      },
      baleia: {
        posicao: {
          lado,
          tamanho: 1,
          entryPx,
          alavancagem: inteiro(1, 50),
          tipoMargem: rnd() < 0.5 ? 'cross' : 'isolated',
          marginUsed: accountValue * entre(0, 1.2),
          notional: 1,
          liquidationPx: null,
        },
        accountValue,
        accountValueRepresentativo: true,
        modoConta: null,
        protecoes,
      },
      precoAtual: preco,
      ativo: { szDecimals: sz, maxLeverage: inteiro(3, 50) },
      entidade: { nome: null, ladosOutrasCarteiras: [] },
      frescura: null,
    });
  }
  const resultados = casos.map((e) => ({ e, r: calcularSugestao(e) }));
  const TOL = 1e-6;

  it('todos produzem posição sugerida e nenhum campo NaN/Infinity', () => {
    for (const { r } of resultados) {
      expect(todosFinitos(r)).toBe(true);
      expect(r.posicao).not.toBeNull();
    }
  });

  it('lado = lado da baleia; alavancagem ≤ min(utilizador, ativo, baleia)', () => {
    for (const { e, r } of resultados) {
      expect(r.lado).toBe(e.baleia.posicao!.lado);
      const lim = Math.min(
        e.definicoes.alavancagemMaxima,
        e.ativo!.maxLeverage,
        e.baleia.posicao!.alavancagem,
      );
      expect(r.posicao!.alavancagem).toBeLessThanOrEqual(lim);
    }
  });

  it('notional ≤ capital × alavancagem aplicada; margem ≤ capital', () => {
    for (const { e, r } of resultados) {
      const p = r.posicao!;
      expect(p.notionalUsd).toBeLessThanOrEqual(
        e.definicoes.capitalUsd * p.alavancagem * (1 + TOL),
      );
      expect(p.margemUsd).toBeLessThanOrEqual(e.definicoes.capitalUsd * (1 + TOL));
    }
  });

  it('tamanho múltiplo de 10^−sz e arredondado para baixo (um passo a mais violaria um limite)', () => {
    for (const { e, r } of resultados) {
      const p = r.posicao!;
      const passo = 10 ** -p.szDecimals;
      const unidades = p.tamanho / passo;
      expect(Math.abs(unidades - Math.round(unidades))).toBeLessThan(1e-6);
      const capitalMax = (e.definicoes.capitalUsd * p.alavancagem) / p.precoEntrada;
      const perdaUnit = p.stopLoss ? Math.abs(p.precoEntrada - p.stopLoss.preco) : 0;
      const riscoMax = perdaUnit > 0 ? p.riscoMaximoUsd / perdaUnit : Infinity;
      const margemMax =
        (e.definicoes.capitalUsd *
          Math.min(e.baleia.posicao!.marginUsed / e.baleia.accountValue, 1) *
          p.alavancagem) /
        p.precoEntrada;
      const limite = Math.min(capitalMax, riscoMax, margemMax);
      expect(p.tamanho).toBeLessThanOrEqual(limite * (1 + TOL));
      expect(p.tamanho + passo).toBeGreaterThan(limite * (1 - TOL));
    }
  });

  it('com SL: perda até ao SL ≤ risco máximo; SL do lado da perda, TP do lado do lucro', () => {
    for (const { r } of resultados) {
      const p = r.posicao!;
      const s = r.lado === 'long' ? 1 : -1;
      if (p.stopLoss) {
        expect(s * (p.stopLoss.preco - p.precoEntrada)).toBeLessThan(0);
        expect(p.perdaAteStopUsd!).toBeLessThanOrEqual(p.riscoMaximoUsd * (1 + TOL));
        expect(p.perdaAteStopUsd!).toBeCloseTo(
          p.tamanho * Math.abs(p.precoEntrada - p.stopLoss.preco),
          9,
        );
      } else {
        expect(p.perdaAteStopUsd).toBeNull();
      }
      if (p.takeProfit) expect(s * (p.takeProfit.preco - p.precoEntrada)).toBeGreaterThan(0);
    }
  });

  it('preços sugeridos (entrada, SL, TP) válidos pelas regras de tick', () => {
    for (const { r } of resultados) {
      const p = r.posicao!;
      expect(precoValido(p.precoEntrada, p.szDecimals)).toBe(true);
      if (p.stopLoss) expect(precoValido(p.stopLoss.preco, p.szDecimals)).toBe(true);
      if (p.takeProfit) expect(precoValido(p.takeProfit.preco, p.szDecimals)).toBe(true);
    }
  });

  it('viavel ⇔ notional ≥ 10 USD', () => {
    for (const { r } of resultados) {
      const p = r.posicao!;
      expect(r.viavel).toBe(p.notionalUsd >= 10 * (1 - 1e-9));
      if (!r.viavel) expect(r.motivo?.codigo).toBe('ABAIXO_ORDEM_MINIMA');
    }
  });

  it('liquidação estimada do lado da perda e coerente com a margem de manutenção', () => {
    for (const { e, r } of resultados) {
      const p = r.posicao!;
      if (p.tamanho === 0) continue;
      const liq = p.liquidacaoEstimada;
      if (liq === null) {
        // Só um long a ≤ 1x não tem liquidação.
        expect(r.lado === 'long' && p.alavancagem <= 1).toBe(true);
        continue;
      }
      const s = r.lado === 'long' ? 1 : -1;
      expect(s * (liq - p.precoEntrada)).toBeLessThan(0);
      const l = 1 / (2 * e.ativo!.maxLeverage);
      const equity = p.margemUsd + s * (liq - p.precoEntrada) * p.tamanho;
      expect(equity).toBeCloseTo(l * liq * p.tamanho, 6);
    }
  });

  it('R:R coerente com os níveis', () => {
    for (const { r } of resultados) {
      const p = r.posicao!;
      if (!p.stopLoss || !p.takeProfit) {
        expect(r.rr).toBeNull();
        continue;
      }
      const s = r.lado === 'long' ? 1 : -1;
      const esperado =
        (s * (p.takeProfit.preco - p.precoEntrada)) / (s * (p.precoEntrada - p.stopLoss.preco));
      expect(r.rr!.sugerido).toBeCloseTo(esperado, 9);
      expect(r.rr!.sugerido!).toBeGreaterThan(0);
      expect(r.rr!.baleia).toBeCloseTo(
        Math.abs(p.takeProfit.distanciaPct) / Math.abs(p.stopLoss.distanciaPct),
        9,
      );
    }
  });
});
