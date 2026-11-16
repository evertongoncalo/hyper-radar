import { and, asc, desc, eq, inArray, lt, lte, type SQL } from 'drizzle-orm';
import {
  analysisRuns,
  orders,
  positions,
  snapshots,
  type Order,
  type Position,
  type Snapshot,
} from '../db/schema';
import {
  decimalOuNuloParaNumero,
  decimalParaNumero,
  numeroOuNuloParaDecimal,
  numeroParaDecimal,
  type Executor,
} from './comum';
import { comTraducao, ErroNaoEncontrado, ErroRunFechado } from './erros';

export interface PosicaoGravada {
  lado: Position['side'];
  /** Tamanho absoluto, em unidades do ativo. */
  tamanho: number;
  entryPx: number;
  alavancagem: number;
  tipoMargem: Position['marginType'];
  liquidationPx: number | null;
  unrealizedPnl: number;
  marginUsed: number;
  notional: number;
}

export interface OrdemGravada {
  tipo: Order['kind'];
  triggerPx: number;
  /** `null` = ordem sobre a posição inteira. */
  tamanho: number | null;
  reduceOnly: boolean;
  /** `oid` da Hyperliquid. */
  oid: number;
}

export interface SnapshotCompleto {
  id: number;
  runId: number;
  walletId: number;
  assetId: number;
  accountValue: number;
  marketPx: number | null;
  instante: Date;
  posicao: PosicaoGravada | null;
  ordens: OrdemGravada[];
}

export interface NovoSnapshot {
  runId: number;
  walletId: number;
  accountValue: number;
  marketPx: number | null;
  /** Instante do ciclo; por omissão `now()` da BD. */
  instante?: Date;
  posicao: PosicaoGravada | null;
  ordens: OrdemGravada[];
}

function paraPosicao(l: Position): PosicaoGravada {
  return {
    lado: l.side,
    tamanho: decimalParaNumero(l.size),
    entryPx: decimalParaNumero(l.entryPx),
    alavancagem: l.leverage,
    tipoMargem: l.marginType,
    liquidationPx: decimalOuNuloParaNumero(l.liquidationPx),
    unrealizedPnl: decimalParaNumero(l.unrealizedPnl),
    marginUsed: decimalParaNumero(l.marginUsed),
    notional: decimalParaNumero(l.notional),
  };
}

function paraOrdem(l: Order): OrdemGravada {
  return {
    tipo: l.kind,
    triggerPx: decimalParaNumero(l.triggerPx),
    tamanho: decimalOuNuloParaNumero(l.size),
    reduceOnly: l.reduceOnly,
    oid: l.exchangeOrderId,
  };
}

function montar(s: Snapshot, posicao: Position | undefined, ordens: Order[]): SnapshotCompleto {
  return {
    id: s.id,
    runId: s.runId,
    walletId: s.walletId,
    assetId: s.assetId,
    accountValue: decimalParaNumero(s.accountValue),
    marketPx: decimalOuNuloParaNumero(s.marketPx),
    instante: s.takenAt,
    posicao: posicao ? paraPosicao(posicao) : null,
    ordens: ordens.map(paraOrdem),
  };
}

/** Carrega posições e ordens de vários snapshots em duas consultas (sem N+1). */
async function completar(db: Executor, lista: Snapshot[]): Promise<SnapshotCompleto[]> {
  if (lista.length === 0) return [];
  const ids = lista.map((s) => s.id);
  const [pos, ords] = await Promise.all([
    db.select().from(positions).where(inArray(positions.snapshotId, ids)),
    db
      .select()
      .from(orders)
      .where(inArray(orders.snapshotId, ids))
      .orderBy(asc(orders.snapshotId), asc(orders.id)),
  ]);
  const posPorSnap = new Map(pos.map((p) => [p.snapshotId, p]));
  const ordsPorSnap = new Map<number, Order[]>();
  for (const o of ords) {
    const l = ordsPorSnap.get(o.snapshotId) ?? [];
    l.push(o);
    ordsPorSnap.set(o.snapshotId, l);
  }
  return lista.map((s) => montar(s, posPorSnap.get(s.id), ordsPorSnap.get(s.id) ?? []));
}

/**
 * Grava snapshot + posição (0 ou 1) + ordens SL/TP numa única transação:
 * qualquer falha a meio desfaz tudo. O ativo é o do run, que tem de estar em curso.
 */
export async function gravarSnapshot(db: Executor, novo: NovoSnapshot): Promise<SnapshotCompleto> {
  return comTraducao(() =>
    db.transaction(async (tx) => {
      const [run] = await tx
        .select({ assetId: analysisRuns.assetId, endedAt: analysisRuns.endedAt })
        .from(analysisRuns)
        .where(eq(analysisRuns.id, novo.runId))
        .for('share');
      if (!run) throw new ErroNaoEncontrado('Run', novo.runId);
      if (run.endedAt !== null) throw new ErroRunFechado(novo.runId);

      const [snap] = await tx
        .insert(snapshots)
        .values({
          runId: novo.runId,
          walletId: novo.walletId,
          assetId: run.assetId,
          accountValue: numeroParaDecimal(novo.accountValue),
          marketPx: numeroOuNuloParaDecimal(novo.marketPx),
          ...(novo.instante ? { takenAt: novo.instante } : {}),
        })
        .returning();

      let posicao: Position | undefined;
      if (novo.posicao) {
        const p = novo.posicao;
        [posicao] = await tx
          .insert(positions)
          .values({
            snapshotId: snap!.id,
            side: p.lado,
            size: numeroParaDecimal(p.tamanho),
            entryPx: numeroParaDecimal(p.entryPx),
            leverage: p.alavancagem,
            marginType: p.tipoMargem,
            liquidationPx: numeroOuNuloParaDecimal(p.liquidationPx),
            unrealizedPnl: numeroParaDecimal(p.unrealizedPnl),
            marginUsed: numeroParaDecimal(p.marginUsed),
            notional: numeroParaDecimal(p.notional),
          })
          .returning();
      }

      const ords =
        novo.ordens.length === 0
          ? []
          : await tx
              .insert(orders)
              .values(
                novo.ordens.map((o) => ({
                  snapshotId: snap!.id,
                  kind: o.tipo,
                  triggerPx: numeroParaDecimal(o.triggerPx),
                  size: numeroOuNuloParaDecimal(o.tamanho),
                  reduceOnly: o.reduceOnly,
                  exchangeOrderId: o.oid,
                })),
              )
              .returning();

      return montar(snap!, posicao, ords);
    }),
  );
}

/** Último snapshot da carteira no run (base do diff), com posição e ordens. */
export async function ultimoSnapshot(
  db: Executor,
  runId: number,
  walletId: number,
): Promise<SnapshotCompleto | null> {
  const lista = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.runId, runId), eq(snapshots.walletId, walletId)))
    .orderBy(desc(snapshots.takenAt), desc(snapshots.id))
    .limit(1);
  const [completo] = await completar(db, lista);
  return completo ?? null;
}

/**
 * Último snapshot de cada carteira no ativo (base dos agregados do ciclo atual).
 * `runId` restringe a um run (ex.: o run em curso); `ate` devolve o estado nesse instante
 * (último snapshot com `instante <= ate`), útil para as variações face a 1 h / 24 h.
 */
export async function ultimosSnapshotsPorCarteira(
  db: Executor,
  assetId: number,
  opcoes: { runId?: number; ate?: Date } = {},
): Promise<SnapshotCompleto[]> {
  const filtros: SQL[] = [eq(snapshots.assetId, assetId)];
  if (opcoes.runId !== undefined) filtros.push(eq(snapshots.runId, opcoes.runId));
  if (opcoes.ate) filtros.push(lte(snapshots.takenAt, opcoes.ate));
  const lista = await db
    .selectDistinctOn([snapshots.walletId])
    .from(snapshots)
    .where(and(...filtros))
    .orderBy(asc(snapshots.walletId), desc(snapshots.takenAt), desc(snapshots.id));
  return completar(db, lista);
}

/**
 * Snapshot mais próximo de um instante passado, sem o ultrapassar (último com `instante <= alvo`).
 * Devolve `null` se não houver histórico até esse instante (variação indisponível).
 */
export async function snapshotMaisProximo(
  db: Executor,
  assetId: number,
  walletId: number,
  instante: Date,
): Promise<SnapshotCompleto | null> {
  const lista = await db
    .select()
    .from(snapshots)
    .where(
      and(
        eq(snapshots.assetId, assetId),
        eq(snapshots.walletId, walletId),
        lte(snapshots.takenAt, instante),
      ),
    )
    .orderBy(desc(snapshots.takenAt), desc(snapshots.id))
    .limit(1);
  const [completo] = await completar(db, lista);
  return completo ?? null;
}

/**
 * Política de retenção: apaga snapshots (e, por cascata, posições e ordens) anteriores à data.
 * Eventos e relatórios IA não são afetados. Devolve o número de snapshots apagados.
 */
export async function apagarSnapshotsAnterioresA(db: Executor, data: Date): Promise<number> {
  // Sem `returning`: o resultado do postgres-js já traz a contagem, sem transferir os ids.
  const resultado = await db.delete(snapshots).where(lt(snapshots.takenAt, data));
  return resultado.count;
}
