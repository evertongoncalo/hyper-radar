import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export interface OpcoesDb {
  /** Número máximo de ligações no pool (omissão: 10). */
  max?: number;
  /** Parâmetros de sessão Postgres (ex.: `search_path` nos testes de integração). */
  connection?: Record<string, string>;
}

/**
 * Cria uma instância Drizzle ligada ao Postgres indicado. Não há ligação global:
 * quem cria é responsável por chamar `fechar()` no encerramento.
 */
export function criarDb(databaseUrl: string, opcoes: OpcoesDb = {}) {
  const cliente = postgres(databaseUrl, {
    max: opcoes.max ?? 10,
    // Silencia os avisos NOTICE do Postgres (ex.: "schema já existe").
    onnotice: () => {},
    ...(opcoes.connection ? { connection: opcoes.connection } : {}),
  });
  const db = drizzle(cliente, { schema });

  return {
    db,
    /** Fecha o pool de ligações, esperando no máximo 5 s pelas consultas em curso. */
    fechar: () => cliente.end({ timeout: 5 }),
  };
}

export type Db = ReturnType<typeof criarDb>['db'];
