import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { snapshotDeEstado } from '../motor';
import type { SnapshotCompleto } from '../repositorios';
import { estadoCarteira, RelogioFalso, T0 } from './__testes__/auxiliares';
import { BarramentoAnalise, type ResumoCiclo } from './barramento';
import { deSnapshotGravado, paraNovoSnapshot } from './conversao';
import { ErroAnalise, ErroAtivoSemCarteiras } from './erros';

const resumo: ResumoCiclo = {
  assetId: 1,
  ticker: 'BTC',
  runId: 1,
  instante: new Date(T0),
  duracaoMs: 0,
  carteirasOk: 1,
  carteirasFalhadas: 0,
  eventos: 0,
  falhou: false,
  erro: null,
};

describe('BarramentoAnalise', () => {
  it('entrega aos ouvintes do evento e permite cancelar', () => {
    const b = new BarramentoAnalise();
    const ouvinte = vi.fn();
    const cancelar = b.on('ciclo', ouvinte);
    b.on('estado-ativo', () => {
      throw new Error('não devia ser chamado');
    });
    b.emitir('ciclo', resumo);
    expect(ouvinte).toHaveBeenCalledWith(resumo);
    expect(b.contarOuvintes('ciclo')).toBe(1);
    cancelar();
    b.emitir('ciclo', resumo);
    expect(ouvinte).toHaveBeenCalledTimes(1);
    expect(b.contarOuvintes('ciclo')).toBe(0);
    expect(b.contarOuvintes('evento')).toBe(0);
    b.off('evento', () => {});
  });

  it('um ouvinte que lança não impede os restantes e é registado', () => {
    const logger = pino({ enabled: false });
    const erro = vi.spyOn(logger, 'error');
    const b = new BarramentoAnalise(logger);
    const segundo = vi.fn();
    b.on('ciclo', () => {
      throw new Error('falhou');
    });
    b.on('ciclo', segundo);
    expect(() => b.emitir('ciclo', resumo)).not.toThrow();
    expect(segundo).toHaveBeenCalledOnce();
    expect(erro).toHaveBeenCalledOnce();
    // Sem logger também não rebenta.
    const semLogger = new BarramentoAnalise();
    semLogger.on('ciclo', () => {
      throw new Error('falhou');
    });
    expect(() => semLogger.emitir('ciclo', resumo)).not.toThrow();
  });
});

describe('conversão motor ↔ persistência', () => {
  it('ida e volta preserva o snapshot do motor', () => {
    const estado = estadoCarteira({ tamanho: 12.5, lado: 'short', sl: 110, tp: 80, preco: 99 });
    const motor = snapshotDeEstado(
      {
        ...estado,
        user: '0x' + 'ab'.repeat(20),
        modoConta: 'unifiedAccount',
        accountValueRepresentativo: false,
      },
      T0,
    );
    const novo = paraNovoSnapshot(motor, 7, 3);
    expect(novo).toMatchObject({
      runId: 7,
      walletId: 3,
      marketPx: 99,
      instante: new Date(T0),
      accountValueRepresentativo: false,
      modoConta: 'unifiedAccount',
    });
    expect(novo.posicao).toMatchObject({ lado: 'short', alavancagem: 5, notional: 1237.5 });
    expect(novo.ordens.map((o) => o.tipo)).toEqual(['SL', 'TP']);

    const gravado: SnapshotCompleto = {
      id: 1,
      runId: 7,
      walletId: 3,
      assetId: 1,
      accountValue: novo.accountValue,
      accountValueRepresentativo: novo.accountValueRepresentativo!,
      modoConta: novo.modoConta!,
      marketPx: novo.marketPx,
      instante: novo.instante!,
      posicao: novo.posicao,
      ordens: novo.ordens,
    };
    expect(deSnapshotGravado(gravado, '0x' + 'AB'.repeat(20), 'BTC')).toEqual(motor);
  });

  it('sem posição, preço inválido e alavancagem fracionária', () => {
    const motor = snapshotDeEstado(estadoCarteira({ preco: 0 }), T0);
    const novo = paraNovoSnapshot(motor, 1, 1);
    expect(novo.posicao).toBeNull();
    expect(novo.marketPx).toBeNull();
    const volta = deSnapshotGravado(
      {
        ...novo,
        id: 1,
        assetId: 1,
        instante: new Date(T0),
        accountValueRepresentativo: true,
        modoConta: null,
      },
      '0x' + 'a'.repeat(40),
      'BTC',
    );
    expect(volta.precoMercado).toBe(0);

    const comPos = snapshotDeEstado(estadoCarteira({ tamanho: 1 }), T0);
    comPos.posicao!.leverage = 0.4;
    expect(paraNovoSnapshot(comPos, 1, 1).posicao!.alavancagem).toBe(1);
  });
});

describe('erros e relógio falso', () => {
  it('erros de domínio com código', () => {
    const e = new ErroAtivoSemCarteiras('BTC');
    expect(e).toBeInstanceOf(ErroAnalise);
    expect(e).toMatchObject({ codigo: 'SEM_CARTEIRAS', name: 'ErroAtivoSemCarteiras' });
  });

  it('o relógio falso dispara por ordem e permite cancelar', () => {
    const r = new RelogioFalso(0);
    const ordem: number[] = [];
    r.agendar(() => ordem.push(2), 20);
    r.agendar(() => ordem.push(1), 10);
    const cancelar = r.agendar(() => ordem.push(3), 15);
    cancelar();
    r.avancar(25);
    expect(ordem).toEqual([1, 2]);
    expect(r.agora()).toBe(25);
    expect(r.pendentes()).toBe(0);
  });
});
