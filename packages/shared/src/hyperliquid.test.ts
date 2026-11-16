import { describe, expect, it } from 'vitest';
import {
  allMidsRespostaSchema,
  clearinghouseStateRespostaSchema,
  decimalHlSchema,
  frontendOpenOrdersRespostaSchema,
  metaAndAssetCtxsRespostaSchema,
  metaRespostaSchema,
  perpDexsRespostaSchema,
  separarTicker,
  userAbstractionRespostaSchema,
  userFillsRespostaSchema,
} from './index';

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

  it('preserva a precisão de preços e tamanhos típicos da Hyperliquid', () => {
    for (const texto of ['0.1390885294', '66166.0541200163', '154890.64328', '-0.00000001']) {
      expect(String(decimalHlSchema.parse(texto))).toBe(String(Number(texto)));
      expect(decimalHlSchema.parse(texto)).toBe(Number.parseFloat(texto));
    }
    expect(Object.is(decimalHlSchema.parse('-0.0'), -0)).toBe(true);
  });
});

// Objetos mínimos com o formato real das respostas (valores fictícios).
const ctx = {
  markPx: '1.5',
  midPx: null,
  oraclePx: '1.5',
  funding: '0.0000125',
  premium: null,
  openInterest: '10.0',
  prevDayPx: '1.4',
  dayNtlVlm: '0.0',
  impactPxs: null,
};
const posicao = {
  coin: 'xyz:NVDA',
  szi: '-3.5',
  leverage: { type: 'isolated', value: 5, rawUsd: '-100.0' },
  entryPx: '150.0',
  positionValue: '525.0',
  unrealizedPnl: '0.0',
  returnOnEquity: '0.0',
  liquidationPx: null,
  marginUsed: '105.0',
  maxLeverage: 10,
  cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' },
};
const resumo = {
  accountValue: '1.0',
  totalNtlPos: '0.0',
  totalRawUsd: '1.0',
  totalMarginUsed: '0.0',
};
const estado = {
  marginSummary: resumo,
  crossMarginSummary: resumo,
  crossMaintenanceMarginUsed: '0.0',
  withdrawable: '1.0',
  assetPositions: [{ type: 'oneWay', position: posicao }],
  time: 1,
};
const ordem = {
  coin: 'BTC',
  side: 'B',
  limitPx: '1.0',
  sz: '0.0',
  origSz: '0.0',
  oid: 1,
  timestamp: 1,
  isTrigger: true,
  triggerPx: '1.0',
  triggerCondition: 'Price above 1',
  isPositionTpsl: true,
  reduceOnly: true,
  orderType: 'Stop Market',
  tif: null,
  cloid: null,
  children: [],
};
const fill = {
  coin: 'BTC',
  px: '1.0',
  sz: '1.0',
  side: 'A',
  time: 1,
  startPosition: '0.0',
  dir: 'Open Short',
  closedPnl: '0.0',
  oid: 1,
  tid: 1,
  crossed: true,
  fee: '0.0',
  feeToken: 'USDC',
  hash: '0x' + '0'.repeat(64),
  builderFee: '0.0',
};

describe('schemas das respostas: tolerância a campos novos', () => {
  it('clearinghouseState aceita campos desconhecidos e descarta-os', () => {
    const r = clearinghouseStateRespostaSchema.parse({ ...estado, campoNovo: 1 });
    expect(r.assetPositions[0]!.position.szi).toBe(-3.5);
    expect(r.assetPositions[0]!.position.liquidationPx).toBeNull();
    expect(r.assetPositions[0]!.position).not.toHaveProperty('cumFunding');
    expect(r).not.toHaveProperty('campoNovo');
  });

  it('frontendOpenOrders e userFills aceitam campos extra (tif, cloid, hash, builderFee)', () => {
    expect(frontendOpenOrdersRespostaSchema.parse([ordem])[0]!.sz).toBe(0);
    expect(userFillsRespostaSchema.parse([fill])[0]).not.toHaveProperty('hash');
  });

  it('meta, perpDexs e metaAndAssetCtxs aceitam campos extra', () => {
    const meta = {
      universe: [{ name: 'xyz:NVDA', szDecimals: 3, maxLeverage: 10, marginTableId: 10 }],
      marginTables: [],
    };
    expect(metaRespostaSchema.parse(meta).collateralToken).toBeUndefined();
    expect(
      perpDexsRespostaSchema.parse([null, { name: 'xyz', fullName: 'XYZ', deployer: '0x0', x: 1 }]),
    ).toHaveLength(2);
    expect(metaAndAssetCtxsRespostaSchema.parse([meta, [ctx]])[1][0]!.midPx).toBeNull();
  });

  it('metaAndAssetCtxs tolera elementos adicionais no fim do tuplo', () => {
    const meta = { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] };
    expect(metaAndAssetCtxsRespostaSchema.safeParse([meta, [ctx], {}]).success).toBe(true);
  });
});

describe('schemas das respostas: rejeição de dados incoerentes', () => {
  it.each([
    ['lado desconhecido', [{ ...ordem, side: 'C' }]],
    ['oid não inteiro', [{ ...ordem, oid: 1.5 }]],
    ['sz numérico', [{ ...ordem, sz: 0 }]],
  ])('frontendOpenOrders rejeita %s', (_caso, corpo) => {
    expect(frontendOpenOrdersRespostaSchema.safeParse(corpo).success).toBe(false);
  });

  it('clearinghouseState rejeita tipo de margem desconhecido e campos obrigatórios em falta', () => {
    const margemNova = { ...posicao, leverage: { type: 'outra', value: 1 } };
    const semMargem = structuredClone(estado) as Partial<typeof estado>;
    delete semMargem.marginSummary;
    expect(
      clearinghouseStateRespostaSchema.safeParse({
        ...estado,
        assetPositions: [{ type: 'oneWay', position: margemNova }],
      }).success,
    ).toBe(false);
    expect(clearinghouseStateRespostaSchema.safeParse(semMargem).success).toBe(false);
  });

  it('userAbstraction rejeita string vazia; allMids rejeita preços numéricos', () => {
    expect(userAbstractionRespostaSchema.safeParse('').success).toBe(false);
    expect(allMidsRespostaSchema.safeParse({ BTC: 1 }).success).toBe(false);
  });
});
