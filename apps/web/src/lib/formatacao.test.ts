import { describe, expect, it } from 'vitest';
import {
  abreviarEndereco,
  casasPreco,
  dataIsoLisboa,
  formatarData,
  formatarDataHora,
  formatarNumero,
  formatarPct,
  formatarPreco,
  formatarRelativo,
  formatarTamanho,
  formatarUsd,
  formatarUsdComSinal,
  lisboaParaIso,
  nomeCarteira,
} from './formatacao';

/** Normaliza os espaços especiais do Intl (NBSP, espaço estreito) para comparar. */
const n = (s: string) => s.replace(/\s/g, ' ');

describe('datas em Europe/Lisbon', () => {
  it('inverno: Lisboa = UTC', () => {
    expect(formatarDataHora('2026-01-10T12:00:00.000Z')).toBe('10/01/2026, 12:00:00');
  });

  it('verão: Lisboa = UTC+1', () => {
    expect(formatarDataHora('2026-07-10T12:00:00.000Z')).toBe('10/07/2026, 13:00:00');
  });

  it('mudança para a hora de verão (29/03/2026, 01:00 UTC)', () => {
    expect(formatarDataHora('2026-03-29T00:59:59.000Z')).toBe('29/03/2026, 00:59:59');
    expect(formatarDataHora('2026-03-29T01:00:00.000Z')).toBe('29/03/2026, 02:00:00');
  });

  it('mudança para a hora de inverno (25/10/2026, 01:00 UTC): 01:xx repete-se', () => {
    expect(formatarDataHora('2026-10-25T00:30:00.000Z')).toBe('25/10/2026, 01:30:00');
    expect(formatarDataHora('2026-10-25T01:30:00.000Z')).toBe('25/10/2026, 01:30:00');
  });

  it('meia-noite em Lisboa muda o dia antes de UTC no verão', () => {
    expect(formatarData('2026-07-10T23:30:00.000Z')).toBe('11/07/2026');
    expect(dataIsoLisboa('2026-07-10T23:30:00.000Z')).toBe('2026-07-11');
  });

  it('datas inválidas', () => {
    expect(formatarDataHora('ontem')).toBe('—');
    expect(formatarData('ontem')).toBe('—');
    expect(formatarRelativo('ontem', 0)).toBe('—');
  });

  it('lisboaParaIso converte hora local de Lisboa para UTC', () => {
    expect(lisboaParaIso('2026-01-10T12:00')).toBe('2026-01-10T12:00:00.000Z');
    expect(lisboaParaIso('2026-07-10T12:00')).toBe('2026-07-10T11:00:00.000Z');
    expect(lisboaParaIso('2026-07-10T12:00:30')).toBe('2026-07-10T11:00:30.000Z');
    // Hora inexistente (salto 01:00 → 02:00) e hora ambígua (01:xx repetida).
    expect(lisboaParaIso('2026-03-29T01:30')).not.toBeNull();
    expect(lisboaParaIso('2026-03-29T02:30')).toBe('2026-03-29T01:30:00.000Z');
    expect(lisboaParaIso('2026-10-25T00:30')).toBe('2026-10-24T23:30:00.000Z');
    expect(lisboaParaIso('2026-10-25T02:30')).toBe('2026-10-25T02:30:00.000Z');
    expect(lisboaParaIso('lixo')).toBeNull();
  });

  it('tempo relativo', () => {
    const agora = Date.parse('2026-01-10T12:00:00.000Z');
    expect(formatarRelativo(agora - 30_000, agora)).toBe('há 30 segundos');
    expect(formatarRelativo(agora - 120_000, agora)).toBe('há 2 minutos');
    expect(formatarRelativo(agora - 3 * 3_600_000, agora)).toBe('há 3 horas');
    expect(formatarRelativo(agora - 2 * 86_400_000, agora)).toBe('anteontem');
  });
});

describe('números em pt-PT', () => {
  it('separadores de milhares e decimais', () => {
    expect(n(formatarNumero(1234567.891))).toBe('1 234 567,89');
    expect(n(formatarNumero(1234))).toBe('1 234');
    expect(formatarNumero(1.5, 2, 2)).toBe('1,50');
    expect(formatarNumero(null)).toBe('—');
    expect(formatarNumero(Number.NaN)).toBe('—');
  });

  it('USD', () => {
    expect(n(formatarUsd(1_234_567.4))).toBe('1 234 567 US$');
    expect(n(formatarUsd(12.5))).toBe('12,50 US$');
    expect(n(formatarUsd(12.5, 0))).toBe('13 US$');
    expect(formatarUsd(undefined)).toBe('—');
    expect(n(formatarUsdComSinal(1500))).toBe('+1 500 US$');
    expect(n(formatarUsdComSinal(-1500))).toBe('−1 500 US$');
    expect(n(formatarUsdComSinal(0))).toBe('0,00 US$');
    expect(formatarUsdComSinal(null)).toBe('—');
  });

  it('preços com casas adequadas', () => {
    expect(casasPreco(97_123.4)).toBe(2);
    expect(casasPreco(3.4567)).toBe(4);
    expect(casasPreco(0.001234)).toBe(7);
    expect(casasPreco(0.00001234)).toBe(8);
    expect(casasPreco(0)).toBe(2);
    expect(n(formatarPreco(97_123.4))).toBe('97 123,40');
    expect(formatarPreco(3.45678)).toBe('3,4568');
    expect(formatarPreco(0.00012345)).toBe('0,00012345');
    expect(formatarPreco(null)).toBe('—');
  });

  it('tamanhos e percentagens', () => {
    expect(formatarTamanho(12.5)).toBe('12,5');
    expect(formatarTamanho(0.0001234)).toBe('0,000123');
    expect(n(formatarTamanho(12345.678))).toBe('12 345,68');
    expect(n(formatarPct(12.345))).toBe('12,35 %');
    expect(formatarPct(null)).toBe('—');
  });
});

describe('endereços', () => {
  it('abrevia endereços longos', () => {
    expect(abreviarEndereco(`0x1234${'0'.repeat(32)}abcd`)).toBe('0x1234…abcd');
    expect(abreviarEndereco('0x12')).toBe('0x12');
  });

  it('nome da carteira: alias ou endereço curto', () => {
    const endereco = `0x1234${'0'.repeat(32)}abcd`;
    expect(nomeCarteira({ alias: 'Baleia', endereco })).toBe('Baleia');
    expect(nomeCarteira({ alias: ' ', endereco })).toBe('0x1234…abcd');
    expect(nomeCarteira({ alias: null, endereco })).toBe('0x1234…abcd');
  });
});
