import type { PosicaoMotor, SnapshotCarteira } from '../motor';
import type { NovoSnapshot, PosicaoGravada, SnapshotCompleto } from '../repositorios';

/*
 * Conversão entre o snapshot do motor (`SnapshotCarteira`) e o snapshot persistido
 * (`NovoSnapshot`/`SnapshotCompleto`). Único sítio onde os dois formatos se cruzam.
 */

function posicaoParaGravada(p: PosicaoMotor): PosicaoGravada {
  return {
    lado: p.lado,
    tamanho: p.tamanho,
    entryPx: p.entryPx,
    // A coluna é inteira e ≥ 1; a Hyperliquid devolve alavancagens inteiras.
    alavancagem: Math.max(1, Math.round(p.leverage)),
    tipoMargem: p.tipoMargem,
    liquidationPx: p.liquidationPx,
    unrealizedPnl: p.pnl,
    marginUsed: p.margem,
    notional: p.notional,
  };
}

function gravadaParaPosicao(p: PosicaoGravada): PosicaoMotor {
  return {
    lado: p.lado,
    tamanho: p.tamanho,
    entryPx: p.entryPx,
    leverage: p.alavancagem,
    tipoMargem: p.tipoMargem,
    liquidationPx: p.liquidationPx,
    margem: p.marginUsed,
    pnl: p.unrealizedPnl,
    notional: p.notional,
  };
}

/** Snapshot do motor → registo a gravar no run indicado. */
export function paraNovoSnapshot(
  snapshot: SnapshotCarteira,
  runId: number,
  walletId: number,
): NovoSnapshot {
  return {
    runId,
    walletId,
    accountValue: snapshot.accountValue,
    marketPx: snapshot.precoMercado > 0 ? snapshot.precoMercado : null,
    instante: new Date(snapshot.instante),
    posicao: snapshot.posicao ? posicaoParaGravada(snapshot.posicao) : null,
    ordens: snapshot.ordensProtecao.map((o) => ({
      tipo: o.tipo,
      triggerPx: o.triggerPx,
      tamanho: o.tamanho,
      reduceOnly: o.reduceOnly,
      oid: o.oid,
    })),
  };
}

/** Snapshot persistido → snapshot do motor (para agregados e variações). */
export function deSnapshotGravado(
  gravado: SnapshotCompleto,
  endereco: string,
  ticker: string,
): SnapshotCarteira {
  return {
    carteira: endereco.toLowerCase(),
    ativo: ticker,
    instante: gravado.instante.getTime(),
    posicao: gravado.posicao ? gravadaParaPosicao(gravado.posicao) : null,
    ordensProtecao: gravado.ordens.map((o) => ({
      tipo: o.tipo,
      triggerPx: o.triggerPx,
      tamanho: o.tamanho,
      reduceOnly: o.reduceOnly,
      oid: o.oid,
    })),
    accountValue: gravado.accountValue,
    precoMercado: gravado.marketPx ?? 0,
  };
}
