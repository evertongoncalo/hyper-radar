import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inArray } from 'drizzle-orm';
import { carregarConfig } from '../config';
import { criarDb, type Db } from './client';
import { assets, assetWallets, settings, wallets } from './schema';

/**
 * Seed de desenvolvimento, APENAS com dados fictícios (endereços inventados óbvios).
 * Idempotente: pode correr várias vezes sem duplicar nem alterar linhas existentes.
 */
export const ATIVOS_FICTICIOS = [
  { ticker: 'BTC', dex: null },
  { ticker: 'xyz:NVDA', dex: 'xyz' },
] as const;

export const CARTEIRAS_FICTICIAS = [
  { address: `0x${'0'.repeat(39)}1`, alias: 'Baleia fictícia A', entity: 'Entidade fictícia' },
  { address: `0x${'0'.repeat(39)}2`, alias: 'Baleia fictícia B', entity: 'Entidade fictícia' },
  { address: `0x${'0'.repeat(39)}3`, alias: 'Baleia fictícia C', entity: null },
] as const;

export async function semear(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(settings).values({}).onConflictDoNothing();
    await tx
      .insert(assets)
      .values([...ATIVOS_FICTICIOS])
      .onConflictDoNothing();
    await tx
      .insert(wallets)
      .values([...CARTEIRAS_FICTICIAS])
      .onConflictDoNothing();

    // Associa todas as carteiras fictícias a todos os ativos fictícios.
    const ativos = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(
        inArray(
          assets.ticker,
          ATIVOS_FICTICIOS.map((a) => a.ticker),
        ),
      );
    const carteiras = await tx
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        inArray(
          wallets.address,
          CARTEIRAS_FICTICIAS.map((c) => c.address),
        ),
      );
    const associacoes = ativos.flatMap((a) =>
      carteiras.map((c) => ({ assetId: a.id, walletId: c.id })),
    );
    if (associacoes.length > 0) {
      await tx.insert(assetWallets).values(associacoes).onConflictDoNothing();
    }
  });
}

// Execução direta (`npm run db:seed`): usa o DATABASE_URL do ambiente / `.env` da raiz.
const executadoDiretamente =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (executadoDiretamente) {
  const { DATABASE_URL } = carregarConfig();
  const { db, fechar } = criarDb(DATABASE_URL, { max: 1 });
  try {
    await semear(db);
    console.log('Seed de desenvolvimento aplicado (dados fictícios).');
  } catch (erro) {
    console.error('Falha ao aplicar o seed:', erro);
    process.exitCode = 1;
  } finally {
    await fechar();
  }
}
