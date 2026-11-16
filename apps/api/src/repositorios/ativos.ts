import { separarTicker } from '@hyper-radar/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import { assets, type Asset } from '../db/schema';
import type { Executor } from './comum';
import { comTraducao, ErroNaoEncontrado, ErroTickerInvalido } from './erros';

export type EstadoAtivo = Asset['status'];

export interface Ativo {
  id: number;
  /** Ticker tal como a Hyperliquid o usa (HIP-3 com prefixo, ex.: `xyz:NVDA`). */
  ticker: string;
  /** DEX HIP-3, ou `null` para perps nativos. */
  dex: string | null;
  estado: EstadoAtivo;
  criadoEm: Date;
}

function paraAtivo(linha: Asset): Ativo {
  return {
    id: linha.id,
    ticker: linha.ticker,
    dex: linha.dex,
    estado: linha.status,
    criadoEm: linha.createdAt,
  };
}

/** Normaliza o ticker (sem espaços; maiúsculas/minúsculas preservadas, a Hyperliquid distingue-as). */
function normalizarTicker(ticker: string) {
  try {
    return separarTicker(ticker);
  } catch (erro) {
    throw new ErroTickerInvalido(ticker, { cause: erro });
  }
}

/** Cria um ativo em estado `idle`; o `dex` é derivado do prefixo do ticker. */
export async function criarAtivo(db: Executor, ticker: string): Promise<Ativo> {
  const { dex, coin } = normalizarTicker(ticker);
  const [linha] = await comTraducao(
    () => db.insert(assets).values({ ticker: coin, dex }).returning(),
    { ticker: coin },
  );
  return paraAtivo(linha!);
}

export async function listarAtivos(db: Executor): Promise<Ativo[]> {
  const linhas = await db.select().from(assets).orderBy(asc(assets.id));
  return linhas.map(paraAtivo);
}

export async function obterAtivoPorId(db: Executor, id: number): Promise<Ativo | null> {
  const [linha] = await db.select().from(assets).where(eq(assets.id, id));
  return linha ? paraAtivo(linha) : null;
}

export async function obterAtivoPorTicker(db: Executor, ticker: string): Promise<Ativo | null> {
  const { coin } = normalizarTicker(ticker);
  const [linha] = await db.select().from(assets).where(eq(assets.ticker, coin));
  return linha ? paraAtivo(linha) : null;
}

export async function alterarEstadoAtivo(
  db: Executor,
  id: number,
  estado: EstadoAtivo,
): Promise<Ativo> {
  const [linha] = await db
    .update(assets)
    .set({ status: estado })
    .where(eq(assets.id, id))
    .returning();
  if (!linha) throw new ErroNaoEncontrado('Ativo', id);
  return paraAtivo(linha);
}

/** Apaga o ativo (cascata: associações, runs, snapshots, eventos e relatórios). */
export async function apagarAtivo(db: Executor, id: number): Promise<boolean> {
  const linhas = await db.delete(assets).where(eq(assets.id, id)).returning({ id: assets.id });
  return linhas.length > 0;
}

/** Ativos que estavam em análise (`running`/`restarting`), para retomar após reinício do servidor. */
export async function listarAtivosParaRetomar(db: Executor): Promise<Ativo[]> {
  const linhas = await db
    .select()
    .from(assets)
    .where(inArray(assets.status, ['running', 'restarting']))
    .orderBy(asc(assets.id));
  return linhas.map(paraAtivo);
}
