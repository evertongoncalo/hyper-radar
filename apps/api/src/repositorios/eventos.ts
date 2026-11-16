import { and, count, desc, eq, gte, inArray, lt, lte, type SQL } from 'drizzle-orm';
import { assets, events, wallets, type Event } from '../db/schema';
import type { Executor } from './comum';
import { comTraducao, ErroValorInvalido } from './erros';

export type TipoEvento = Event['type'];

export interface Evento {
  id: number;
  tipo: TipoEvento;
  walletId: number;
  assetId: number;
  runId: number | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
  lido: boolean;
  criadoEm: Date;
}

/** Evento com o contexto necessário ao feed e às notificações (ticker, endereço e alias). */
export interface EventoDetalhado extends Evento {
  ticker: string;
  endereco: string;
  alias: string | null;
}

export interface NovoEvento {
  tipo: TipoEvento;
  walletId: number;
  assetId: number;
  runId?: number | null;
  payload?: Record<string, unknown>;
  /** Chave de deduplicação calculada pelo motor (carteira + ativo + tipo + janela). */
  dedupeKey: string;
  criadoEm?: Date;
}

export interface FiltrosEventos {
  assetId?: number;
  walletId?: number;
  tipos?: TipoEvento[];
  apenasNaoLidos?: boolean;
  /** Intervalo inclusivo sobre `criadoEm`. */
  desde?: Date;
  ate?: Date;
  /** `proximoCursor` devolvido pela página anterior. */
  cursor?: number | null;
  /** Tamanho da página (omissão 50, máximo 200). */
  limite?: number;
}

export interface PaginaEventos {
  itens: EventoDetalhado[];
  /** `null` quando não há mais páginas. */
  proximoCursor: number | null;
}

export const LIMITE_PAGINA_OMISSAO = 50;
export const LIMITE_PAGINA_MAXIMO = 200;

function paraEvento(l: Event): Evento {
  return {
    id: l.id,
    tipo: l.type,
    walletId: l.walletId,
    assetId: l.assetId,
    runId: l.runId,
    payload: l.payload,
    dedupeKey: l.dedupeKey,
    lido: l.read,
    criadoEm: l.createdAt,
  };
}

/**
 * Grava eventos de forma idempotente (`ON CONFLICT (dedupe_key) DO NOTHING`).
 * Devolve apenas os efetivamente inseridos (os únicos a notificar).
 */
export async function gravarEventos(db: Executor, lista: NovoEvento[]): Promise<Evento[]> {
  if (lista.length === 0) return [];
  const linhas = await comTraducao(() =>
    db
      .insert(events)
      .values(
        lista.map((e) => ({
          type: e.tipo,
          walletId: e.walletId,
          assetId: e.assetId,
          runId: e.runId ?? null,
          payload: e.payload ?? {},
          dedupeKey: e.dedupeKey,
          ...(e.criadoEm ? { createdAt: e.criadoEm } : {}),
        })),
      )
      .onConflictDoNothing({ target: events.dedupeKey })
      .returning(),
  );
  return linhas.map(paraEvento).sort((a, b) => a.id - b.id);
}

/**
 * Lista eventos do mais recente para o mais antigo, com paginação por cursor sobre o `id`
 * (identidade crescente): estável mesmo com inserções novas entre páginas.
 */
export async function listarEventos(
  db: Executor,
  filtros: FiltrosEventos = {},
): Promise<PaginaEventos> {
  const limite = filtros.limite ?? LIMITE_PAGINA_OMISSAO;
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_PAGINA_MAXIMO) {
    throw new ErroValorInvalido(
      `o limite da página tem de ser um inteiro entre 1 e ${LIMITE_PAGINA_MAXIMO}.`,
    );
  }

  const cond: SQL[] = [];
  if (filtros.assetId !== undefined) cond.push(eq(events.assetId, filtros.assetId));
  if (filtros.walletId !== undefined) cond.push(eq(events.walletId, filtros.walletId));
  if (filtros.tipos && filtros.tipos.length > 0) cond.push(inArray(events.type, filtros.tipos));
  if (filtros.apenasNaoLidos) cond.push(eq(events.read, false));
  if (filtros.desde) cond.push(gte(events.createdAt, filtros.desde));
  if (filtros.ate) cond.push(lte(events.createdAt, filtros.ate));
  if (filtros.cursor !== undefined && filtros.cursor !== null)
    cond.push(lt(events.id, filtros.cursor));

  const linhas = await db
    .select({
      evento: events,
      ticker: assets.ticker,
      endereco: wallets.address,
      alias: wallets.alias,
    })
    .from(events)
    .innerJoin(assets, eq(events.assetId, assets.id))
    .innerJoin(wallets, eq(events.walletId, wallets.id))
    .where(cond.length > 0 ? and(...cond) : undefined)
    .orderBy(desc(events.id))
    .limit(limite + 1);

  const temMais = linhas.length > limite;
  const itens = linhas.slice(0, limite).map((l) => ({
    ...paraEvento(l.evento),
    ticker: l.ticker,
    endereco: l.endereco,
    alias: l.alias,
  }));
  return { itens, proximoCursor: temMais ? (itens.at(-1)?.id ?? null) : null };
}

/** Marca um evento como lido; devolve `false` se não existir. */
export async function marcarEventoLido(db: Executor, id: number): Promise<boolean> {
  const linhas = await db
    .update(events)
    .set({ read: true })
    .where(eq(events.id, id))
    .returning({ id: events.id });
  return linhas.length > 0;
}

/** Marca como lidos todos os eventos não lidos do ativo; devolve quantos foram alterados. */
export async function marcarEventosDoAtivoLidos(db: Executor, assetId: number): Promise<number> {
  const resultado = await db
    .update(events)
    .set({ read: true })
    .where(and(eq(events.assetId, assetId), eq(events.read, false)));
  return resultado.count;
}

/** Número de eventos não lidos (de um ativo, ou de todos). */
export async function contarEventosNaoLidos(db: Executor, assetId?: number): Promise<number> {
  const cond = [eq(events.read, false)];
  if (assetId !== undefined) cond.push(eq(events.assetId, assetId));
  const [linha] = await db
    .select({ n: count() })
    .from(events)
    .where(and(...cond));
  return linha?.n ?? 0;
}
