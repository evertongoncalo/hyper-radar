import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarDb } from './client';
import { aplicarMigracoes } from './migrate';
import { settings } from './schema';
import { resolverUrlTeste } from './url-teste';

/**
 * Teste de integração das migrações contra Postgres real.
 * Corre num schema isolado e descartável dentro de uma base `*_test`; nunca na base de desenvolvimento.
 * Sem Postgres acessível, o teste é ignorado (skip), exceto em CI, onde falha.
 */
const urlTeste = resolverUrlTeste();

/** Verifica se o Postgres responde; cria a base de testes se ainda não existir. */
async function prepararBaseTeste(url: string): Promise<boolean> {
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
  } catch {
    return false;
  } finally {
    await admin.end({ timeout: 1 });
  }
}

const disponivel = await prepararBaseTeste(urlTeste);
if (!disponivel) {
  console.warn(`[db] Postgres de testes inacessível; testes de integração ignorados.`);
}

/** Devolve o código SQLSTATE do erro lançado pela promessa (o Drizzle embrulha-o em `cause`). */
async function codigoErro(promessa: Promise<unknown>): Promise<string | undefined> {
  try {
    await promessa;
  } catch (erro) {
    const e = erro as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe.skipIf(!disponivel)('migrações (Postgres real)', () => {
  const schema = `teste_${randomBytes(6).toString('hex')}`;
  const { db, fechar } = criarDb(urlTeste, { max: 1, connection: { search_path: schema } });

  beforeAll(async () => {
    await db.execute(sql.raw(`create schema "${schema}"`));
    await aplicarMigracoes(db, { migrationsSchema: schema });
  });

  afterAll(async () => {
    await db.execute(sql.raw(`drop schema if exists "${schema}" cascade`));
    await fechar();
  });

  it('cria a tabela settings no schema isolado', async () => {
    const linhas = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = ${schema} and table_name = 'settings'`,
    );
    expect(linhas).toHaveLength(1);
  });

  it('é idempotente', async () => {
    await expect(aplicarMigracoes(db, { migrationsSchema: schema })).resolves.toBeUndefined();
  });

  it('insere a linha única com as omissões', async () => {
    const [linha] = await db.insert(settings).values({}).returning();
    expect(linha).toMatchObject({
      id: 1,
      capitalUsd: '0.00',
      maxLeverage: 5,
      riskPerTradePct: '1.00',
      pollIntervalSeconds: 60,
      aiDailyCallLimit: 10,
      aiDailyTokenLimit: 200000,
    });
    expect(linha?.createdAt).toBeInstanceOf(Date);
  });

  it('impede uma segunda linha de definições', async () => {
    expect(await codigoErro(db.insert(settings).values({ id: 1 }))).toBe('23505');
    expect(await codigoErro(db.insert(settings).values({ id: 2 }))).toBe('23514');
  });

  it.each([
    ['intervalo < 15 s', { pollIntervalSeconds: 14 }],
    ['capital negativo', { capitalUsd: '-1' }],
    ['alavancagem 0', { maxLeverage: 0 }],
    ['alavancagem > 100', { maxLeverage: 101 }],
    ['risco 0 %', { riskPerTradePct: '0' }],
    ['risco > 100 %', { riskPerTradePct: '100.01' }],
    ['limite de chamadas IA negativo', { aiDailyCallLimit: -1 }],
    ['limite de tokens IA negativo', { aiDailyTokenLimit: -1 }],
  ] as const)('rejeita %s', async (_descricao, valores) => {
    const codigo = await codigoErro(db.update(settings).set(valores).where(eq(settings.id, 1)));
    expect(codigo).toBe('23514');
  });

  it('aceita valores válidos no limite', async () => {
    const [linha] = await db
      .update(settings)
      .set({ pollIntervalSeconds: 15, maxLeverage: 100, riskPerTradePct: '100' })
      .where(eq(settings.id, 1))
      .returning();
    expect(linha?.pollIntervalSeconds).toBe(15);
  });
});

describe.runIf(!disponivel && Boolean(process.env.CI))('migrações em CI', () => {
  it('exige Postgres acessível em CI', () => {
    throw new Error(`Postgres de testes inacessível em ${new URL(urlTeste).host}.`);
  });
});
