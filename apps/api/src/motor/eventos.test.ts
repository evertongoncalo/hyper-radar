import { describe, expect, it } from 'vitest';
import { eventType } from '../db/schema/comum';
import { CARTEIRA_A } from './__testes__/construtores';
import { criarConfig } from './config';
import { calcularChaveDedupe, criarEvento, inicioBucket, TIPOS_EVENTO } from './eventos';

describe('eventos', () => {
  it('os tipos coincidem com o enum event_type da BD', () => {
    expect([...TIPOS_EVENTO]).toEqual(eventType.enumValues);
  });

  it.each([
    [0, 300_000, 0],
    [299_999, 300_000, 0],
    [300_000, 300_000, 300_000],
    [1_700_000_123_456, 60_000, 1_700_000_100_000],
  ])('inicioBucket(%d, %d) = %d', (instante, bucket, esperado) => {
    expect(inicioBucket(instante, bucket)).toBe(esperado);
  });

  it('chave de dedupe determinística, com endereço em minúsculas e separador |', () => {
    const k = calcularChaveDedupe(CARTEIRA_A.toUpperCase(), 'xyz:NVDA', 'OPENED', 610_000, 300_000);
    expect(k).toBe(`${CARTEIRA_A}|xyz:NVDA|OPENED|600000`);
    expect(calcularChaveDedupe(CARTEIRA_A, 'xyz:NVDA', 'OPENED', 899_999, 300_000)).toBe(k);
    expect(calcularChaveDedupe(CARTEIRA_A, 'xyz:NVDA', 'OPENED', 900_000, 300_000)).not.toBe(k);
    expect(calcularChaveDedupe(CARTEIRA_A, 'xyz:NVDA', 'CLOSED', 610_000, 300_000)).not.toBe(k);
  });

  it('criarEvento usa o início da janela (ou o instante) para a chave', () => {
    const config = criarConfig({ bucketDedupeMs: 1_000 });
    const payload = {
      posicaoAnterior: {
        lado: 'long' as const,
        tamanho: 1,
        entryPx: 1,
        leverage: 1,
        tipoMargem: 'cross' as const,
        liquidationPx: null,
        margem: 1,
        pnl: 0,
        notional: 1,
      },
      notionalFechado: 1,
      precoMercado: 1,
    };
    const dados = { carteira: CARTEIRA_A, ativo: 'BTC', instante: 5_500 };
    expect(criarEvento('CLOSED', dados, payload, config).chaveDedupe).toBe(
      `${CARTEIRA_A}|BTC|CLOSED|5000`,
    );
    expect(criarEvento('CLOSED', { ...dados, inicioJanela: 2_100 }, payload, config)).toMatchObject(
      { tipo: 'CLOSED', instante: 5_500, chaveDedupe: `${CARTEIRA_A}|BTC|CLOSED|2000` },
    );
  });
});
