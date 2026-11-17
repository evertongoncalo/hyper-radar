import { describe, expect, it } from 'vitest';
import {
  CARTEIRA_A,
  CARTEIRA_B,
  CARTEIRA_C,
  MINUTO,
  posicao,
  protecao,
  snapshot,
  T0,
} from './__testes__/construtores';
import { criarEstadoInicial, processarSnapshot, type EstadoAgregador } from './agregador';
import { calcularAgregados, calcularVariacao } from './agregados';
import { CONFIG_OMISSAO as cfg, type ConfigMotor } from './config';
import type { EventoMotor } from './eventos';
import type { OrdemProtecaoMotor, PosicaoMotor, SnapshotCarteira } from './tipos';

/*
 * Cenários realistas (10–40 snapshots) escritos a partir da especificação (secção 6.1): o
 * resultado esperado de cada um foi decidido antes de olhar para a implementação.
 * Configuração por omissão: limiar 5 % OU 10 000 USD, notional mínimo 1 000 USD, janela de
 * agregação 5 min, debounce SL/TP 2 min, LIQ_NEAR < 5 % com rearme ≥ 7 %.
 */

const SEG = 1_000;

function correr(sequencia: SnapshotCarteira[], config: ConfigMotor = cfg) {
  let estado: EstadoAgregador = criarEstadoInicial();
  let anterior: SnapshotCarteira | null = null;
  const porCiclo: EventoMotor[][] = [];
  for (const s of sequencia) {
    const r = processarSnapshot(estado, anterior, s, config);
    estado = r.estado;
    porCiclo.push(r.eventos);
    anterior = s;
  }
  const eventos = porCiclo.flat();
  return { estado, porCiclo, eventos, tipos: eventos.map((e) => e.tipo) };
}

/** Snapshot ao preço `preco`, com a posição avaliada a esse preço. */
function aPreco(
  instante: number,
  lado: PosicaoMotor['lado'] | null,
  tamanho: number,
  preco: number,
  extra: Partial<PosicaoMotor> = {},
  ordensProtecao: OrdemProtecaoMotor[] = [],
): SnapshotCarteira {
  const pos = lado && tamanho > 0 ? posicao(lado, tamanho, { preco, ...extra }) : null;
  return snapshot(instante, pos, { precoMercado: preco, ordensProtecao });
}

const variacoes = (eventos: EventoMotor[]) =>
  eventos.flatMap((e) => (e.tipo === 'INCREASED' || e.tipo === 'REDUCED' ? [e] : []));

describe('cenário: baleia algorítmica (TWAP)', () => {
  it('30 micro-ordens em 20 min dão poucos INCREASED cuja soma é a variação total', () => {
    const seq = [aPreco(T0, 'long', 1_000, 100)];
    let tamanho = 1_000;
    let ordens = 0;
    for (let m = 1; m <= 20; m++) {
      const n = m % 2 === 0 ? 2 : 1; // 1 ou 2 micro-ordens de 10 unidades (1 %) por ciclo
      ordens += n;
      tamanho += 10 * n;
      seq.push(aPreco(T0 + m * MINUTO, 'long', tamanho, 100));
    }
    for (let m = 21; m <= 27; m++) seq.push(aPreco(T0 + m * MINUTO, 'long', tamanho, 100));
    expect(ordens).toBe(30);

    const { eventos } = correr(seq);
    const v = variacoes(eventos);
    expect(eventos).toHaveLength(v.length); // só INCREASED
    expect(v.every((e) => e.tipo === 'INCREASED')).toBe(true);
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.length).toBeLessThanOrEqual(5);
    // Soma dos deltas = variação notificada; a cauda que falta (as últimas 3 micro-ordens, após o
    // último evento) fica abaixo dos dois limiares e não é emitida (ver dúvida de especificação).
    const notificado = v.at(-1)!.payload.tamanhoNovo;
    expect(v.reduce((s, e) => s + e.payload.delta, 0)).toBeCloseTo(notificado - 1_000, 9);
    const cauda = tamanho - notificado;
    expect(cauda).toBe(30);
    expect((cauda / notificado) * 100).toBeLessThan(cfg.limiarVariacaoPct);
    expect(cauda * 100).toBeLessThan(cfg.limiarVariacaoUsd);
    // Encadeados: cada evento parte do tamanho onde o anterior terminou (nada perdido).
    for (let i = 1; i < v.length; i++) {
      expect(v[i]!.payload.tamanhoAnterior).toBe(v[i - 1]!.payload.tamanhoNovo);
    }
    expect(v.reduce((s, e) => s + e.payload.ciclosConsolidados, 0)).toBe(18);
    expect(new Set(v.map((e) => e.chaveDedupe)).size).toBe(v.length);
  });

  it('redução lenta abaixo do limiar por ciclo acaba por gerar REDUCED pelo acumulado', () => {
    // Preço 10: o limiar de 10 000 USD nunca é atingido; só conta o limiar de 5 %.
    const seq = [aPreco(T0, 'long', 1_000, 10)];
    for (let m = 1; m <= 40; m++) seq.push(aPreco(T0 + m * MINUTO, 'long', 1_000 - 2 * m, 10));
    for (let m = 41; m <= 45; m++) seq.push(aPreco(T0 + m * MINUTO, 'long', 920, 10));

    const { porCiclo, eventos } = correr(seq);
    const v = variacoes(eventos);
    expect(eventos).toHaveLength(1);
    expect(v[0]).toMatchObject({
      tipo: 'REDUCED',
      payload: { tamanhoAnterior: 1_000, tamanhoNovo: 950, delta: -50 },
    });
    // Emitido no ciclo em que o acumulado chega a 5 % (25.º), não antes.
    expect(porCiclo.findIndex((c) => c.length > 0)).toBe(25);
  });

  it('oscilação de ±2 % em torno da referência durante 1 h não gera eventos', () => {
    // 1 000 × 100 = 100 000 USD; 2 % = 2 000 USD, abaixo dos dois limiares.
    const padrao = [1_020, 1_000, 980, 1_005, 1_019.9, 981, 1_000, 995];
    const seq = [aPreco(T0, 'long', 1_000, 100)];
    for (let m = 1; m <= 60; m++) {
      seq.push(aPreco(T0 + m * MINUTO, 'long', padrao[m % padrao.length]!, 100));
    }
    expect(correr(seq).eventos).toEqual([]);
  });

  it('oscilação de ±2 % numa posição de 10 M USD gera eventos (limiar USD absoluto, literal)', () => {
    // Comportamento literal de "≥ X % OU ≥ Y USD": 2 % de 10 M = 200 000 USD ≥ 10 000 USD.
    const seq = [aPreco(T0, 'long', 100_000, 100)];
    for (let m = 1; m <= 60; m++) {
      seq.push(aPreco(T0 + m * MINUTO, 'long', m % 2 === 0 ? 98_000 : 102_000, 100));
    }
    expect(correr(seq).eventos.length).toBeGreaterThan(0);
  });
});

describe('cenário: deduplicação de eventos legítimos distintos', () => {
  // A BD grava com `ON CONFLICT (dedupe_key) DO NOTHING`: chaves iguais = evento perdido.
  const base = T0 - (T0 % (5 * MINUTO)); // alinhado ao bucket, para o cenário ser determinístico

  it('duas reduções discretas de 10 % com 2 min de intervalo têm chaves distintas', () => {
    const seq = [100, 90, 90, 81, 81, 81].map((t, i) => aPreco(base + i * MINUTO, 'long', t, 100));
    const v = variacoes(correr(seq).eventos);
    expect(v.map((e) => [e.tipo, e.payload.delta])).toEqual([
      ['REDUCED', -10],
      ['REDUCED', -9],
    ]);
    expect(v[0]!.chaveDedupe).not.toBe(v[1]!.chaveDedupe);
  });

  it('dois movimentos de SL separados (3 min) têm chaves distintas', () => {
    const sl = (px: number) => [protecao('SL', px)];
    const seq = [90, 92, 92, 92, 95, 95, 95].map((px, i) =>
      aPreco(base + i * MINUTO, 'long', 100, 100, {}, sl(px)),
    );
    const { eventos } = correr(seq);
    expect(eventos.map((e) => e.tipo)).toEqual(['SLTP_CHANGED', 'SLTP_CHANGED']);
    expect(eventos[0]!.chaveDedupe).not.toBe(eventos[1]!.chaveDedupe);
  });
});

describe('cenário: inversões, fechos e reaberturas', () => {
  it('flip long → short num só ciclo dá um único FLIPPED', () => {
    const seq = [
      aPreco(T0, 'long', 100, 100),
      aPreco(T0 + MINUTO, 'long', 100, 100),
      aPreco(T0 + 2 * MINUTO, 'short', 50, 100),
      ...Array.from({ length: 8 }, (_, i) => aPreco(T0 + (3 + i) * MINUTO, 'short', 50, 100)),
    ];
    const { eventos } = correr(seq);
    expect(eventos.map((e) => e.tipo)).toEqual(['FLIPPED']);
    expect(eventos[0]).toMatchObject({
      instante: T0 + 2 * MINUTO,
      payload: { posicaoAnterior: { lado: 'long', tamanho: 100 }, posicao: { lado: 'short' } },
    });
  });

  it('flip via fecho num ciclo e abertura no seguinte dá CLOSED e OPENED', () => {
    const seq = [
      aPreco(T0, 'long', 100, 100),
      aPreco(T0 + MINUTO, null, 0, 100),
      aPreco(T0 + 2 * MINUTO, 'short', 50, 100),
      ...Array.from({ length: 8 }, (_, i) => aPreco(T0 + (3 + i) * MINUTO, 'short', 50, 100)),
    ];
    const { porCiclo } = correr(seq);
    expect(porCiclo.map((c) => c.map((e) => e.tipo))).toEqual([
      [],
      ['CLOSED'],
      ['OPENED'],
      ...Array.from({ length: 8 }, () => []),
    ]);
  });

  it('flip com aumento pendente: FLIPPED parte da referência notificada', () => {
    const seq = [
      aPreco(T0, 'long', 100, 100),
      aPreco(T0 + MINUTO, 'long', 110, 100), // +10 %, ainda a mudar: pendente
      aPreco(T0 + 2 * MINUTO, 'short', 30, 100),
      aPreco(T0 + 3 * MINUTO, 'short', 30, 100),
    ];
    const { eventos } = correr(seq);
    expect(eventos.map((e) => e.tipo)).toEqual(['FLIPPED']);
    expect(eventos[0]!.payload).toMatchObject({ posicaoAnterior: { tamanho: 100 } });
  });

  it('fecho total e reabertura imediata: o segundo OPENED não se perde', () => {
    const seq = [
      aPreco(T0, 'long', 100, 100),
      aPreco(T0 + 15 * SEG, null, 0, 100),
      aPreco(T0 + 30 * SEG, 'long', 100, 100),
      aPreco(T0 + 45 * SEG, null, 0, 100),
      aPreco(T0 + 60 * SEG, 'long', 120, 100),
      ...Array.from({ length: 6 }, (_, i) => aPreco(T0 + (75 + 15 * i) * SEG, 'long', 120, 100)),
    ];
    const { eventos } = correr(seq);
    expect(eventos.map((e) => e.tipo)).toEqual(['CLOSED', 'OPENED', 'CLOSED', 'OPENED']);
    expect(new Set(eventos.map((e) => e.chaveDedupe)).size).toBe(4);
  });
});

describe('cenário: SL/TP', () => {
  const sl = (px: number) => protecao('SL', px, { oid: Math.round(px * 10) });

  it('trailing stop movido 4 vezes em 1 min dá um único SLTP_CHANGED consolidado', () => {
    const seq = [90, 91, 92, 93, 94].map((px, i) =>
      aPreco(T0 + i * 15 * SEG, 'long', 100, 100, {}, [sl(px)]),
    );
    for (let i = 5; i < 15; i++)
      seq.push(aPreco(T0 + i * 15 * SEG, 'long', 100, 100, {}, [sl(94)]));
    const { eventos } = correr(seq);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      tipo: 'SLTP_CHANGED',
      payload: {
        movidas: [{ tipo: 'SL', antes: { triggerPx: 90 }, depois: { triggerPx: 94 } }],
        adicionadas: [],
        removidas: [],
        ciclosConsolidados: 4,
      },
    });
  });

  it('SL removido dá SLTP_CHANGED com a remoção', () => {
    const seq = [
      aPreco(T0, 'long', 100, 100, {}, [sl(90)]),
      ...Array.from({ length: 10 }, (_, i) => aPreco(T0 + (1 + i) * MINUTO, 'long', 100, 100)),
    ];
    const { eventos } = correr(seq);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload).toMatchObject({
      removidas: [{ tipo: 'SL', triggerPx: 90, tamanho: null }],
      adicionadas: [],
      movidas: [],
    });
  });

  it('TP parcial adicionado dá SLTP_CHANGED com a adição', () => {
    const tp = protecao('TP', 120, { tamanho: 50, oid: 7 });
    const seq = [
      aPreco(T0, 'long', 100, 100, {}, [sl(90)]),
      ...Array.from({ length: 10 }, (_, i) =>
        aPreco(T0 + (1 + i) * MINUTO, 'long', 100, 100, {}, [sl(90), tp]),
      ),
    ];
    const { eventos } = correr(seq);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload).toMatchObject({
      adicionadas: [{ tipo: 'TP', triggerPx: 120, tamanho: 50 }],
      removidas: [],
    });
  });

  it.each([
    ['proteções desaparecem com o fecho', [[], []]],
    ['proteções desaparecem um ciclo depois do fecho', [['SL', 'TP'], []]],
  ] as const)('fecho com proteções: só CLOSED (%s)', (_, ordensDepois) => {
    const tp = protecao('TP', 130, { oid: 2 });
    const comOrdens = (tipos: readonly string[]) => (tipos.length ? [sl(90), tp] : []);
    const seq = [
      aPreco(T0, 'long', 100, 100, {}, [sl(90), tp]),
      aPreco(T0 + MINUTO, null, 0, 100, {}, comOrdens(ordensDepois[0])),
      ...Array.from({ length: 8 }, (_, i) =>
        aPreco(T0 + (2 + i) * MINUTO, null, 0, 100, {}, comOrdens(ordensDepois[1])),
      ),
    ];
    expect(correr(seq).tipos).toEqual(['CLOSED']);
  });

  it('proteções canceladas um ciclo antes do fecho: só CLOSED', () => {
    const seq = [
      aPreco(T0, 'long', 100, 100, {}, [sl(90)]),
      aPreco(T0 + MINUTO, 'long', 100, 100),
      ...Array.from({ length: 8 }, (_, i) => aPreco(T0 + (2 + i) * MINUTO, null, 0, 100)),
    ];
    expect(correr(seq).tipos).toEqual(['CLOSED']);
  });

  it('ruído de vírgula flutuante no triggerPx não gera SLTP_CHANGED', () => {
    const seq = [0.3, 0.1 + 0.2, 0.30000000000000004, 0.3].map((px, i) =>
      aPreco(T0 + i * MINUTO, 'long', 100_000, 0.31, {}, [protecao('SL', px)]),
    );
    expect(correr(seq).eventos).toEqual([]);
  });
});

describe('cenário: LIQ_NEAR com histerese', () => {
  it('long: preço a oscilar em torno do limiar dá 1 evento; rearma acima de 7 %', () => {
    // liq 95: 100 → 5,00 % (não < 5); 99,9 → 4,9 %; 100,5 → 5,5 %; 102,5 → 7,3 % (rearme).
    const precos = [100, 99.9, 100.5, 99.8, 101, 99.7, 100.6, 99.9, 102.5, 99.5, 100.2, 99.6];
    const seq = precos.map((p, i) =>
      aPreco(T0 + i * MINUTO, 'long', 100, p, { liquidationPx: 95 }),
    );
    const { porCiclo } = correr(seq);
    const disparos = porCiclo.flatMap((c, i) => (c.some((e) => e.tipo === 'LIQ_NEAR') ? [i] : []));
    expect(disparos).toEqual([1, 9]);
    expect(porCiclo.flat().every((e) => e.tipo === 'LIQ_NEAR')).toBe(true);
  });

  it('short: simétrico (liquidação acima do preço)', () => {
    // liq 105: 100 → 5 %; 100,3 → 4,69 %; 99,8 → 5,2 %; 98 → 7,14 % (rearme); 100,5 → 4,48 %.
    const precos = [100, 100.3, 99.8, 100.4, 99.9, 98, 100.5, 100.1];
    const seq = precos.map((p, i) =>
      aPreco(T0 + i * MINUTO, 'short', 100, p, { liquidationPx: 105 }),
    );
    const { porCiclo } = correr(seq);
    const disparos = porCiclo.flatMap((c, i) => (c.some((e) => e.tipo === 'LIQ_NEAR') ? [i] : []));
    expect(disparos).toEqual([1, 6]);
  });

  it('liquidationPx nulo (cross sem liquidação próxima) e depois não nulo dispara uma vez', () => {
    const seq = [
      aPreco(T0, 'long', 100, 100, { liquidationPx: null }),
      aPreco(T0 + MINUTO, 'long', 100, 100, { liquidationPx: null }),
      aPreco(T0 + 2 * MINUTO, 'long', 100, 100, { liquidationPx: 97 }),
      aPreco(T0 + 3 * MINUTO, 'long', 100, 100, { liquidationPx: 97.5 }),
      aPreco(T0 + 4 * MINUTO, 'long', 100, 100, { liquidationPx: null }),
      aPreco(T0 + 5 * MINUTO, 'long', 100, 100, { liquidationPx: 97 }),
    ];
    const { porCiclo } = correr(seq);
    expect(porCiclo.map((c) => c.map((e) => e.tipo))).toEqual([
      [],
      [],
      ['LIQ_NEAR'],
      [],
      [],
      ['LIQ_NEAR'],
    ]);
    expect(porCiclo[2]![0]!.payload).toMatchObject({ liquidationPx: 97, precoMercado: 100 });
  });

  it('reabertura perto da liquidação rearma a histerese', () => {
    const seq = [
      aPreco(T0, 'long', 100, 100, { liquidationPx: 99 }), // linha de base já perto: sem evento
      aPreco(T0 + MINUTO, 'long', 100, 100, { liquidationPx: 99 }),
      aPreco(T0 + 2 * MINUTO, null, 0, 100),
      aPreco(T0 + 3 * MINUTO, 'long', 100, 100, { liquidationPx: 98 }),
    ];
    expect(correr(seq).porCiclo.map((c) => c.map((e) => e.tipo))).toEqual([
      [],
      [],
      ['CLOSED'],
      ['OPENED', 'LIQ_NEAR'],
    ]);
  });
});

describe('cenário: falhas de leitura, reinício e arranque', () => {
  it('3 ciclos sem leitura e regresso com posição maior: sem CLOSED, variação face ao último válido', () => {
    // Os ciclos falhados não produzem snapshot; o seguinte compara com o último válido.
    const seq = [
      aPreco(T0, 'long', 100, 100),
      aPreco(T0 + 4 * MINUTO, 'long', 150, 100),
      aPreco(T0 + 5 * MINUTO, 'long', 150, 100),
      aPreco(T0 + 6 * MINUTO, 'long', 150, 100),
    ];
    const { eventos } = correr(seq);
    expect(eventos.map((e) => e.tipo)).toEqual(['INCREASED']);
    expect(eventos[0]!.payload).toMatchObject({ tamanhoAnterior: 100, tamanhoNovo: 150 });
  });

  it('reinício: estado novo com posições existentes e carteira nova com posição → zero eventos', () => {
    let estado = criarEstadoInicial();
    const eventos: EventoMotor[] = [];
    const anteriores = new Map<string, SnapshotCarteira>();
    for (let m = 0; m < 12; m++) {
      for (const [carteira, lado, tamanho] of [
        [CARTEIRA_A, 'long', 100],
        [CARTEIRA_B, 'short', 40],
        [CARTEIRA_C, 'long', 7],
      ] as const) {
        const s = { ...aPreco(T0 + m * MINUTO, lado, tamanho, 100), carteira };
        const r = processarSnapshot(estado, anteriores.get(carteira) ?? null, s);
        estado = r.estado;
        eventos.push(...r.eventos);
        anteriores.set(carteira, s);
      }
    }
    expect(eventos).toEqual([]);
  });
});

describe('cenário: números extremos', () => {
  it('ruído de vírgula flutuante (0,1 + 0,2) no tamanho não gera eventos', () => {
    const tamanhos = [0.3, 0.1 + 0.2, 0.30000000000000004, 0.3, 0.1 + 0.1 + 0.1];
    const seq = tamanhos.map((t, i) => aPreco(T0 + i * MINUTO, 'long', t, 60_000));
    expect(correr(seq).eventos).toEqual([]);
  });

  it('tamanho minúsculo (abaixo do notional mínimo) não gera OPENED/CLOSED', () => {
    const seq = [null, 0.00001, 0.00002, null, 0.00001].map((t, i) =>
      aPreco(T0 + i * MINUTO, t ? 'long' : null, t ?? 0, 60_000),
    );
    expect(correr(seq).eventos).toEqual([]);
  });

  it('preço com muitas casas decimais: OPENED e INCREASED pelo limiar percentual', () => {
    const p = 0.000012345678;
    const seq = [
      aPreco(T0, null, 0, p),
      aPreco(T0 + MINUTO, 'long', 1e9, p), // 12 345,678 USD
      aPreco(T0 + 2 * MINUTO, 'long', 1.04e9, p), // +4 %: abaixo
      aPreco(T0 + 3 * MINUTO, 'long', 1.04e9, p),
      aPreco(T0 + 4 * MINUTO, 'long', 1.06e9, p), // +6 % face à referência
      aPreco(T0 + 5 * MINUTO, 'long', 1.06e9, p),
    ];
    const { eventos } = correr(seq);
    expect(eventos.map((e) => e.tipo)).toEqual(['OPENED', 'INCREASED']);
    expect(eventos[1]!.payload).toMatchObject({ tamanhoAnterior: 1e9, tamanhoNovo: 1.06e9 });
  });

  it('notional gigantesco: ruído relativo ignorado; variação de 0,001 % ≥ 10 000 USD conta', () => {
    const t = 1e7;
    const seq = [
      aPreco(T0, 'long', t, 1e5), // 1e12 USD
      aPreco(T0 + MINUTO, 'long', t * (1 + 1e-12), 1e5),
      aPreco(T0 + 2 * MINUTO, 'long', t, 1e5),
      aPreco(T0 + 3 * MINUTO, 'long', t + 100, 1e5), // +1e7 USD
      aPreco(T0 + 4 * MINUTO, 'long', t + 100, 1e5),
    ];
    const { eventos } = correr(seq);
    expect(eventos.map((e) => e.tipo)).toEqual(['INCREASED']);
    expect(variacoes(eventos)[0]!.payload.delta).toBeCloseTo(100, 6);
  });
});

describe('cenário: agregados conferidos à mão', () => {
  const s = (carteira: string, lado: 'long' | 'short', t: number, extra: Partial<PosicaoMotor>) =>
    ({ ...snapshot(T0, posicao(lado, t, extra)), carteira }) as SnapshotCarteira;

  it('caso 1: entrada média, net, alavancagem, zonas e hedge interno', () => {
    const lista = [
      s(CARTEIRA_A, 'long', 10, { entryPx: 100, leverage: 10, liquidationPx: 90 }), // 1 000 USD
      s(CARTEIRA_B, 'long', 30, { entryPx: 120, leverage: 5, liquidationPx: 90 }), // 3 000 USD
      s(CARTEIRA_C, 'short', 20, { entryPx: 110, leverage: 2, liquidationPx: 130 }), // 2 000 USD
    ];
    const r = calcularAgregados('BTC', lista, {
      entidades: { [CARTEIRA_A]: 'E1', [CARTEIRA_C.toUpperCase()]: 'E1' },
    });
    expect(r.long).toEqual({
      carteiras: 2,
      tamanho: 40,
      notionalUsd: 4_000,
      entradaMedia: 115, // (10×100 + 30×120) / 40
      alavancagemMedia: 6.25, // (10×1000 + 5×3000) / 4000
    });
    expect(r.short).toMatchObject({ entradaMedia: 110, alavancagemMedia: 2, notionalUsd: 2_000 });
    expect(r.netUsd).toBe(2_000);
    expect(r.alavancagemMedia).toBeCloseTo(29_000 / 6_000, 12);
    expect(r.zonasLiquidacao).toEqual([
      {
        preco: 90,
        lado: 'long',
        notional: 4_000,
        carteiras: [CARTEIRA_A, CARTEIRA_B],
        distanciaPct: -10,
        notionalAcumulado: 4_000,
      },
      {
        preco: 130,
        lado: 'short',
        notional: 2_000,
        carteiras: [CARTEIRA_C],
        distanciaPct: 30,
        notionalAcumulado: 2_000,
      },
    ]);
    const e1 = r.entidades.find((e) => e.entidade === 'E1')!;
    expect(e1).toMatchObject({
      carteiras: [CARTEIRA_A, CARTEIRA_C],
      longUsd: 1_000,
      shortUsd: 2_000,
      netUsd: -1_000,
      hedgeInterno: true,
      notionalHedgeado: 1_000,
    });
    expect(r.entidadesComHedge).toBe(1);
  });

  it('caso 2: notional acumulado das zonas a partir do preço, para fora, em cada lado', () => {
    const lista = [
      s(CARTEIRA_A, 'long', 10, { liquidationPx: 95 }), // 1 000
      s(CARTEIRA_B, 'long', 20, { liquidationPx: 92 }), // 2 000
      s(CARTEIRA_C, 'short', 5, { liquidationPx: 105 }), // 500
      { ...s(CARTEIRA_C, 'short', 15, { liquidationPx: 110 }), carteira: '0x' + 'd'.repeat(40) },
    ];
    const r = calcularAgregados('BTC', lista);
    expect(r.zonasLiquidacao.map((z) => [z.preco, z.notionalAcumulado])).toEqual([
      [92, 3_000],
      [95, 1_000],
      [105, 500],
      [110, 2_000],
    ]);
    expect(r.entidadesComHedge).toBe(0);
    expect(r.netUsd).toBe(3_000 - 2_000);
  });

  it('caso 3: variação 1 h / 24 h sem histórico é null; com histórico é a diferença', () => {
    const atual = calcularAgregados('BTC', [s(CARTEIRA_A, 'long', 30, { entryPx: 110 })]);
    expect(calcularVariacao(atual, null)).toBeNull();
    const passado = calcularAgregados('BTC', [
      { ...s(CARTEIRA_A, 'long', 10, { entryPx: 100 }), instante: T0 - 60 * MINUTO },
    ]);
    expect(calcularVariacao(atual, passado)).toMatchObject({
      intervaloMs: 60 * MINUTO,
      longUsd: { absoluta: 2_000, pct: 200 },
      entradaMediaLong: { absoluta: 10, pct: 10 },
      shortUsd: { absoluta: 0, pct: null },
      entradaMediaShort: null,
    });
  });
});
