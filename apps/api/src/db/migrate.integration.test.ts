import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settings } from './schema';
import { codigoErro, criarSchemaIsolado, prepararBaseTeste } from './teste-pg';
import { resolverUrlTeste } from './url-teste';

/**
 * Teste de integração das migrações contra Postgres real.
 * Corre num schema isolado e descartável dentro de uma base `*_test`; nunca na base de desenvolvimento.
 * Sem Postgres acessível, o teste é ignorado (skip), exceto em CI, onde falha.
 */
const urlTeste = resolverUrlTeste();

const disponivel = await prepararBaseTeste(urlTeste);
if (!disponivel) {
  console.warn(`[db] Postgres de testes inacessível; testes de integração ignorados.`);
}

describe.skipIf(!disponivel)('migrações (Postgres real)', () => {
  const isolado = criarSchemaIsolado(urlTeste);
  const { db, schema } = isolado;

  beforeAll(() => isolado.preparar());
  afterAll(() => isolado.limpar());

  it('cria a tabela settings no schema isolado', async () => {
    const linhas = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables
          where table_schema = ${schema} and table_name = 'settings'`,
    );
    expect(linhas).toHaveLength(1);
  });

  it('é idempotente', async () => {
    await expect(isolado.migrar()).resolves.toBeUndefined();
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
