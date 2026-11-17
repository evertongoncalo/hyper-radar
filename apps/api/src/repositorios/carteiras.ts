import { enderecoCarteiraSchema } from '@hyper-radar/shared';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { assets, assetWallets, wallets, type Wallet } from '../db/schema';
import type { Executor } from './comum';
import { comTraducao, ErroEnderecoInvalido, ErroNaoEncontrado } from './erros';

export interface Carteira {
  id: number;
  /** Endereço público normalizado em minúsculas. */
  endereco: string;
  alias: string | null;
  entidade: string | null;
  criadoEm: Date;
}

export interface CarteiraComAtivos extends Carteira {
  ativos: { id: number; ticker: string }[];
}

export interface DadosCarteira {
  endereco: string;
  alias?: string | null;
  entidade?: string | null;
}

function paraCarteira(linha: Wallet): Carteira {
  return {
    id: linha.id,
    endereco: linha.address,
    alias: linha.alias,
    entidade: linha.entity,
    criadoEm: linha.createdAt,
  };
}

/** Valida com o schema partilhado e normaliza para minúsculas. */
export function normalizarEndereco(endereco: string): string {
  const r = enderecoCarteiraSchema.safeParse(endereco);
  if (!r.success) throw new ErroEnderecoInvalido(endereco);
  return r.data;
}

/**
 * Cria a carteira ou devolve a existente com o mesmo endereço (upsert).
 * Se a carteira já existir, `alias`/`entidade` indicados substituem os atuais; omitidos mantêm-se.
 */
export async function criarOuObterCarteira(db: Executor, dados: DadosCarteira): Promise<Carteira> {
  const address = normalizarEndereco(dados.endereco);
  const [linha] = await comTraducao(() =>
    db
      .insert(wallets)
      .values({ address, alias: dados.alias ?? null, entity: dados.entidade ?? null })
      .onConflictDoUpdate({
        target: wallets.address,
        set: {
          alias: dados.alias !== undefined ? sql`excluded.alias` : sql`${wallets.alias}`,
          entity: dados.entidade !== undefined ? sql`excluded.entity` : sql`${wallets.entity}`,
        },
      })
      .returning(),
  );
  return paraCarteira(linha!);
}

export async function obterCarteiraPorId(db: Executor, id: number): Promise<Carteira | null> {
  const [linha] = await db.select().from(wallets).where(eq(wallets.id, id));
  return linha ? paraCarteira(linha) : null;
}

export async function obterCarteiraPorEndereco(
  db: Executor,
  endereco: string,
): Promise<Carteira | null> {
  const address = normalizarEndereco(endereco);
  const [linha] = await db.select().from(wallets).where(eq(wallets.address, address));
  return linha ? paraCarteira(linha) : null;
}

/** Altera alias e/ou entidade; `null` limpa o valor, `undefined` mantém-no. */
export async function alterarCarteira(
  db: Executor,
  id: number,
  dados: { alias?: string | null; entidade?: string | null },
): Promise<Carteira> {
  const valores: { alias?: string | null; entity?: string | null } = {};
  if (dados.alias !== undefined) valores.alias = dados.alias;
  if (dados.entidade !== undefined) valores.entity = dados.entidade;
  if (Object.keys(valores).length === 0) {
    const atual = await obterCarteiraPorId(db, id);
    if (!atual) throw new ErroNaoEncontrado('Carteira', id);
    return atual;
  }
  const [linha] = await db.update(wallets).set(valores).where(eq(wallets.id, id)).returning();
  if (!linha) throw new ErroNaoEncontrado('Carteira', id);
  return paraCarteira(linha);
}

/** Associa a carteira ao ativo; devolve `false` se já estava associada. */
export async function associarCarteira(
  db: Executor,
  assetId: number,
  walletId: number,
): Promise<boolean> {
  const linhas = await comTraducao(() =>
    db
      .insert(assetWallets)
      .values({ assetId, walletId })
      .onConflictDoNothing()
      .returning({ assetId: assetWallets.assetId }),
  );
  return linhas.length > 0;
}

/** Remove a associação; devolve `false` se não existia. */
export async function desassociarCarteira(
  db: Executor,
  assetId: number,
  walletId: number,
): Promise<boolean> {
  const linhas = await db
    .delete(assetWallets)
    .where(and(eq(assetWallets.assetId, assetId), eq(assetWallets.walletId, walletId)))
    .returning({ assetId: assetWallets.assetId });
  return linhas.length > 0;
}

/** Carteiras associadas a um ativo, pela ordem de associação. */
export async function listarCarteirasDoAtivo(db: Executor, assetId: number): Promise<Carteira[]> {
  const linhas = await db
    .select({ carteira: wallets })
    .from(assetWallets)
    .innerJoin(wallets, eq(assetWallets.walletId, wallets.id))
    .where(eq(assetWallets.assetId, assetId))
    .orderBy(asc(assetWallets.createdAt), asc(wallets.id));
  return linhas.map((l) => paraCarteira(l.carteira));
}

/** Todas as carteiras com os ativos a que pertencem (uma só consulta). */
export async function listarCarteirasComAtivos(db: Executor): Promise<CarteiraComAtivos[]> {
  const linhas = await db
    .select({ carteira: wallets, ativoId: assets.id, ticker: assets.ticker })
    .from(wallets)
    .leftJoin(assetWallets, eq(assetWallets.walletId, wallets.id))
    .leftJoin(assets, eq(assetWallets.assetId, assets.id))
    .orderBy(asc(wallets.id), asc(assets.id));

  const porId = new Map<number, CarteiraComAtivos>();
  for (const l of linhas) {
    let c = porId.get(l.carteira.id);
    if (!c) {
      c = { ...paraCarteira(l.carteira), ativos: [] };
      porId.set(c.id, c);
    }
    if (l.ativoId !== null && l.ticker !== null) c.ativos.push({ id: l.ativoId, ticker: l.ticker });
  }
  return [...porId.values()];
}

/** Número de carteiras associadas a cada ativo (ativos sem carteiras não aparecem). */
export async function contarCarteirasPorAtivo(db: Executor): Promise<Map<number, number>> {
  const linhas = await db
    .select({ assetId: assetWallets.assetId, n: count() })
    .from(assetWallets)
    .groupBy(assetWallets.assetId);
  return new Map(linhas.map((l) => [l.assetId, l.n]));
}

/** Ids dos ativos a que a carteira está associada. */
export async function listarIdsAtivosDaCarteira(db: Executor, walletId: number): Promise<number[]> {
  const linhas = await db
    .select({ assetId: assetWallets.assetId })
    .from(assetWallets)
    .where(eq(assetWallets.walletId, walletId))
    .orderBy(asc(assetWallets.assetId));
  return linhas.map((l) => l.assetId);
}

/** Apaga a carteira (cascata: associações, snapshots e eventos). */
export async function apagarCarteira(db: Executor, id: number): Promise<boolean> {
  const linhas = await db.delete(wallets).where(eq(wallets.id, id)).returning({ id: wallets.id });
  return linhas.length > 0;
}
