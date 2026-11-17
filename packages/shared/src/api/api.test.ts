import { describe, expect, it } from 'vitest';
import {
  adicionarCarteiraPedidoSchema,
  alterarDefinicoesPedidoSchema,
  booleanoQuerySchema,
  criarAtivoPedidoSchema,
  idSchema,
  importacaoPedidoSchema,
  listarEventosQuerySchema,
  respostaErroSchema,
  sseEstadoAtivoSchema,
} from './index';

const E1 = `0x${'a'.repeat(40)}`;
const E2 = `0x${'b'.repeat(40)}`;

describe('contratos da API', () => {
  it('ids: aceitam strings numéricas (params) e rejeitam o resto', () => {
    expect(idSchema.parse('12')).toBe(12);
    for (const v of ['0', '-1', '1.5', 'abc', '2147483648']) {
      expect(idSchema.safeParse(v).success).toBe(false);
    }
  });

  it('booleano de query', () => {
    expect(['true', '1', 'false', '0'].map((v) => booleanoQuerySchema.parse(v))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(booleanoQuerySchema.safeParse('sim').success).toBe(false);
  });

  it('ticker: corta espaços, aceita nativo e HIP-3, rejeita formatos inválidos', () => {
    expect(criarAtivoPedidoSchema.parse({ ticker: ' xyz:NVDA ' })).toEqual({ ticker: 'xyz:NVDA' });
    for (const ticker of ['', 'a b', 'a:b:c', ':NVDA', 'xyz:', 'x'.repeat(65)]) {
      expect(criarAtivoPedidoSchema.safeParse({ ticker }).success).toBe(false);
    }
    expect(criarAtivoPedidoSchema.safeParse({ ticker: 'BTC', extra: 1 }).success).toBe(false);
  });

  it('carteira: endereço normalizado; alias vazio → null', () => {
    expect(
      adicionarCarteiraPedidoSchema.parse({
        endereco: E1.toUpperCase().replace('0X', '0x'),
        alias: ' ',
      }),
    ).toEqual({ endereco: E1, alias: null });
  });

  it('eventos: tipos por vírgulas e repetidos; intervalo de datas coerente', () => {
    expect(
      listarEventosQuerySchema.parse({ tipos: ['OPENED, CLOSED', 'FLIPPED', ''], limite: '10' }),
    ).toEqual({ tipos: ['OPENED', 'CLOSED', 'FLIPPED'], limite: 10 });
    expect(listarEventosQuerySchema.safeParse({ tipos: 'FOO' }).success).toBe(false);
    const desde = '2026-01-10T12:00:00.000Z';
    const ate = '2026-01-10T11:00:00.000Z';
    expect(listarEventosQuerySchema.safeParse({ desde, ate }).success).toBe(false);
    expect(listarEventosQuerySchema.safeParse({ desde: ate, ate: desde }).success).toBe(true);
  });

  it('definições: limites iguais aos da BD', () => {
    expect(alterarDefinicoesPedidoSchema.parse({ intervaloRecolhaSegundos: 15 })).toEqual({
      intervaloRecolhaSegundos: 15,
    });
    for (const c of [{ intervaloRecolhaSegundos: 14 }, { riscoPorOperacaoPct: 0 }, { x: 1 }]) {
      expect(alterarDefinicoesPedidoSchema.safeParse(c).success).toBe(false);
    }
  });

  it('importação: associações só a carteiras listadas e tickers únicos', () => {
    const base = {
      versao: 1,
      exportadoEm: '2026-01-10T12:00:00.000Z',
      carteiras: [{ endereco: E1, alias: null, entidade: null }],
      ativos: [{ ticker: 'BTC', carteiras: [E1] }],
    };
    expect(importacaoPedidoSchema.safeParse(base).success).toBe(true);
    const r = importacaoPedidoSchema.safeParse({
      ...base,
      ativos: [
        { ticker: 'BTC', carteiras: [E2] },
        { ticker: 'BTC', carteiras: [] },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual([
      'ativos.0.carteiras.0',
      'ativos.1.ticker',
    ]);
  });

  it('erro uniforme e eventos SSE', () => {
    expect(
      respostaErroSchema.safeParse({ erro: { codigo: 'NAO_ENCONTRADO', mensagem: 'x' } }).success,
    ).toBe(true);
    expect(respostaErroSchema.safeParse({ erro: { codigo: 'OUTRO', mensagem: 'x' } }).success).toBe(
      false,
    );
    expect(
      sseEstadoAtivoSchema.safeParse({
        assetId: 1,
        ticker: 'BTC',
        anterior: 'idle',
        estado: 'running',
        runId: 1,
        instante: 'ontem',
      }).success,
    ).toBe(false);
  });
});
