import { describe, expect, it, vi } from 'vitest';
import { ativoResumo, INSTANTE } from '../test/dados';
import { avaliarDesatualizacao, distanciaLiquidacaoPct } from './desatualizado';
import {
  alterarPreferencias,
  CHAVE_PREFERENCIAS,
  obterPreferencias,
  PREFERENCIAS_OMISSAO,
  reiniciarPreferencias,
  subscreverPreferencias,
} from './preferencias';
import { reiniciarSom, tocarAlerta } from './som';

const agora = Date.parse(INSTANTE);
const saude = (extra = {}) => ({
  runId: 1,
  cicloEmCurso: false,
  ultimoCicloSucesso: new Date(agora - 30_000).toISOString(),
  ultimoErro: null,
  carteirasDesatualizadas: [],
  ...extra,
});

describe('dados desatualizados', () => {
  it('ativos parados nunca estão desatualizados', () => {
    expect(avaliarDesatualizacao(ativoResumo({ estado: 'stopped' }), agora).desatualizado).toBe(
      false,
    );
  });

  it('em análise e saudável', () => {
    expect(
      avaliarDesatualizacao(ativoResumo({ estado: 'running', saude: saude() }), agora),
    ).toEqual({ desatualizado: false, motivo: null });
    // Ainda à espera do primeiro ciclo.
    expect(
      avaliarDesatualizacao(
        ativoResumo({ estado: 'restarting', saude: saude({ ultimoCicloSucesso: null }) }),
        agora,
      ).desatualizado,
    ).toBe(false);
  });

  it('sem saúde no servidor', () => {
    expect(avaliarDesatualizacao(ativoResumo({ estado: 'running' }), agora).motivo).toMatch(
      /não está a correr/,
    );
  });

  it('carteiras com leitura falhada', () => {
    const um = ativoResumo({ estado: 'running', saude: saude({ carteirasDesatualizadas: [1] }) });
    expect(avaliarDesatualizacao(um, agora).motivo).toBe('1 carteira com leitura falhada.');
    const dois = ativoResumo({
      estado: 'running',
      saude: saude({ carteirasDesatualizadas: [1, 2] }),
    });
    expect(avaliarDesatualizacao(dois, agora).motivo).toBe('2 carteiras com leitura falhada.');
  });

  it('último ciclo falhou depois do último sucesso', () => {
    const a = ativoResumo({
      estado: 'running',
      saude: saude({ ultimoErro: { mensagem: 'Hyperliquid indisponível', instante: INSTANTE } }),
    });
    expect(avaliarDesatualizacao(a, agora).motivo).toBe(
      'Último ciclo falhou: Hyperliquid indisponível',
    );
  });

  it('último ciclo antigo face ao intervalo', () => {
    const a = ativoResumo({
      estado: 'running',
      saude: saude({ ultimoCicloSucesso: new Date(agora - 200_000).toISOString() }),
    });
    expect(avaliarDesatualizacao(a, agora, 60).desatualizado).toBe(true);
    expect(avaliarDesatualizacao(a, agora, 120).desatualizado).toBe(false);
  });

  it('distância à liquidação', () => {
    expect(distanciaLiquidacaoPct(100, 80)).toBe(20);
    expect(distanciaLiquidacaoPct(100, 125)).toBe(25);
    expect(distanciaLiquidacaoPct(null, 80)).toBeNull();
    expect(distanciaLiquidacaoPct(100, null)).toBeNull();
  });
});

describe('preferências (localStorage)', () => {
  it('omissões e persistência', () => {
    expect(obterPreferencias()).toEqual(PREFERENCIAS_OMISSAO);
    const ouvinte = vi.fn();
    const cancelar = subscreverPreferencias(ouvinte);
    alterarPreferencias({ som: false });
    expect(ouvinte).toHaveBeenCalledTimes(1);
    cancelar();
    expect(JSON.parse(localStorage.getItem(CHAVE_PREFERENCIAS)!)).toEqual({
      notificacoes: true,
      som: false,
    });
    reiniciarPreferencias();
    expect(obterPreferencias().som).toBe(false);
  });

  it('JSON corrompido ou valores inválidos usam as omissões', () => {
    localStorage.setItem(CHAVE_PREFERENCIAS, '{lixo');
    expect(obterPreferencias()).toEqual(PREFERENCIAS_OMISSAO);
    reiniciarPreferencias();
    localStorage.setItem(CHAVE_PREFERENCIAS, JSON.stringify({ notificacoes: 'sim', som: false }));
    expect(obterPreferencias()).toEqual({ notificacoes: true, som: false });
  });

  it('armazenamento bloqueado não rebenta', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    expect(obterPreferencias()).toEqual(PREFERENCIAS_OMISSAO);
    expect(() => alterarPreferencias({ notificacoes: false })).not.toThrow();
    expect(obterPreferencias().notificacoes).toBe(false);
  });
});

describe('som (Web Audio)', () => {
  it('sem Web Audio devolve false', () => {
    reiniciarSom();
    vi.stubGlobal('AudioContext', undefined);
    expect(tocarAlerta()).toBe(false);
  });

  it('toca um bip com oscilador', () => {
    reiniciarSom();
    const osc = {
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const ganho = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
    const resume = vi.fn(async () => undefined);
    class ContextoFalso {
      state = 'suspended';
      currentTime = 0;
      destination = {};
      resume = resume;
      createOscillator = () => osc;
      createGain = () => ganho;
    }
    vi.stubGlobal('AudioContext', ContextoFalso);
    expect(tocarAlerta()).toBe(true);
    expect(osc.start).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
  });

  it('erros do áudio são engolidos', () => {
    reiniciarSom();
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('não permitido');
        }
      },
    );
    expect(tocarAlerta()).toBe(false);
  });
});
