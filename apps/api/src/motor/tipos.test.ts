import {
  frontendOpenOrdersRespostaSchema,
  type EstadoCarteiraNoAtivo,
  type OrdemAberta,
  type Posicao,
} from '@hyper-radar/shared';
import { describe, expect, it } from 'vitest';
import { carregarFixture } from '../hyperliquid/__testes__/auxiliares';
import { normalizarOrdens } from '../hyperliquid/normalizar';
import {
  converterOrdemProtecao,
  eOrdemProtecao,
  ordenarProtecoes,
  snapshotDeEstado,
} from './tipos';

function ordem(extra: Partial<OrdemAberta> = {}): OrdemAberta {
  return {
    oid: 1,
    coin: 'BTC',
    dex: null,
    lado: 'venda',
    tamanho: 0,
    tamanhoOriginal: 0,
    limitPx: 90,
    isTrigger: true,
    triggerPx: 90,
    triggerCondition: 'Price below 90',
    orderType: 'Stop Market',
    reduceOnly: true,
    isPositionTpsl: true,
    protecao: 'stop_loss',
    timestamp: 0,
    ...extra,
  };
}

const posicaoHl: Posicao = {
  coin: 'BTC',
  dex: null,
  lado: 'short',
  tamanho: 2,
  szi: -2,
  entryPx: 100,
  leverage: { tipo: 'isolated', valor: 10 },
  liquidationPx: 108,
  marginUsed: 20,
  unrealizedPnl: -3,
  positionValue: -206,
  returnOnEquity: -0.1,
  maxLeverage: 40,
};

function estado(extra: Partial<EstadoCarteiraNoAtivo> = {}): EstadoCarteiraNoAtivo {
  return {
    user: '0x' + 'AB'.repeat(20),
    coin: 'BTC',
    dex: null,
    posicao: posicaoHl,
    ordensProtecao: [],
    accountValue: 5_000,
    modoConta: 'default',
    accountValueRepresentativo: true,
    mercado: { markPx: 103, midPx: 103.1, oraclePx: 102.9 },
    time: 1_000,
    ...extra,
  };
}

describe('eOrdemProtecao / converterOrdemProtecao', () => {
  it.each([
    ['SL de posição (isPositionTpsl)', ordem({ reduceOnly: false }), true],
    ['SL reduceOnly', ordem({ isPositionTpsl: false }), true],
    ['TP reduceOnly', ordem({ protecao: 'take_profit', orderType: 'Take Profit Market' }), true],
    ['stop de entrada não redutor', ordem({ reduceOnly: false, isPositionTpsl: false }), false],
    ['ordem limite (sem trigger)', ordem({ isTrigger: false, triggerPx: null }), false],
    ['trigger não classificado', ordem({ protecao: null }), false],
    ['trigger sem preço', ordem({ triggerPx: null }), false],
  ])('%s', (_nome, o, esperado) => {
    expect(eOrdemProtecao(o)).toBe(esperado);
    expect(converterOrdemProtecao(o) !== null).toBe(esperado);
  });

  it('tamanho 0 = posição inteira (null); tamanho explícito mantém-se', () => {
    expect(converterOrdemProtecao(ordem())).toEqual({
      tipo: 'SL',
      triggerPx: 90,
      tamanho: null,
      reduceOnly: true,
      oid: 1,
    });
    expect(converterOrdemProtecao(ordem({ tamanho: 0.5, protecao: 'take_profit' }))).toMatchObject({
      tipo: 'TP',
      tamanho: 0.5,
    });
  });
});

describe('ordenarProtecoes', () => {
  it('ordena por tipo, preço, tamanho (null primeiro) e oid, sem mutar a entrada', () => {
    const entrada = [
      { tipo: 'TP' as const, triggerPx: 110, tamanho: null, oid: 1 },
      { tipo: 'SL' as const, triggerPx: 90, tamanho: 2, oid: 3 },
      { tipo: 'SL' as const, triggerPx: 90, tamanho: 2, oid: 2 },
      { tipo: 'SL' as const, triggerPx: 90, tamanho: null, oid: 9 },
      { tipo: 'SL' as const, triggerPx: 80, tamanho: 1 },
    ];
    const copia = structuredClone(entrada);
    expect(ordenarProtecoes(entrada).map((o) => [o.tipo, o.triggerPx, o.tamanho, o.oid])).toEqual([
      ['SL', 80, 1, undefined],
      ['SL', 90, null, 9],
      ['SL', 90, 2, 2],
      ['SL', 90, 2, 3],
      ['TP', 110, null, 1],
    ]);
    expect(entrada).toEqual(copia);
  });
});

describe('snapshotDeEstado', () => {
  it('converte posição, mercado e instante; endereço em minúsculas', () => {
    const s = snapshotDeEstado(estado());
    expect(s).toEqual({
      carteira: '0x' + 'ab'.repeat(20),
      ativo: 'BTC',
      instante: 1_000,
      posicao: {
        lado: 'short',
        tamanho: 2,
        entryPx: 100,
        leverage: 10,
        tipoMargem: 'isolated',
        liquidationPx: 108,
        margem: 20,
        pnl: -3,
        notional: 206,
      },
      ordensProtecao: [],
      accountValue: 5_000,
      precoMercado: 103,
    });
    expect(snapshotDeEstado(estado(), 42).instante).toBe(42);
  });

  it('sem posição ou com tamanho 0 ⇒ posicao null', () => {
    expect(snapshotDeEstado(estado({ posicao: null })).posicao).toBeNull();
    expect(snapshotDeEstado(estado({ posicao: { ...posicaoHl, tamanho: 0 } })).posicao).toBeNull();
  });

  it('filtra stops de entrada não redutores, ordens de outro ativo e ordena as restantes', () => {
    const s = snapshotDeEstado(
      estado({
        ordensProtecao: [
          ordem({ oid: 5, protecao: 'take_profit', triggerPx: 90 }),
          ordem({ oid: 6, triggerPx: 110, isPositionTpsl: false, tamanho: 2 }),
          ordem({ oid: 7, triggerPx: 95, reduceOnly: false, isPositionTpsl: false }),
          ordem({ oid: 8, coin: 'ETH' }),
        ],
      }),
    );
    expect(s.ordensProtecao).toEqual([
      { tipo: 'SL', triggerPx: 110, tamanho: 2, reduceOnly: true, oid: 6 },
      { tipo: 'TP', triggerPx: 90, tamanho: null, reduceOnly: true, oid: 5 },
    ]);
  });

  it('aceita as ordens normalizadas da fixture real (SL e TP de posição)', () => {
    const ordens = normalizarOrdens(
      frontendOpenOrdersRespostaSchema.parse(carregarFixture('frontendOpenOrders-com-triggers')),
    );
    const s = snapshotDeEstado(estado({ ordensProtecao: ordens }));
    expect(s.ordensProtecao.map((o) => [o.tipo, o.triggerPx, o.tamanho])).toEqual([
      ['SL', 65800, null],
      ['TP', 57700, null],
    ]);
  });
});
