import type { MercadoAtivo } from '@hyper-radar/shared';
import { describe, expect, it } from 'vitest';
import { calcularAgregados, calcularVariacao } from '../motor';
import { posicao, snapshot } from '../motor/__testes__/construtores';
import type { Carteira, EventoDetalhado, SnapshotCompleto } from '../repositorios';
import {
  abreviarEndereco,
  casas,
  construirEntrada,
  hashEntrada,
  jsonCanonico,
  rotuloCarteira,
  sig,
  type DadosEntradaIa,
} from './entrada';

const A = `0x${'a'.repeat(38)}12`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;
const T = Date.UTC(2026, 10, 17, 10, 0, 0);

const carteira = (id: number, endereco: string, extra: Partial<Carteira> = {}): Carteira => ({
  id,
  endereco,
  alias: null,
  entidade: null,
  criadoEm: new Date(T),
  ...extra,
});

const snap = (
  walletId: number,
  pos: SnapshotCompleto['posicao'],
  extra: Partial<SnapshotCompleto> = {},
): SnapshotCompleto => ({
  id: walletId,
  runId: 1,
  walletId,
  assetId: 1,
  accountValue: 1_234_567.891,
  accountValueRepresentativo: true,
  modoConta: 'default',
  marketPx: 100,
  instante: new Date(T),
  posicao: pos,
  ordens: [],
  ...extra,
});

const pos = (lado: 'long' | 'short', tamanho: number, extra = {}) => ({
  lado,
  tamanho,
  entryPx: 98.123456,
  alavancagem: 5,
  tipoMargem: 'cross' as const,
  liquidationPx: 80.55555,
  unrealizedPnl: 1234.5678,
  marginUsed: (tamanho * 100) / 5,
  notional: tamanho * 100,
  ...extra,
});

const mercado: MercadoAtivo = {
  coin: 'BTC',
  dex: null,
  szDecimals: 5,
  maxLeverage: 40,
  onlyIsolated: false,
  isDelisted: false,
  markPx: 100.123456,
  midPx: 100.12,
  oraclePx: 100.2,
  funding: 0.0000125678,
  premium: 0.0001,
  openInterest: 123_456.789,
  prevDayPx: 95,
  dayNtlVlm: 987_654_321.12,
};

function evento(id: number, tipo: EventoDetalhado['tipo'], payload: Record<string, unknown>) {
  return {
    id,
    tipo,
    walletId: 1,
    assetId: 1,
    runId: 1,
    payload,
    dedupeKey: `k${id}`,
    lido: false,
    criadoEm: new Date(T - id * 60_000 + 12_345),
    ticker: 'BTC',
    endereco: A,
    alias: 'Baleia Um',
  } satisfies EventoDetalhado;
}

function dados(extra: Partial<DadosEntradaIa> = {}): DadosEntradaIa {
  const snaps = [
    snapshot(T, posicao('long', 10), { carteira: A }),
    snapshot(T, posicao('short', 4), { carteira: B }),
  ];
  const atual = calcularAgregados('BTC', snaps, { entidades: { [A]: 'Fundo X', [B]: 'Fundo X' } });
  const passado = calcularAgregados('BTC', [snapshot(T - 3_600_000, posicao('long', 5))]);
  return {
    ticker: 'BTC',
    agregados: { atual, variacao1h: calcularVariacao(atual, passado), variacao24h: null },
    carteiras: [
      carteira(1, A, { alias: '  Baleia   Um ', entidade: 'Fundo X' }),
      carteira(2, B, { entidade: 'Fundo X' }),
      carteira(3, C),
    ],
    snapshots: [
      snap(1, pos('long', 10), {
        ordens: [
          { tipo: 'SL', triggerPx: 90.123456, tamanho: null, reduceOnly: true, oid: 7 },
          { tipo: 'TP', triggerPx: 120, tamanho: null, reduceOnly: true, oid: 8 },
        ],
      }),
      snap(2, pos('short', 4, { tipoMargem: 'isolated' }), { accountValueRepresentativo: false }),
      snap(3, null),
    ],
    eventos: [
      evento(1, 'OPENED', {
        posicao: { lado: 'long', tamanho: 10, entryPx: 98 },
        precoMercado: 99,
      }),
      evento(2, 'CLOSED', {
        posicaoAnterior: { lado: 'short' },
        notionalFechado: 5_000,
        precoMercado: 99,
      }),
      evento(3, 'INCREASED', {
        lado: 'long',
        delta: 2,
        variacaoPct: 25.55,
        notional: 1_000,
        precoMercado: 99,
      }),
      evento(4, 'REDUCED', {
        lado: 'short',
        delta: -1,
        variacaoPct: 10,
        notional: 300,
        precoMercado: 99,
      }),
      evento(5, 'FLIPPED', { posicao: { lado: 'short', tamanho: 3 }, precoMercado: 99 }),
      evento(6, 'SLTP_CHANGED', {
        lado: 'long',
        depois: [
          { tipo: 'SL', triggerPx: 90 },
          { tipo: 'TP', triggerPx: 130 },
          { tipo: 'SL', triggerPx: 'x' },
        ],
      }),
      evento(7, 'LIQ_NEAR', { lado: 'long', liquidationPx: 95, distanciaPct: 4.567 }),
      evento(8, 'SLTP_CHANGED', { lado: null, depois: 'não é lista' }),
    ],
    mercado,
    definicoes: {
      capitalUsd: 1000,
      alavancagemMaxima: 5,
      riscoPorOperacaoPct: 1,
      intervaloRecolhaSegundos: 60,
      limiteDiarioChamadasIa: 10,
      limiteDiarioTokensIa: 200_000,
      atualizadoEm: new Date(T),
    },
    ...extra,
  };
}

describe('arredondamentos e rótulos', () => {
  it('sig/casas: algarismos significativos, casas fixas, não finitos a null', () => {
    expect(sig(123_456.789, 4)).toBe(123_500);
    expect(sig(0.000012345678, 3)).toBe(0.0000123);
    expect(sig(0)).toBe(0);
    expect(sig(Number.NaN)).toBeNull();
    expect(sig(null)).toBeNull();
    expect(casas(1.26)).toBe(1.3);
    expect(casas(-0.01)).toBe(0);
    expect(casas(Number.POSITIVE_INFINITY)).toBeNull();
    expect(casas(undefined)).toBeNull();
  });

  it('endereço abreviado; alias tem prioridade e é normalizado', () => {
    expect(abreviarEndereco(A)).toBe('0xaaaa…aa12');
    expect(abreviarEndereco('Fundo X')).toBe('Fundo X');
    expect(rotuloCarteira({ endereco: A, alias: null })).toBe('0xaaaa…aa12');
    expect(rotuloCarteira({ endereco: A, alias: '   ' })).toBe('0xaaaa…aa12');
    expect(rotuloCarteira({ endereco: A, alias: ' a  b ' })).toBe('a b');
    expect(rotuloCarteira({ endereco: A, alias: 'x'.repeat(100) })).toHaveLength(40);
  });
});

describe('construirEntrada', () => {
  it('JSON compacto: sem endereços completos, números arredondados, blocos esperados', () => {
    const e = construirEntrada(dados());
    const texto = JSON.stringify(e);
    for (const endereco of [A, B, C]) expect(texto).not.toContain(endereco);
    expect(texto.length).toBeLessThan(4_000);

    expect(e).toMatchObject({ v: 1, at: 'BTC', px: 100.12 });
    expect(e['mk']).toEqual({
      mark: 100.12,
      oracle: 100.2,
      fund: 0.0000126,
      oi: 123_500,
      oiUsd: 12_360_000,
      vol24: 987_700_000,
      d24Pct: 5.39,
      maxLev: 40,
    });
    const pos = e['pos'] as Record<string, unknown>[];
    expect(pos).toHaveLength(2);
    expect(pos[0]).toEqual({
      w: 'Baleia Um',
      ent: 'Fundo X',
      l: 'L',
      sz: 10,
      ntl: 1_000,
      e: 98.123,
      lev: 5,
      mg: 'cross',
      liq: 80.556,
      upnl: 1235,
      sl: [90.123],
      tp: [120],
      av: 1_235_000,
      avRep: true,
    });
    expect(pos[1]).toMatchObject({ w: '0xbbbb…bbbb', l: 'S', mg: 'iso', avRep: false });

    const ag = e['ag'] as Record<string, unknown>;
    expect(ag).toMatchObject({ n: 2, sp: 0, net: 600 });
    expect(ag['hedge']).toEqual([{ ent: 'Fundo X', L: 1000, S: 400 }]);
    expect(e['v1h']).toMatchObject({ h: 1, nL: 0, nS: 1, netPct: 20 });
    expect(e['v24h']).toBeNull();
    expect(e['def']).toEqual({ cap: 1000, levMax: 5, riscoPct: 1 });
  });

  it('eventos: só os números relevantes por tipo, rótulo e instante ao minuto', () => {
    const ev = construirEntrada(dados())['ev'] as Record<string, unknown>[];
    expect(ev[0]).toEqual({
      t: 'OPENED',
      w: 'Baleia Um',
      em: '2026-11-17T09:59Z',
      l: 'L',
      sz: 10,
      e: 98,
      px: 99,
    });
    expect(ev[1]).toMatchObject({ t: 'CLOSED', l: 'S', ntl: 5000 });
    expect(ev[2]).toMatchObject({ t: 'INCREASED', l: 'L', d: 2, dPct: 25.6, ntl: 1000 });
    expect(ev[3]).toMatchObject({ t: 'REDUCED', l: 'S', d: -1 });
    expect(ev[4]).toMatchObject({ t: 'FLIPPED', l: 'S', sz: 3 });
    expect(ev[5]).toMatchObject({ t: 'SLTP_CHANGED', l: 'L', sl: [90], tp: [130] });
    expect(ev[6]).toMatchObject({ t: 'LIQ_NEAR', liq: 95, dPct: 4.57 });
    expect(ev[7]).toMatchObject({ l: null, sl: [], tp: [] });
  });

  it('limites de posições e eventos; sem mercado usa o preço de referência', () => {
    const e = construirEntrada(dados({ mercado: null, maxPosicoes: 1, maxEventos: 2 }));
    expect(e['mk']).toBeNull();
    expect(e['px']).toBe(100);
    expect(e['pos']).toHaveLength(1);
    expect(e['ev']).toHaveLength(2);
  });

  it('mercado sem preço do dia anterior e payloads incompletos não rebentam', () => {
    const e = construirEntrada(
      dados({
        mercado: { ...mercado, prevDayPx: 0 },
        eventos: [evento(1, 'OPENED', {}), evento(2, 'LIQ_NEAR', { lado: 'outro' })],
        snapshots: [snap(99, pos('long', 1))],
      }),
    );
    expect((e['mk'] as Record<string, unknown>)['d24Pct']).toBeNull();
    expect(e['pos']).toEqual([]);
    expect((e['ev'] as unknown[])[0]).toMatchObject({ l: null, sz: null, e: null, px: null });
    expect((e['ev'] as unknown[])[1]).toMatchObject({ l: null });
  });

  it('sem dados: agregados vazios e variações nulas', () => {
    const vazio = calcularAgregados('BTC', []);
    const e = construirEntrada(
      dados({
        agregados: { atual: vazio, variacao1h: null, variacao24h: null },
        snapshots: [],
        eventos: [],
        mercado: null,
      }),
    );
    expect(e).toMatchObject({ px: null, v1h: null, pos: [], ev: [] });
  });
});

describe('hash estável', () => {
  it('JSON canónico ordena chaves recursivamente e ignora undefined', () => {
    expect(jsonCanonico({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it('mesmo input → mesmo hash, independentemente da ordem das chaves', () => {
    const e = construirEntrada(dados());
    const invertido = Object.fromEntries(Object.entries(e).reverse()) as typeof e;
    expect(hashEntrada(invertido, 1)).toBe(hashEntrada(e, 1));
    expect(hashEntrada(construirEntrada(dados()), 1)).toBe(hashEntrada(e, 1));
    expect(hashEntrada(e, 1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mudança relevante (preço, posição, prompt) → hash diferente; ruído abaixo do arredondamento não', () => {
    const base = hashEntrada(construirEntrada(dados()), 1);
    expect(hashEntrada(construirEntrada(dados()), 2)).not.toBe(base);
    expect(
      hashEntrada(construirEntrada(dados({ mercado: { ...mercado, markPx: 101 } })), 1),
    ).not.toBe(base);
    const d = dados();
    d.snapshots[0] = snap(1, pos('long', 11));
    expect(hashEntrada(construirEntrada(d), 1)).not.toBe(base);
    expect(
      hashEntrada(construirEntrada(dados({ mercado: { ...mercado, markPx: 100.1234 } })), 1),
    ).toBe(base);
  });
});
