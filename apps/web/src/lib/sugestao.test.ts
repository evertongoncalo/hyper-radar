import { describe, expect, it } from 'vitest';
import { sugestaoCarteira, sugestaoProporcional } from '../test/dados';
import {
  agruparAvisos,
  formatarPctComSinal,
  formatarRR,
  origemLimiteAlavancagem,
  textoParaCopiar,
} from './sugestao';

const n = (s: string | null) => (s ?? '').replace(/\s/g, ' ');

describe('sugestão (utilitários)', () => {
  it('agrupa avisos por nível, do mais grave ao menos grave', () => {
    const g = agruparAvisos([
      { codigo: 'MARGEM_CRUZADA_BALEIA', nivel: 'info', mensagem: 'i' },
      { codigo: 'SEM_STOP_LOSS', nivel: 'critico', mensagem: 'c' },
    ]);
    expect(g.map((x) => x.nivel)).toEqual(['critico', 'info']);
    expect(agruparAvisos([])).toEqual([]);
  });

  it('formata R:R e percentagens com sinal', () => {
    expect(n(formatarRR(2.5))).toBe('1 : 2,5');
    expect(formatarRR(null)).toBe('—');
    expect(n(formatarPctComSinal(5.2))).toBe('+5,2 %');
    expect(n(formatarPctComSinal(-3))).toBe('−3 %');
    expect(n(formatarPctComSinal(0))).toBe('0 %');
    expect(formatarPctComSinal(null)).toBe('—');
    expect(formatarPctComSinal(undefined)).toBe('—');
  });

  it('identifica quem limitou a alavancagem', () => {
    expect(origemLimiteAlavancagem(5, 5)).toBe('utilizador');
    expect(origemLimiteAlavancagem(3, 5)).toBe('ativo');
  });

  it('texto para copiar: com e sem SL/TP, inviável e sem posição', () => {
    const viavel = n(textoParaCopiar(sugestaoCarteira(), 'BTC'));
    expect(viavel).toContain('HyperRadar · BTC · Baleia A');
    expect(viavel).not.toContain('Inviável');
    const base = sugestaoProporcional();
    const semSl = n(
      textoParaCopiar(
        sugestaoCarteira({
          sugestao: sugestaoProporcional({
            viavel: false,
            motivo: null,
            lado: 'short',
            posicao: { ...base.posicao!, stopLoss: null, takeProfit: null },
          }),
        }),
        'BTC',
      ),
    );
    expect(semSl).toContain('Lado: Short');
    expect(semSl).toContain('SL: sem SL');
    expect(semSl).toContain('TP: sem TP');
    expect(semSl).toContain('Inviável: sem motivo indicado');
    expect(
      textoParaCopiar(
        sugestaoCarteira({ sugestao: sugestaoProporcional({ posicao: null }) }),
        'BTC',
      ),
    ).toBeNull();
  });
});
