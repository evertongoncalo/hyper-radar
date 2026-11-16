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
});

describe('carregarConfig', () => {
  it('usa a porta 3000 por omissão', () => {
    expect(carregarConfig({}).PORT).toBe(3000);
  });

  it('lê a porta definida em PORT', () => {
    expect(carregarConfig({ PORT: '4123' }).PORT).toBe(4123);
  });

  it('rejeita uma porta inválida', () => {
    expect(() => carregarConfig({ PORT: 'abc' })).toThrow(/Configuração inválida/);
  });
});
