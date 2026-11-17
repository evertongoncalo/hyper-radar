import { respostaSaudeServidorSchema } from '@hyper-radar/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { carregarConfig } from './config';
import type { Db } from './db/client';
import { criarApp } from './rotas/__testes__/auxiliares';

describe('GET /health', () => {
  // BD falsa: só `execute` é usado pelo /health.
  let bdOk = true;
  const db = {
    execute: async () => {
      if (!bdOk) throw new Error('ligação recusada');
      return [];
    },
  } as unknown as Db;
  const { app, analise } = criarApp(db);

  afterAll(async () => {
    await app.close();
  });

  it('devolve ok com o estado da BD e o nº de ativos em análise', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health' });
    expect(resposta.statusCode).toBe(200);
    expect(respostaSaudeServidorSchema.parse(resposta.json())).toEqual({
      status: 'ok',
      bd: 'ok',
      ativosEmAnalise: 0,
    });
  });

  it('BD em baixo → 503 degradado', async () => {
    bdOk = false;
    const resposta = await app.inject({ method: 'GET', url: '/health' });
    bdOk = true;
    expect(resposta.statusCode).toBe(503);
    expect(resposta.json()).toEqual({
      status: 'degradado',
      bd: 'indisponivel',
      ativosEmAnalise: 0,
    });
  });

  it('expõe o serviço de análise como decoração', () => {
    expect(app.analise).toBe(analise);
  });
});

describe('carregarConfig', () => {
  // Valor fictício: a validação da configuração não abre ligações.
  const base = { DATABASE_URL: 'postgres://utilizador:senha@127.0.0.1:5432/base' };

  it('usa a porta 3000 por omissão', () => {
    expect(carregarConfig(base).PORT).toBe(3000);
  });

  it('lê a porta definida em PORT', () => {
    expect(carregarConfig({ ...base, PORT: '4123' }).PORT).toBe(4123);
  });

  it('rejeita uma porta inválida', () => {
    expect(() => carregarConfig({ ...base, PORT: 'abc' })).toThrow(/Configuração inválida/);
  });

  it('aceita DATABASE_URL com postgres:// e postgresql://', () => {
    expect(carregarConfig(base).DATABASE_URL).toBe(base.DATABASE_URL);
    const url = 'postgresql://u:s@localhost/base';
    expect(carregarConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('retenção de snapshots: omissão 30 dias, configurável e ≥ 1', () => {
    expect(carregarConfig(base).SNAPSHOT_RETENTION_DAYS).toBe(30);
    expect(carregarConfig({ ...base, SNAPSHOT_RETENTION_DAYS: '7' }).SNAPSHOT_RETENTION_DAYS).toBe(
      7,
    );
    expect(() => carregarConfig({ ...base, SNAPSHOT_RETENTION_DAYS: '0' })).toThrow(
      /SNAPSHOT_RETENTION_DAYS/,
    );
  });

  it('ALLOWED_ORIGINS: omissão Vite dev, lista por vírgulas, rejeita origens inválidas', () => {
    expect(carregarConfig(base).ALLOWED_ORIGINS).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]);
    expect(
      carregarConfig({ ...base, ALLOWED_ORIGINS: ' http://localhost:4000 ,' }).ALLOWED_ORIGINS,
    ).toEqual(['http://localhost:4000']);
    expect(() => carregarConfig({ ...base, ALLOWED_ORIGINS: 'ftp://x' })).toThrow(
      /ALLOWED_ORIGINS/,
    );
  });

  it('OpenAI: chave opcional (vazia = null) e modelo por omissão; valores inválidos sem ecoar', () => {
    expect(carregarConfig(base)).toMatchObject({
      OPENAI_API_KEY: null,
      OPENAI_MODEL: 'gpt-6.1-sol',
    });
    expect(carregarConfig({ ...base, OPENAI_API_KEY: '  ', OPENAI_MODEL: '' })).toMatchObject({
      OPENAI_API_KEY: null,
      OPENAI_MODEL: 'gpt-6.1-sol',
    });
    expect(
      carregarConfig({ ...base, OPENAI_API_KEY: ' sk-x ', OPENAI_MODEL: 'gpt-6.1-terra' }),
    ).toMatchObject({ OPENAI_API_KEY: 'sk-x', OPENAI_MODEL: 'gpt-6.1-terra' });
    const erro = (() => {
      try {
        carregarConfig({ ...base, OPENAI_API_KEY: 'sk-segredo com espaco' });
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(erro).toMatch(/OPENAI_API_KEY/);
    expect(erro).not.toContain('sk-segredo');
    expect(() => carregarConfig({ ...base, OPENAI_MODEL: 'mau modelo!' })).toThrow(/OPENAI_MODEL/);
  });

  it('exige DATABASE_URL', () => {
    expect(() => carregarConfig({})).toThrow(/DATABASE_URL/);
  });

  it.each(['mysql://u:s@localhost/base', 'http://localhost:5432', 'não é um url', ''])(
    'rejeita DATABASE_URL inválido: %j',
    (valor) => {
      expect(() => carregarConfig({ DATABASE_URL: valor })).toThrow(/DATABASE_URL/);
    },
  );
});
