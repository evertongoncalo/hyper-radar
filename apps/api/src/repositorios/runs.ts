import { and, eq, isNull, sql } from 'drizzle-orm';
import { analysisRuns, assets, type AnalysisRun } from '../db/schema';
import type { Executor } from './comum';
import { comTraducao, ErroNaoEncontrado } from './erros';

export interface Run {
  id: number;
  assetId: number;
  inicio: Date;
  /** `null` enquanto o run está em curso. */
  fim: Date | null;
  motivoReinicio: string | null;
}

function paraRun(linha: AnalysisRun): Run {
  return {
    id: linha.id,
    assetId: linha.assetId,
    inicio: linha.startedAt,
    fim: linha.endedAt,
    motivoReinicio: linha.restartReason,
  };
}

/**
 * Abre um novo run para o ativo, fechando na mesma transação o run em curso (se houver).
 * A linha do ativo é bloqueada (`FOR UPDATE`) para serializar aberturas concorrentes;
 * o índice único parcial `analysis_runs_one_open_per_asset` garante o invariante na BD.
 */
export async function abrirRun(
  db: Executor,
  assetId: number,
  motivoReinicio: string | null = null,
): Promise<Run> {
  return comTraducao(() =>
    db.transaction(async (tx) => {
      const [ativo] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.id, assetId))
        .for('update');
      if (!ativo) throw new ErroNaoEncontrado('Ativo', assetId);

      await tx
        .update(analysisRuns)
        .set({ endedAt: sql`greatest(now(), ${analysisRuns.startedAt})` })
        .where(and(eq(analysisRuns.assetId, assetId), isNull(analysisRuns.endedAt)));
      const [linha] = await tx
        .insert(analysisRuns)
        .values({ assetId, restartReason: motivoReinicio })
        .returning();
      return paraRun(linha!);
    }),
  );
}

/** Fecha o run (idempotente: um run já fechado é devolvido sem alterações). */
export async function fecharRun(db: Executor, runId: number, fim?: Date): Promise<Run> {
  const [fechado] = await comTraducao(() =>
    db
      .update(analysisRuns)
      .set({ endedAt: fim ?? sql`greatest(now(), ${analysisRuns.startedAt})` })
      .where(and(eq(analysisRuns.id, runId), isNull(analysisRuns.endedAt)))
      .returning(),
  );
  if (fechado) return paraRun(fechado);
  const [existente] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
  if (!existente) throw new ErroNaoEncontrado('Run', runId);
  return paraRun(existente);
}

/** Run em curso do ativo, ou `null`. */
export async function obterRunAtivo(db: Executor, assetId: number): Promise<Run | null> {
  const [linha] = await db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.assetId, assetId), isNull(analysisRuns.endedAt)));
  return linha ? paraRun(linha) : null;
}

export async function obterRunPorId(db: Executor, runId: number): Promise<Run | null> {
  const [linha] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
  return linha ? paraRun(linha) : null;
}
