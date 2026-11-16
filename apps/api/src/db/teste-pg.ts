import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { criarDb } from './client';
import { aplicarMigracoes, PASTA_MIGRACOES } from './migrate';

/**
 * Utilitários partilhados pelos testes de integração contra Postgres real.
 * Cada ficheiro de teste corre num schema isolado e descartável dentro de uma base `*_test`.
 */

/** Verifica se o Postgres responde; cria a base de testes se ainda não existir. */
export async function prepararBaseTeste(url: string): Promise<boolean> {
  const opcoes = { max: 1, connect_timeout: 3, onnotice: () => {} };
  const sondar = async (u: string) => {
    const cliente = postgres(u, opcoes);
    try {
      await cliente`select 1`;
    } finally {
      await cliente.end({ timeout: 1 });
    }
  };

  try {
    await sondar(url);
    return true;
  } catch (erro) {
    // 3D000 = a base não existe: criá-la a partir da base de manutenção `postgres`.
    if ((erro as { code?: string }).code !== '3D000') return false;
  }

  const alvo = new URL(url);
  const nomeBase = decodeURIComponent(alvo.pathname.slice(1));
  alvo.pathname = '/postgres';
  const admin = postgres(alvo.toString(), opcoes);
  try {
    await admin.unsafe(`create database "${nomeBase.replaceAll('"', '""')}"`);
    return true;
  } catch (erro) {
    // 42P04 = outro ficheiro de teste criou a base em simultâneo.
    return (erro as { code?: string }).code === '42P04';
  } finally {
    await admin.end({ timeout: 1 });
  }
}

/** Devolve o código SQLSTATE do erro lançado pela promessa (o Drizzle embrulha-o em `cause`). */
export async function codigoErro(promessa: Promise<unknown>): Promise<string | undefined> {
  try {
    await promessa;
  } catch (erro) {
    const e = erro as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

/**
 * Copia as migrações para uma pasta temporária sem o qualificador `"public".`
 * que o drizzle-kit gera em tipos e FKs, para que sejam criados no schema do `search_path`.
 * As migrações versionadas ficam intactas.
 */
function migracoesSemSchemaPublico(): { pasta: string; remover: () => void } {
  const pasta = mkdtempSync(join(tmpdir(), 'hyperradar-migracoes-'));
  cpSync(PASTA_MIGRACOES, pasta, { recursive: true });
  for (const ficheiro of readdirSync(pasta).filter((f) => f.endsWith('.sql'))) {
    const caminho = join(pasta, ficheiro);
    writeFileSync(caminho, readFileSync(caminho, 'utf8').replaceAll('"public".', ''));
  }
  return { pasta, remover: () => rmSync(pasta, { recursive: true, force: true }) };
}

/** Cria um schema isolado, aplica as migrações nele e devolve o cliente e a função de limpeza. */
export function criarSchemaIsolado(url: string) {
  const schema = `teste_${randomBytes(6).toString('hex')}`;
  const { db, fechar } = criarDb(url, { max: 1, connection: { search_path: schema } });
  // Criada só em `preparar()`, para não deixar lixo quando os testes são ignorados.
  let migracoes: ReturnType<typeof migracoesSemSchemaPublico> | undefined;
  /** Aplica (ou volta a aplicar) as migrações no schema isolado. */
  const migrar = () => {
    migracoes ??= migracoesSemSchemaPublico();
    return aplicarMigracoes(db, { migrationsFolder: migracoes.pasta, migrationsSchema: schema });
  };

  return {
    db,
    schema,
    migrar,
    async preparar() {
      await db.execute(sql.raw(`create schema "${schema}"`));
      await migrar();
    },
    async limpar() {
      try {
        await db.execute(sql.raw(`drop schema if exists "${schema}" cascade`));
      } finally {
        migracoes?.remover();
        await fechar();
      }
    },
  };
}
