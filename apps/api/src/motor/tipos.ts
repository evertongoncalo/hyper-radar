import type {
  EstadoCarteiraNoAtivo,
  LadoPosicao,
  OrdemAberta,
  Posicao,
  TipoMargem,
} from '@hyper-radar/shared';

/** Tipo de ordem de proteção, igual ao enum `order_kind` da BD. */
export type TipoProtecaoMotor = 'SL' | 'TP';

export interface PosicaoMotor {
  lado: LadoPosicao;
  /** Tamanho absoluto, em unidades do ativo (> 0). */
  tamanho: number;
  entryPx: number;
  leverage: number;
  tipoMargem: TipoMargem;
  liquidationPx: number | null;
  margem: number;
  pnl: number;
  /** Notional absoluto em USD (`positionValue`). */
  notional: number;
}

export interface OrdemProtecaoMotor {
  tipo: TipoProtecaoMotor;
  triggerPx: number;
  /** `null` = posição inteira (TP/SL de posição). */
  tamanho: number | null;
  reduceOnly: boolean;
  oid: number;
}

/** Fotografia de uma carteira num ativo, num instante (entrada do motor). */
export interface SnapshotCarteira {
  /** Endereço em minúsculas. */
  carteira: string;
  /** Ticker (ex.: `BTC`, `xyz:NVDA`). */
  ativo: string;
  /** Instante do snapshot (ms). */
  instante: number;
  posicao: PosicaoMotor | null;
  /** Só ordens que protegem a posição (trigger redutoras), por ordem determinística. */
  ordensProtecao: OrdemProtecaoMotor[];
  accountValue: number;
  precoMercado: number;
}

/**
 * Uma ordem só conta como SL/TP se for trigger classificada **e** redutora (`reduceOnly`) ou
 * associada à posição (`isPositionTpsl`). Um stop de entrada não redutor abre/aumenta posição:
 * não é proteção.
 */
export function eOrdemProtecao(ordem: OrdemAberta): boolean {
  return (
    ordem.isTrigger &&
    ordem.protecao !== null &&
    ordem.triggerPx !== null &&
    (ordem.reduceOnly || ordem.isPositionTpsl)
  );
}

/** Converte uma ordem aberta em ordem de proteção do motor; `null` se não for proteção. */
export function converterOrdemProtecao(ordem: OrdemAberta): OrdemProtecaoMotor | null {
  if (!eOrdemProtecao(ordem) || ordem.triggerPx === null) return null;
  return {
    tipo: ordem.protecao === 'take_profit' ? 'TP' : 'SL',
    triggerPx: ordem.triggerPx,
    // Tamanho 0 (típico de `isPositionTpsl`) significa "toda a posição".
    tamanho: ordem.tamanho > 0 ? ordem.tamanho : null,
    reduceOnly: ordem.reduceOnly,
    oid: ordem.oid,
  };
}

/** Ordenação estável e determinística: tipo, triggerPx, tamanho (`null` primeiro), oid. */
export function ordenarProtecoes<
  T extends Pick<OrdemProtecaoMotor, 'tipo' | 'triggerPx' | 'tamanho'> & { oid?: number },
>(ordens: readonly T[]): T[] {
  const oid = (o: T) => o.oid ?? 0;
  return [...ordens].sort(
    (a, b) =>
      a.tipo.localeCompare(b.tipo) ||
      a.triggerPx - b.triggerPx ||
      (a.tamanho ?? -1) - (b.tamanho ?? -1) ||
      oid(a) - oid(b),
  );
}

export function converterPosicao(posicao: Posicao): PosicaoMotor | null {
  if (!(posicao.tamanho > 0)) return null;
  return {
    lado: posicao.lado,
    tamanho: posicao.tamanho,
    entryPx: posicao.entryPx,
    leverage: posicao.leverage.valor,
    tipoMargem: posicao.leverage.tipo,
    liquidationPx: posicao.liquidationPx,
    margem: posicao.marginUsed,
    pnl: posicao.unrealizedPnl,
    notional: Math.abs(posicao.positionValue),
  };
}

/**
 * Snapshot do motor a partir do estado devolvido pelo cliente Hyperliquid. O instante é
 * explícito (omissão: `estado.time`, a hora do servidor); nunca se lê o relógio aqui.
 */
export function snapshotDeEstado(
  estado: EstadoCarteiraNoAtivo,
  instante: number = estado.time,
): SnapshotCarteira {
  const ordens = estado.ordensProtecao
    .filter((o) => o.coin === estado.coin)
    .map(converterOrdemProtecao)
    .filter((o): o is OrdemProtecaoMotor => o !== null);
  return {
    carteira: estado.user.toLowerCase(),
    ativo: estado.coin,
    instante,
    posicao: estado.posicao ? converterPosicao(estado.posicao) : null,
    ordensProtecao: ordenarProtecoes(ordens),
    accountValue: estado.accountValue,
    precoMercado: estado.mercado.markPx,
  };
}
