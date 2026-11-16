import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Os scripts correm a partir de `apps/api`; o `.env` vive na raiz do monorepo.
const ficheiroEnv = resolve(process.cwd(), '../../.env');
if (!process.env.DATABASE_URL && existsSync(ficheiroEnv)) {
  process.loadEnvFile(ficheiroEnv);
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema',
  out: './drizzle',
  // Só é necessário para `studio`; `generate` não liga à base de dados.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
