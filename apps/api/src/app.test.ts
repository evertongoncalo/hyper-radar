import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { carregarConfig } from './config';

describe('GET /health', () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it('devolve status ok', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health' });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toEqual({ status: 'ok' });
  });

  it('sem serviço de análise injetado, a decoração é null', () => {
    expect(app.analise).toBeNull();
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
