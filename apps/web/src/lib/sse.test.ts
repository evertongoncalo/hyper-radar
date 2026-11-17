import { describe, expect, it, vi } from 'vitest';
import { evento } from '../test/dados';
import { EventSourceFalso } from '../test/eventSourceFalso';
import { criarLigadorSse } from './sse';

describe('ligador SSE', () => {
  it('liga, valida e entrega os eventos nomeados', () => {
    const aoEvento = vi.fn();
    const l = criarLigadorSse({ aoEvento });
    const estados: string[] = [];
    l.subscrever((e) => estados.push(e));
    l.ligar();
    l.ligar(); // idempotente
    expect(EventSourceFalso.instancias).toHaveLength(1);
    const es = EventSourceFalso.ultima();
    expect(es.url).toBe('/api/stream');
    es.abrir();
    expect(l.estado()).toBe('ligado');

    es.emitir('evento', evento(), '100');
    es.emitir('evento', { invalido: true }, '101');
    es.emitir('ciclo', 'não é json');
    expect(aoEvento).toHaveBeenCalledTimes(1);
    expect(aoEvento).toHaveBeenCalledWith('evento', evento());
    expect(estados).toEqual(['a-ligar', 'ligado']);
  });

  it('reconexão do browser: "a reconectar" e aoReligar ao voltar', () => {
    const aoReligar = vi.fn();
    const l = criarLigadorSse({ aoEvento: vi.fn(), aoReligar });
    l.ligar();
    const es = EventSourceFalso.ultima();
    es.abrir();
    es.falhar();
    expect(l.estado()).toBe('a-reconectar');
    es.abrir();
    expect(l.estado()).toBe('ligado');
    expect(aoReligar).toHaveBeenCalledTimes(1);
  });

  it('se o browser desistir, recria a ligação com desdeId', () => {
    vi.useFakeTimers();
    const l = criarLigadorSse({ aoEvento: vi.fn(), atrasoRecriar: () => 1000 });
    l.ligar();
    const es = EventSourceFalso.ultima();
    es.abrir();
    es.emitir('evento', evento({ id: 42 }), '42');
    es.falhar(true);
    expect(l.estado()).toBe('desligado');
    vi.advanceTimersByTime(1000);
    expect(EventSourceFalso.instancias).toHaveLength(2);
    expect(EventSourceFalso.ultima().url).toBe('/api/stream?desdeId=42');
    l.desligar();
    expect(EventSourceFalso.ultima().readyState).toBe(EventSourceFalso.CLOSED);
  });

  it('desligar cancela a recriação pendente', () => {
    vi.useFakeTimers();
    const l = criarLigadorSse({ aoEvento: vi.fn() });
    l.ligar();
    EventSourceFalso.ultima().falhar(true);
    l.desligar();
    vi.advanceTimersByTime(60_000);
    expect(EventSourceFalso.instancias).toHaveLength(1);
    expect(l.estado()).toBe('desligado');
  });
});
