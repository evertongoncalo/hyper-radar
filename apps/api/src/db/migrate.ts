import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { carregarConfig } from '../config';
import { criarDb, type Db } from './client';

/** Pasta das migrações geradas pelo drizzle-kit (`apps/api/drizzle`), relativa a este ficheiro. */
export const PASTA_MIGRACOES = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface OpcoesMigracao {
  /** Pasta com as migrações; por omissão `apps/api/drizzle`. */
  migrationsFolder?: string;
  /** Schema onde o Drizzle regista as migrações aplicadas (omissão: `drizzle`). */
  migrationsSchema?: string;
}

/** Aplica todas as migrações pendentes. É idempotente. */
export async function aplicarMigracoes(db: Db, opcoes: OpcoesMigracao = {}): Promise<void> {
  await migrate(db, {
    migrationsFolder: opcoes.migrationsFolder ?? PASTA_MIGRACOES,
    ...(opcoes.migrationsSchema ? { migrationsSchema: opcoes.migrationsSchema } : {}),
  });
}

// Execução direta (`npm run db:migrate`): usa o DATABASE_URL do ambiente / `.env` da raiz.
const executadoDiretamente =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (executadoDiretamente) {
  const { DATABASE_URL } = carregarConfig();
  const { db, fechar } = criarDb(DATABASE_URL, { max: 1 });
  try {
    await aplicarMigracoes(db);
    console.log('Migrações aplicadas com sucesso.');
  } catch (erro) {
    console.error('Falha ao aplicar as migrações:', erro);
    process.exitCode = 1;
  } finally {
    await fechar();
  }
}
