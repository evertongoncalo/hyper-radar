import type {
  AtivoPerp,
  clearinghouseStateRespostaSchema,
  DexPerp,
  EstadoConta,
  Fill,
  frontendOpenOrdersRespostaSchema,
  MercadoAtivo,
  metaAndAssetCtxsRespostaSchema,
  MetaDex,
  metaRespostaSchema,
  OrdemAberta,
  perpDexsRespostaSchema,
  TipoProtecao,
  userFillsRespostaSchema,
} from '@hyper-radar/shared';
import type { z } from 'zod';
import { ErroRespostaInvalida } from './erros';

type Saida<S extends z.ZodType> = z.output<S>;

/** DEX a que pertence um `coin` (HIP-3 vem prefixado, ex.: `xyz:NVDA`); `null` se nativo/spot. */
export function dexDoCoin(coin: string): string | null {
  const indice = coin.indexOf(':');
  return indice > 0 ? coin.slice(0, indice) : null;
}

const ladoOrdem = (side: 'A' | 'B') => (side === 'B' ? 'compra' : 'venda');

export function normalizarPerpDexs(bruto: Saida<typeof perpDexsRespostaSchema>): DexPerp[] {
  return bruto.flatMap((dex, indice) =>
    dex ? [{ indice, name: dex.name, fullName: dex.fullName, deployer: dex.deployer }] : [],
  );
}

export function normalizarMeta(
  bruto: Saida<typeof metaRespostaSchema>,
  dex: string | null,
): MetaDex {
  return {
    dex,
    collateralToken: bruto.collateralToken ?? null,
    ativos: bruto.universe.map((a): AtivoPerp => ({
      coin: a.name,
      dex,
      szDecimals: a.szDecimals,
      maxLeverage: a.maxLeverage,
      onlyIsolated: a.onlyIsolated ?? false,
      isDelisted: a.isDelisted ?? false,
    })),
  };
}

export function normalizarMetaAndAssetCtxs(
  bruto: Saida<typeof metaAndAssetCtxsRespostaSchema>,
  dex: string | null,
): MercadoAtivo[] {
  const [meta, contextos] = bruto;
  if (meta.universe.length !== contextos.length) {
    throw new ErroRespostaInvalida(
      `metaAndAssetCtxs com ${meta.universe.length} ativos e ${contextos.length} contextos.`,
    );
  }
  return normalizarMeta(meta, dex).ativos.map((ativo, i) => {
    const c = contextos[i]!;
    return {
      ...ativo,
      markPx: c.markPx,
      midPx: c.midPx,
      oraclePx: c.oraclePx,
      funding: c.funding,
      premium: c.premium,
      openInterest: c.openInterest,
      prevDayPx: c.prevDayPx,
      dayNtlVlm: c.dayNtlVlm,
    };
  });
}

export function normalizarClearinghouseState(
  bruto: Saida<typeof clearinghouseStateRespostaSchema>,
  dex: string | null,
): EstadoConta {
  return {
    dex,
    accountValue: bruto.marginSummary.accountValue,
    totalMarginUsed: bruto.marginSummary.totalMarginUsed,
    totalNtlPos: bruto.marginSummary.totalNtlPos,
    withdrawable: bruto.withdrawable,
    crossMaintenanceMarginUsed: bruto.crossMaintenanceMarginUsed,
    time: bruto.time,
    posicoes: bruto.assetPositions
      .map((a) => a.position)
      .filter((p) => p.szi !== 0)
      .map((p) => ({
        coin: p.coin,
        dex: dexDoCoin(p.coin),
        lado: p.szi > 0 ? 'long' : 'short',
        tamanho: Math.abs(p.szi),
        szi: p.szi,
        entryPx: p.entryPx,
        leverage: { tipo: p.leverage.type, valor: p.leverage.value },
        liquidationPx: p.liquidationPx,
        marginUsed: p.marginUsed,
        unrealizedPnl: p.unrealizedPnl,
        positionValue: p.positionValue,
        returnOnEquity: p.returnOnEquity,
        maxLeverage: p.maxLeverage,
      })),
  };
}

/** Classifica uma ordem de trigger como SL ou TP a partir de `orderType`. */
export function classificarProtecao(isTrigger: boolean, orderType: string): TipoProtecao | null {
  if (!isTrigger) return null;
  if (orderType.startsWith('Take Profit')) return 'take_profit';
  if (orderType.startsWith('Stop')) return 'stop_loss';
  return null;
}

export function normalizarOrdens(
  bruto: Saida<typeof frontendOpenOrdersRespostaSchema>,
): OrdemAberta[] {
  return bruto.map((o) => ({
    oid: o.oid,
    coin: o.coin,
    dex: dexDoCoin(o.coin),
    lado: ladoOrdem(o.side),
    tamanho: o.sz,
    tamanhoOriginal: o.origSz,
    limitPx: o.limitPx,
    isTrigger: o.isTrigger,
    triggerPx: o.isTrigger ? o.triggerPx : null,
    triggerCondition: o.triggerCondition,
    orderType: o.orderType,
    reduceOnly: o.reduceOnly,
    isPositionTpsl: o.isPositionTpsl,
    protecao: classificarProtecao(o.isTrigger, o.orderType),
    timestamp: o.timestamp,
  }));
}

/** Ordens de proteção (trigger SL/TP) de um ativo. */
export function extrairOrdensProtecao(ordens: OrdemAberta[], coin: string): OrdemAberta[] {
  return ordens.filter((o) => o.coin === coin && o.isTrigger);
}

export function normalizarFills(bruto: Saida<typeof userFillsRespostaSchema>): Fill[] {
  return bruto.map((f) => ({
    coin: f.coin,
    dex: dexDoCoin(f.coin),
    px: f.px,
    sz: f.sz,
    lado: ladoOrdem(f.side),
    time: f.time,
    startPosition: f.startPosition,
    dir: f.dir,
    closedPnl: f.closedPnl,
    fee: f.fee,
    feeToken: f.feeToken,
    oid: f.oid,
    tid: f.tid,
    crossed: f.crossed,
    liquidacao: f.liquidation !== undefined,
  }));
}
