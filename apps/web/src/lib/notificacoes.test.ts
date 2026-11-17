import { describe, expect, it, vi } from 'vitest';
import { evento } from '../test/dados';
import {
  dadosDoEvento,
  mostrarNotificacaoSistema,
  pedirPermissaoNotificacoes,
  permissaoNotificacoes,
  resumoEvento,
  textoNotificacao,
} from './notificacoes';

const n = (s: string) => s.replace(/\s/g, ' ');

class NotificacaoFalsa {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  static criadas: NotificacaoFalsa[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly titulo: string,
    readonly opcoes: NotificationOptions,
  ) {
    NotificacaoFalsa.criadas.push(this);
  }
}

describe('dados e texto dos eventos', () => {
  it('OPENED', () => {
    const e = evento();
    expect(dadosDoEvento(e)).toEqual({ lado: 'long', tamanho: 12.5, entrada: 95_000, extra: null });
    expect(textoNotificacao(e).titulo).toBe('BTC · Abriu posição');
    expect(n(textoNotificacao(e).corpo)).toBe('Baleia A — Long 12,5 · entrada 95 000,00');
  });

  it('CLOSED usa a posição anterior; sem alias mostra o endereço curto', () => {
    const e = evento({
      tipo: 'CLOSED',
      alias: null,
      payload: { posicaoAnterior: { lado: 'short', tamanho: 2, entryPx: 3000 } },
    });
    expect(n(textoNotificacao(e).corpo)).toBe('0xaaaa…aaaa — Short 2 · entrada 3 000,00');
    expect(textoNotificacao(e).titulo).toBe('BTC · Fechou');
  });

  it('FLIPPED, INCREASED, REDUCED', () => {
    expect(
      dadosDoEvento(
        evento({
          tipo: 'FLIPPED',
          payload: {
            posicaoAnterior: { lado: 'long' },
            posicao: { lado: 'short', tamanho: 1, entryPx: 10 },
          },
        }),
      ),
    ).toEqual({ lado: 'short', tamanho: 1, entrada: 10, extra: 'antes Long' });
    expect(
      dadosDoEvento(evento({ tipo: 'FLIPPED', payload: { posicao: { lado: 'short' } } })).extra,
    ).toBeNull();
    const inc = evento({
      tipo: 'INCREASED',
      payload: { lado: 'long', tamanhoAnterior: 1, tamanhoNovo: 2, entryPxNovo: 50 },
    });
    expect(resumoEvento(inc)).toBe('Long 2 · entrada 50,000 · antes 1');
    expect(textoNotificacao(inc).titulo).toBe('BTC · Aumentou');
    const red = evento({ tipo: 'REDUCED', payload: { lado: 'short', tamanhoNovo: 1 } });
    expect(resumoEvento(red)).toBe('Short 1');
    expect(textoNotificacao(red).titulo).toBe('BTC · Reduziu');
  });

  it('LIQ_NEAR e SLTP_CHANGED', () => {
    const liq = evento({
      tipo: 'LIQ_NEAR',
      payload: { lado: 'long', tamanho: 3, liquidationPx: 90_000, distanciaPct: 4.5 },
    });
    expect(n(resumoEvento(liq))).toBe('Long 3 · liquidação 90 000,00 (4,5 %)');
    expect(textoNotificacao(liq).titulo).toBe('BTC · Perto da liquidação');
    expect(dadosDoEvento(evento({ tipo: 'LIQ_NEAR', payload: { tamanho: 3 } })).extra).toBeNull();
    expect(n(resumoEvento(evento({ tipo: 'LIQ_NEAR', payload: { liquidationPx: 10 } })))).toBe(
      'liquidação 10,000',
    );

    const sltp = evento({
      tipo: 'SLTP_CHANGED',
      payload: { lado: 'long', depois: [{ tipo: 'SL', triggerPx: 90_000 }, 'lixo'] },
    });
    expect(n(resumoEvento(sltp))).toBe('Long · SL 90 000,00');
    expect(textoNotificacao(sltp).titulo).toBe('BTC · SL/TP alterado');
    expect(resumoEvento(evento({ tipo: 'SLTP_CHANGED', payload: {} }))).toBe('sem SL/TP');
  });

  it('payload incompleto não rebenta', () => {
    const e = evento({ payload: { posicao: 'x' } });
    expect(dadosDoEvento(e)).toEqual({ lado: null, tamanho: null, entrada: null, extra: null });
    expect(textoNotificacao(e).corpo).toBe('Baleia A');
    expect(resumoEvento(evento({ payload: { posicao: { tamanho: 2 } } }))).toBe('2');
  });
});

describe('notificações do sistema', () => {
  it('sem suporte: indisponível e sem notificação', async () => {
    vi.stubGlobal('Notification', undefined);
    delete (window as { Notification?: unknown }).Notification;
    expect(permissaoNotificacoes()).toBe('indisponivel');
    await expect(pedirPermissaoNotificacoes()).resolves.toBe('indisponivel');
    expect(mostrarNotificacaoSistema(evento(), () => undefined)).toBe(false);
  });

  it('com permissão: cria a notificação e o clique foca e navega', () => {
    NotificacaoFalsa.permission = 'granted';
    NotificacaoFalsa.criadas = [];
    vi.stubGlobal('Notification', NotificacaoFalsa);
    const focar = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const aoClicar = vi.fn();
    expect(mostrarNotificacaoSistema(evento(), aoClicar)).toBe(true);
    const criada = NotificacaoFalsa.criadas[0]!;
    expect(criada.titulo).toBe('BTC · Abriu posição');
    expect(criada.opcoes.tag).toBe('evento-100');
    criada.onclick?.();
    expect(focar).toHaveBeenCalled();
    expect(aoClicar).toHaveBeenCalled();
    expect(criada.close).toHaveBeenCalled();
  });

  it('permissão negada ou erro ao criar: devolve false', () => {
    NotificacaoFalsa.permission = 'denied';
    vi.stubGlobal('Notification', NotificacaoFalsa);
    expect(mostrarNotificacaoSistema(evento(), () => undefined)).toBe(false);
    vi.stubGlobal(
      'Notification',
      Object.assign(
        function () {
          throw new Error('Construtor ilegal');
        },
        { permission: 'granted' },
      ),
    );
    expect(mostrarNotificacaoSistema(evento(), () => undefined)).toBe(false);
  });

  it('pedir permissão', async () => {
    vi.stubGlobal('Notification', NotificacaoFalsa);
    await expect(pedirPermissaoNotificacoes()).resolves.toBe('granted');
    NotificacaoFalsa.requestPermission.mockRejectedValueOnce(new Error('x'));
    NotificacaoFalsa.permission = 'default';
    await expect(pedirPermissaoNotificacoes()).resolves.toBe('default');
  });
});
