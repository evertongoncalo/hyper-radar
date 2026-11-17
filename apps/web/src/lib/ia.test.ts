import { describe, expect, it } from 'vitest';
import { ErroApi } from '../api/cliente';
import { estadoIaBase } from '../test/dados';
import {
  descreverErroIa,
  distanciaPct,
  estimarCustoUsd,
  formatarCustoIa,
  formatarUsoLimite,
  limiteAtingido,
  precoDoModelo,
} from './ia';

const n = (s: string) => s.replace(/\s/g, ' ');

describe('lib/ia', () => {
  it('preço do modelo e estimativa de custo', () => {
    const p = precoDoModelo(estadoIaBase());
    expect(p?.entradaUsdPorMilhao).toBe(2);
    expect(precoDoModelo(undefined)).toBeNull();
    expect(precoDoModelo(estadoIaBase({ modeloComPreco: false }))).toBeNull();
    expect(precoDoModelo(estadoIaBase({ modelo: 'x' }))).toBeNull();
    expect(estimarCustoUsd(p)).toBeCloseTo(0.042);
    expect(estimarCustoUsd(p, { entrada: 1e6, saida: 0 })).toBe(2);
    expect(estimarCustoUsd(null)).toBeNull();
  });

  it('formatação de custos e limites', () => {
    expect(formatarCustoIa(null)).toBe('por estimar');
    expect(formatarCustoIa(undefined)).toBe('por estimar');
    expect(formatarCustoIa(Number.NaN)).toBe('por estimar');
    expect(n(formatarCustoIa(0))).toBe('0,00 US$');
    expect(n(formatarCustoIa(0.0035))).toBe('0,0035 US$');
    expect(n(formatarCustoIa(0.042))).toBe('0,042 US$');
    expect(n(formatarCustoIa(12.5))).toBe('12,50 US$');
    expect(n(formatarUsoLimite(3, 10))).toBe('3 / 10');
    expect(n(formatarUsoLimite(3, 0))).toBe('3 (sem limite)');
  });

  it('limite atingido e distância percentual', () => {
    const h = estadoIaBase().hoje;
    expect(limiteAtingido(h)).toBe(false);
    expect(limiteAtingido({ ...h, chamadas: 10 })).toBe(true);
    expect(limiteAtingido({ ...h, tokens: 100_000 })).toBe(true);
    expect(limiteAtingido({ ...h, chamadas: 99, limiteChamadas: 0 })).toBe(false);
    expect(distanciaPct(110, 100)).toBeCloseTo(10);
    expect(distanciaPct(110, null)).toBeNull();
    expect(distanciaPct(110, undefined)).toBeNull();
    expect(distanciaPct(110, 0)).toBeNull();
    expect(distanciaPct(110, Number.NaN)).toBeNull();
  });

  it('descreve os erros', () => {
    expect(descreverErroIa(new Error('x'))).toEqual({
      titulo: 'Não foi possível analisar.',
      mensagem: 'x',
      ligacaoDefinicoes: false,
    });
    expect(descreverErroIa('?').mensagem).toBe('Erro inesperado.');
    expect(descreverErroIa(new ErroApi('REDE', 'Sem ligação.')).titulo).toBe(
      'Não foi possível analisar.',
    );
    expect(descreverErroIa(new ErroApi('LIMITE_IA_ATINGIDO', 'L', 429)).ligacaoDefinicoes).toBe(
      true,
    );
  });
});
