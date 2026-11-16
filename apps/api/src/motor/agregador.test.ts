import { describe, expect, it } from 'vitest';
import {
  ATIVO,
  CARTEIRA_A,
  CARTEIRA_B,
  MINUTO,
  posicao,
  protecao,
  snapshot,
  T0,
} from './__testes__/construtores';
import {
  chaveEstado,
  criarEstadoInicial,
  processarSnapshot,
  type EstadoAgregador,
} from './agregador';
import { CONFIG_OMISSAO as cfg, criarConfig, type ConfigMotor } from './config';
import type { EventoMotor } from './eventos';
import type { OrdemProtecaoMotor, PosicaoMotor, SnapshotCarteira } from './tipos';

/** Processa uma sequência de snapshots (um por minuto), encadeando estado e anterior. */
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
  return {
    estado,
    porCiclo,
    eventos: porCiclo.flat(),
    tipos: porCiclo.map((c) => c.map((e) => e.tipo)),
  };
}

type Passo = PosicaoMotor | null | [PosicaoMotor | null, Partial<SnapshotCarteira>];

function serie(passos: Passo[], passoMs = MINUTO): SnapshotCarteira[] {
  return passos.map((p, i) => {
    const [pos, extra] = Array.isArray(p) ? p : [p, {}];
    return snapshot(T0 + i * passoMs, pos, extra);
  });
}

const long = (t: number, extra: Partial<PosicaoMotor> = {}) => posicao('long', t, extra);
const short = (t: number, extra: Partial<PosicaoMotor> = {}) => posicao('short', t, extra);
const comSltp = (pos: PosicaoMotor | null, ordens: OrdemProtecaoMotor[]): Passo => [
  pos,
  { ordensProtecao: ordens },
];

describe('linha de base', () => {
  it('primeiro snapshot não gera eventos, mas regista referência e LIQ_NEAR', () => {
    const s = snapshot(T0, long(100, { liquidationPx: 97 }), {
      ordensProtecao: [protecao('SL', 90)],
    });
    const r = processarSnapshot(criarEstadoInicial(), null, s, cfg);
    expect(r.eventos).toEqual([]);
    expect(r.estado.chaves[chaveEstado(CARTEIRA_A, ATIVO)]).toEqual({
      referencia: s.posicao,
      divergencia: null,
      protecoesReferencia: s.ordensProtecao,
      sltpPendente: null,
      liqArmado: false,
    });
  });

  it('linha de base com posição existente não gera OPENED no ciclo seguinte', () => {
    expect(correr(serie([long(100), long(100), long(100)])).eventos).toEqual([]);
  });

  it('sem estado para a chave, o snapshot anterior serve de linha de base', () => {
    const r = processarSnapshot(
      criarEstadoInicial(),
      snapshot(T0, long(100)),
      snapshot(T0 + MINUTO, null),
    );
    expect(r.eventos.map((e) => e.tipo)).toEqual(['CLOSED']);
  });

  it('é imutável: o estado de entrada não é alterado', () => {
    const base = processarSnapshot(criarEstadoInicial(), null, snapshot(T0, long(100)), cfg).estado;
    const copia = structuredClone(base);
    processarSnapshot(base, snapshot(T0, long(100)), snapshot(T0 + MINUTO, long(200)), cfg);
    processarSnapshot(base, snapshot(T0, long(100)), snapshot(T0 + MINUTO, null), cfg);
    expect(base).toEqual(copia);
  });

  it('mantém o estado de outras chaves', () => {
    let estado = processarSnapshot(criarEstadoInicial(), null, snapshot(T0, long(100)), cfg).estado;
    estado = processarSnapshot(
      estado,
      null,
      snapshot(T0, short(5), { carteira: CARTEIRA_B }),
      cfg,
    ).estado;
    expect(Object.keys(estado.chaves).sort()).toEqual(
      [chaveEstado(CARTEIRA_A, ATIVO), chaveEstado(CARTEIRA_B, ATIVO)].sort(),
    );
  });
});

describe('OPENED / CLOSED / FLIPPED (imediatos, com notional mínimo)', () => {
  it.each<[string, Passo[], string[][]]>([
    ['abertura', [null, long(100)], [[], ['OPENED']]],
    ['abertura abaixo do mínimo é ruído', [null, long(5), long(5)], [[], [], []]],
    ['abertura que cresce até ao mínimo', [null, long(5), long(20)], [[], [], ['OPENED']]],
    ['fecho total', [long(100), null], [[], ['CLOSED']]],
    ['fecho de posição pequena é ruído', [long(5), null], [[], []]],
    ['inversão direta', [long(100), short(50)], [[], ['FLIPPED']]],
    ['inversão de pequena para grande', [short(5), long(50)], [[], ['FLIPPED']]],
    ['inversão entre posições pequenas é ruído', [short(5), long(3), long(3)], [[], [], []]],
    [
      'inversão via fecho + abertura em ciclos seguidos',
      [long(100), null, short(60)],
      [[], ['CLOSED'], ['OPENED']],
    ],
    ['sem posição nunca', [null, null, null], [[], [], []]],
  ])('%s', (_nome, passos, esperado) => {
    expect(correr(serie(passos)).tipos).toEqual(esperado);
  });

  it('payloads de OPENED, CLOSED e FLIPPED', () => {
    const sl = protecao('SL', 90);
    const { eventos } = correr(
      serie([null, comSltp(long(100, { entryPx: 99 }), [sl]), null, short(30)]),
    );
    expect(eventos[0]).toEqual({
      tipo: 'OPENED',
      carteira: CARTEIRA_A,
      ativo: ATIVO,
      instante: T0 + MINUTO,
      payload: {
        posicao: long(100, { entryPx: 99 }),
        protecoes: [{ tipo: 'SL', triggerPx: 90, tamanho: null }],
        precoMercado: 100,
      },
      chaveDedupe: `${CARTEIRA_A}|${ATIVO}|OPENED|${Math.floor((T0 + MINUTO) / 300_000) * 300_000}`,
    });
    expect(eventos[1]).toMatchObject({
      tipo: 'CLOSED',
      payload: { posicaoAnterior: { tamanho: 100 }, notionalFechado: 10_000 },
    });
    expect(eventos[2]).toMatchObject({ tipo: 'OPENED', payload: { posicao: { lado: 'short' } } });

    const inv = correr(serie([long(100), short(30)])).eventos[0];
    expect(inv).toMatchObject({
      tipo: 'FLIPPED',
      payload: {
        posicaoAnterior: { lado: 'long', tamanho: 100 },
        posicao: { lado: 'short', tamanho: 30 },
      },
    });
  });

  it('fecho depois de redução pendente reporta o tamanho de referência', () => {
    const { tipos, eventos } = correr(serie([long(100), long(60), null]));
    expect(tipos).toEqual([[], [], ['CLOSED']]);
    expect(eventos[0]).toMatchObject({ payload: { posicaoAnterior: { tamanho: 100 } } });
  });

  it('notional mínimo configurável', () => {
    const config = criarConfig({ notionalMinimoUsd: 0 });
    expect(correr(serie([null, long(0.01)]), config).tipos).toEqual([[], ['OPENED']]);
  });
});

describe('INCREASED / REDUCED (limiar + debounce)', () => {
  it('micro-ordens consolidadas num único evento ao estabilizar', () => {
    const passos = [100, 101, 102, 103, 104, 105, 105].map((t) =>
      long(t, { entryPx: 100 + (t - 100) / 10 }),
    );
    const { tipos, eventos } = correr(serie(passos));
    expect(tipos).toEqual([[], [], [], [], [], [], ['INCREASED']]);
    expect(eventos[0]).toMatchObject({
      tipo: 'INCREASED',
      instante: T0 + 6 * MINUTO,
      payload: {
        lado: 'long',
        tamanhoAnterior: 100,
        tamanhoNovo: 105,
        delta: 5,
        entryPxAnterior: 100,
        entryPxNovo: 100.5,
        deltaNotional: 500,
        ciclosConsolidados: 5,
        inicioJanela: T0 + MINUTO,
      },
    });
    expect(eventos[0]!.payload).toHaveProperty('variacaoPct', 5);
  });

  it('variação abaixo do limiar não gera evento (nem estabilizada)', () => {
    expect(correr(serie([long(100), long(103), long(104), long(104), long(104)])).eventos).toEqual(
      [],
    );
  });

  it('divergência que regressa à referência é descartada', () => {
    const r = correr(serie([long(100), long(150), long(100), long(100)]));
    expect(r.eventos).toEqual([]);
    expect(r.estado.chaves[chaveEstado(CARTEIRA_A, ATIVO)]!.divergencia).toBeNull();
  });

  it('variação grande isolada só sai no ciclo seguinte (estabilização)', () => {
    expect(correr(serie([long(100), long(200), long(200), long(200)])).tipos).toEqual([
      [],
      [],
      ['INCREASED'],
      [],
    ]);
  });

  it('janela a expirar sem estabilização emite com o delta total', () => {
    const passos = [100, 102, 104, 106, 108, 110, 112, 114].map((t) => long(t));
    const { tipos, eventos } = correr(serie(passos));
    // Primeira divergência em T0+1 min; a janela de 5 min expira em T0+6 min.
    expect(tipos.findIndex((c) => c.length > 0)).toBe(6);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      payload: { tamanhoAnterior: 100, tamanhoNovo: 112, delta: 12, ciclosConsolidados: 6 },
    });
  });

  it('janela configurável', () => {
    const config = criarConfig({ janelaAgregacaoMs: 2 * MINUTO });
    const passos = [100, 110, 120, 130].map((t) => long(t));
    expect(correr(serie(passos), config).tipos).toEqual([[], [], [], ['INCREASED']]);
  });

  it.each<[string, number, number]>([
    ['por percentagem (10 % de 20 un. = 200 USD)', 20, 22],
    ['por USD (1,5 % de 10 000 un. = 15 000 USD)', 10_000, 10_150],
  ])('limiar %s', (_nome, de, para) => {
    expect(correr(serie([long(de), long(para), long(para)])).tipos[2]).toEqual(['INCREASED']);
  });

  it('nem % nem USD suficientes (2 % de 1 000 un. = 2 000 USD) ⇒ sem evento', () => {
    expect(correr(serie([long(1_000), long(1_020), long(1_020)])).eventos).toEqual([]);
  });

  it('redução parcial ⇒ REDUCED; fecho total ⇒ CLOSED', () => {
    const parcial = correr(serie([short(100), short(50), short(50)]));
    expect(parcial.tipos).toEqual([[], [], ['REDUCED']]);
    expect(parcial.eventos[0]).toMatchObject({
      payload: {
        lado: 'short',
        tamanhoAnterior: 100,
        tamanhoNovo: 50,
        delta: -50,
        variacaoPct: 50,
      },
    });
    expect(correr(serie([short(100), null])).tipos).toEqual([[], ['CLOSED']]);
  });

  it('abertura construída aos poucos: OPENED imediato e aumentos agregados', () => {
    const { tipos, eventos } = correr(serie([null, long(30), long(40), long(50), long(50)]));
    expect(tipos).toEqual([[], ['OPENED'], [], [], ['INCREASED']]);
    expect(eventos[1]).toMatchObject({
      payload: { tamanhoAnterior: 30, tamanhoNovo: 50, ciclosConsolidados: 2 },
    });
  });

  it('após um evento a referência passa a ser a posição emitida', () => {
    const { tipos, eventos } = correr(
      serie([long(100), long(110), long(110), long(112), long(112), long(121), long(121)]),
    );
    expect(tipos).toEqual([[], [], ['INCREASED'], [], [], [], ['INCREASED']]);
    expect(eventos[1]).toMatchObject({ payload: { tamanhoAnterior: 110, tamanhoNovo: 121 } });
  });

  it('ruído de vírgula flutuante não gera eventos falsos', () => {
    const passos = [0.1 + 0.2, 0.3, 0.1 * 3, 0.30000000000000004].map((t) => long(t * 10_000));
    expect(correr(serie(passos)).eventos).toEqual([]);
  });

  it('limiar exato com resíduo de arredondamento conta como atingido', () => {
    const ref = (0.1 + 0.2) * 1_000; // 300.00000000000006
    const novo = 315; // 4,99999…% por arredondamento
    expect(correr(serie([long(ref), long(novo), long(novo)])).tipos[2]).toEqual(['INCREASED']);
  });
});

describe('SLTP_CHANGED (debounce próprio)', () => {
  const p = long(100);

  it.each<[string, OrdemProtecaoMotor[], OrdemProtecaoMotor[], Record<string, unknown>]>([
    [
      'SL movido',
      [protecao('SL', 90)],
      [protecao('SL', 95)],
      { movidas: [{ tipo: 'SL', antes: { triggerPx: 90 }, depois: { triggerPx: 95 } }] },
    ],
    [
      'TP adicionado',
      [protecao('SL', 90)],
      [protecao('SL', 90), protecao('TP', 130)],
      { adicionadas: [{ tipo: 'TP', triggerPx: 130, tamanho: null }], removidas: [] },
    ],
    [
      'proteção removida',
      [protecao('SL', 90), protecao('TP', 130)],
      [protecao('TP', 130)],
      { removidas: [{ tipo: 'SL', triggerPx: 90, tamanho: null }], adicionadas: [] },
    ],
  ])('%s', (_nome, antes, depois, esperado) => {
    const { tipos, eventos } = correr(
      serie([comSltp(p, antes), comSltp(p, depois), comSltp(p, depois)]),
    );
    expect(tipos).toEqual([[], [], ['SLTP_CHANGED']]);
    expect(eventos[0]).toMatchObject({
      payload: { lado: 'long', ciclosConsolidados: 1, ...esperado },
    });
  });

  it('consolida alterações sucessivas num evento (antes → depois final)', () => {
    const { tipos, eventos } = correr(
      serie([
        comSltp(p, [protecao('SL', 90)]),
        comSltp(p, [protecao('SL', 91)]),
        comSltp(p, [protecao('SL', 92)]),
        comSltp(p, [protecao('SL', 92)]),
      ]),
    );
    expect(tipos).toEqual([[], [], [], ['SLTP_CHANGED']]);
    expect(eventos[0]).toMatchObject({
      payload: {
        antes: [{ triggerPx: 90 }],
        depois: [{ triggerPx: 92 }],
        ciclosConsolidados: 2,
        inicioJanela: T0 + MINUTO,
      },
    });
  });

  it('janela SL/TP a expirar com trailing stop contínuo', () => {
    const passos = [90, 91, 92, 93, 94].map((px) => comSltp(p, [protecao('SL', px)]));
    const { tipos, eventos } = correr(serie(passos));
    expect(tipos).toEqual([[], [], [], ['SLTP_CHANGED'], []]);
    expect(eventos[0]).toMatchObject({
      payload: { depois: [{ triggerPx: 93 }], ciclosConsolidados: 3 },
    });
  });

  it.each<[string, Passo[]]>([
    [
      'alteração revertida dentro da janela',
      [
        comSltp(p, [protecao('SL', 90)]),
        comSltp(p, [protecao('SL', 95)]),
        comSltp(p, [protecao('SL', 90)]),
      ],
    ],
    [
      'só muda o oid (reposição da mesma ordem)',
      [
        comSltp(p, [protecao('SL', 90, { oid: 1 })]),
        comSltp(p, [protecao('SL', 90, { oid: 2 })]),
        comSltp(p, [protecao('SL', 90, { oid: 2 })]),
      ],
    ],
    [
      'dentro da tolerância de preço (0,03 %)',
      [
        comSltp(p, [protecao('SL', 90)]),
        comSltp(p, [protecao('SL', 90.027)]),
        comSltp(p, [protecao('SL', 90.027)]),
      ],
    ],
  ])('sem evento: %s', (_nome, passos) => {
    expect(correr(serie(passos)).eventos).toEqual([]);
  });

  it.each<[string, Passo[], string[][]]>([
    [
      'posição fechada no mesmo ciclo em que as proteções desaparecem',
      [comSltp(p, [protecao('SL', 90)]), comSltp(null, []), comSltp(null, [])],
      [[], ['CLOSED'], []],
    ],
    [
      'alteração pendente e posição fechada a seguir',
      [comSltp(p, [protecao('SL', 90)]), comSltp(p, [protecao('SL', 95)]), comSltp(null, [])],
      [[], [], ['CLOSED']],
    ],
    [
      'abertura com SL/TP (as proteções vão no OPENED)',
      [comSltp(null, []), comSltp(p, [protecao('SL', 90)]), comSltp(p, [protecao('SL', 90)])],
      [[], ['OPENED'], []],
    ],
    [
      'inversão com proteções novas',
      [
        comSltp(p, [protecao('SL', 90)]),
        comSltp(short(100), [protecao('SL', 110)]),
        comSltp(short(100), [protecao('SL', 110)]),
      ],
      [[], ['FLIPPED'], []],
    ],
    [
      'proteções numa posição pequena sem referência (ruído)',
      [
        comSltp(null, []),
        comSltp(long(5), [protecao('SL', 90)]),
        comSltp(long(5), [protecao('SL', 80)]),
        comSltp(long(5), [protecao('SL', 80)]),
      ],
      [[], [], [], []],
    ],
  ])('%s', (_nome, passos, esperado) => {
    expect(correr(serie(passos)).tipos).toEqual(esperado);
  });

  it('SL/TP e variação de posição no mesmo ciclo', () => {
    const { tipos } = correr(
      serie([
        comSltp(long(100), [protecao('SL', 90)]),
        comSltp(long(200), [protecao('SL', 95)]),
        comSltp(long(200), [protecao('SL', 95)]),
      ]),
    );
    expect(tipos).toEqual([[], [], ['INCREASED', 'SLTP_CHANGED']]);
  });
});

describe('LIQ_NEAR (histerese)', () => {
  const comPreco = (pos: PosicaoMotor | null, precoMercado: number): Passo => [
    pos,
    { precoMercado },
  ];

  it('long: dispara ao entrar, não repete, só rearma acima de 7 %', () => {
    const p = long(100, { liquidationPx: 90 });
    // distâncias: 10 %, 4,76 %, 4,26 %, 5,76 %, 4,76 %, 7,22 %, 4,76 %
    const precos = [100, 94.5, 94, 95.5, 94.5, 97, 94.5];
    const { tipos, eventos } = correr(serie(precos.map((px) => comPreco(p, px))));
    expect(tipos).toEqual([[], ['LIQ_NEAR'], [], [], [], [], ['LIQ_NEAR']]);
    expect(eventos[0]).toMatchObject({
      payload: { lado: 'long', liquidationPx: 90, precoMercado: 94.5, limiarPct: 5 },
    });
    expect((eventos[0]!.payload as { distanciaPct: number }).distanciaPct).toBeCloseTo(4.7619, 3);
  });

  it('short: distância medida para cima', () => {
    const p = short(100, { liquidationPx: 110 });
    const { tipos } = correr(serie([comPreco(p, 100), comPreco(p, 103), comPreco(p, 105)]));
    expect(tipos).toEqual([[], [], ['LIQ_NEAR']]);
  });

  it('liquidationPx nulo nunca dispara', () => {
    const p = long(100);
    expect(correr(serie([comPreco(p, 100), comPreco(p, 1), comPreco(p, 0.5)])).eventos).toEqual([]);
  });

  it('linha de base já dentro do limiar não dispara até sair e voltar a entrar', () => {
    const p = long(100, { liquidationPx: 90 });
    const { tipos } = correr(
      serie([comPreco(p, 94), comPreco(p, 93), comPreco(p, 98), comPreco(p, 94)]),
    );
    expect(tipos).toEqual([[], [], [], ['LIQ_NEAR']]);
  });

  it('abertura já perto da liquidação gera OPENED e LIQ_NEAR', () => {
    const { tipos } = correr(serie([null, long(100, { liquidationPx: 97 })]));
    expect(tipos).toEqual([[], ['OPENED', 'LIQ_NEAR']]);
  });
});

describe('deduplicação', () => {
  it('reprocessar a mesma sequência dá as mesmas chaves', () => {
    const seq = serie([null, long(100), long(150), long(150), null]);
    const a = correr(seq).eventos.map((e) => e.chaveDedupe);
    const b = correr(seq).eventos.map((e) => e.chaveDedupe);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(new Set(a).size).toBe(3);
  });

  it('INCREASED usa o início da janela no bucket', () => {
    const config = criarConfig({ bucketDedupeMs: MINUTO });
    const { eventos } = correr(serie([long(100), long(200), long(200)]), config);
    expect(eventos[0]!.chaveDedupe).toBe(
      `${CARTEIRA_A}|${ATIVO}|INCREASED|${T0 + MINUTO - (T0 % MINUTO)}`,
    );
  });

  it('o mesmo tipo dentro do mesmo bucket partilha a chave (gravado uma só vez)', () => {
    const { eventos } = correr(serie([null, long(100), null, long(100)], 10_000));
    const abertos = eventos.filter((e) => e.tipo === 'OPENED');
    expect(abertos).toHaveLength(2);
    expect(abertos[0]!.chaveDedupe).toBe(abertos[1]!.chaveDedupe);
  });
});
