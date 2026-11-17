import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { alterarPreferencias } from '../lib/preferencias';
import { agregados, ativoDetalhe, ativoResumo, evento, pagina } from '../test/dados';
import { EventSourceFalso } from '../test/eventSourceFalso';
import { mockFetch, renderizarApp, rotasBase, type RotaFalsa } from '../test/utilitarios';

function rotas(obterEventos: () => ReturnType<typeof evento>[]): RotaFalsa[] {
  return [
    ...rotasBase(),
    { caminho: '/api/ativos/1', resposta: { corpo: ativoDetalhe() } },
    { caminho: '/api/ativos/1/agregados', resposta: { corpo: agregados() } },
    { caminho: '/api/eventos', resposta: () => ({ corpo: pagina(obterEventos()) }) },
  ];
}

const novo = evento({
  id: 101,
  tipo: 'INCREASED',
  payload: { lado: 'long', tamanhoAnterior: 12.5, tamanhoNovo: 20, entryPxNovo: 96_000 },
});

class NotificacaoFalsa {
  static permission: NotificationPermission = 'granted';
  static criadas: NotificacaoFalsa[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly titulo: string) {
    NotificacaoFalsa.criadas.push(this);
  }
}

describe('tempo real (SSE)', () => {
  it('indicador de ligação: a ligar → ligado → a reconectar', async () => {
    mockFetch(rotasBase());
    renderizarApp('/');
    expect(screen.getByText('Tempo real: A ligar…')).toBeInTheDocument();
    const es = EventSourceFalso.ultima();
    act(() => es.abrir());
    expect(screen.getByText('Tempo real: Ligado')).toBeInTheDocument();
    act(() => es.falhar());
    expect(screen.getByText('Tempo real: A reconectar…')).toBeInTheDocument();
    expect(EventSourceFalso.instancias).toHaveLength(1);
  });

  it('evento novo: atualiza o feed e mostra toast + som sem permissão de notificações', async () => {
    let eventos = [evento()];
    mockFetch(rotas(() => eventos));
    const osc = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running';
        currentTime = 0;
        destination = {};
        createOscillator = () => {
          osc();
          return { frequency: {}, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
        };
        createGain = () => ({
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
        });
      },
    );
    renderizarApp('/ativos/1');
    expect(await screen.findByText(/entrada 95/)).toBeInTheDocument();

    eventos = [novo, ...eventos];
    const es = EventSourceFalso.ultima();
    act(() => {
      es.abrir();
      es.emitir('evento', novo, '101');
      es.emitir('evento', novo, '101'); // reenvio duplicado: um só alerta
    });

    // Feed atualizado (refetch) com o evento novo.
    expect(await screen.findByText(/Long 20 · entrada 96/)).toBeInTheDocument();
    // Toast in-app acessível.
    const toast = await screen.findByText('BTC · Aumentou');
    expect(toast.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getAllByText('BTC · Aumentou')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Ver ativo' })).toHaveAttribute('href', '/ativos/1');
    expect(osc).toHaveBeenCalledTimes(1);
  });

  it('com permissão: notificação do sistema; clicar abre o detalhe do ativo', async () => {
    NotificacaoFalsa.criadas = [];
    vi.stubGlobal('Notification', NotificacaoFalsa);
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    mockFetch([
      ...rotas(() => [evento()]),
      { caminho: '/api/ativos', resposta: { corpo: [ativoResumo()] } },
    ]);
    renderizarApp('/');
    await screen.findByRole('link', { name: 'BTC' });
    act(() => EventSourceFalso.ultima().emitir('evento', novo, '101'));
    expect(NotificacaoFalsa.criadas).toHaveLength(1);
    expect(NotificacaoFalsa.criadas[0]!.titulo).toBe('BTC · Aumentou');
    expect(screen.queryByText('BTC · Aumentou')).not.toBeInTheDocument();
    act(() => NotificacaoFalsa.criadas[0]!.onclick?.());
    expect(await screen.findByRole('heading', { name: 'BTC', level: 2 })).toBeInTheDocument();
  });

  it('notificações desativadas nas preferências: usa toast mesmo com permissão; sem som', async () => {
    NotificacaoFalsa.criadas = [];
    vi.stubGlobal('Notification', NotificacaoFalsa);
    alterarPreferencias({ notificacoes: false, som: false });
    const contexto = vi.fn();
    vi.stubGlobal('AudioContext', contexto);
    mockFetch(rotasBase());
    renderizarApp('/');
    act(() => EventSourceFalso.ultima().emitir('evento', novo, '101'));
    expect(await screen.findByText('BTC · Aumentou')).toBeInTheDocument();
    expect(NotificacaoFalsa.criadas).toHaveLength(0);
    expect(contexto).not.toHaveBeenCalled();
  });

  it('estado-ativo atualiza o estado na lista sem esperar pelo refetch', async () => {
    let estado: 'idle' | 'running' = 'idle';
    mockFetch([
      ...rotasBase(),
      { caminho: '/api/ativos', resposta: () => ({ corpo: [ativoResumo({ estado })] }) },
    ]);
    renderizarApp('/');
    expect(await screen.findByText('Inativo')).toBeInTheDocument();
    estado = 'running';
    act(() =>
      EventSourceFalso.ultima().emitir('estado-ativo', {
        assetId: 1,
        ticker: 'BTC',
        anterior: 'idle',
        estado: 'running',
        runId: 1,
        instante: '2026-11-17T12:00:00.000Z',
      }),
    );
    expect(await screen.findByText('Em análise')).toBeInTheDocument();
  });

  it('ciclo e religação invalidam as queries', async () => {
    const chamadas = mockFetch(rotas(() => []));
    renderizarApp('/ativos/1');
    await screen.findByRole('heading', { name: 'BTC', level: 2 });
    const antes = chamadas.filter((c) => c.url.pathname === '/api/ativos/1').length;
    const es = EventSourceFalso.ultima();
    act(() => {
      es.abrir();
      es.emitir('ciclo', {
        assetId: 1,
        ticker: 'BTC',
        runId: 1,
        instante: '2026-11-17T12:00:00.000Z',
        duracaoMs: 100,
        carteirasOk: 2,
        carteirasFalhadas: 0,
        eventos: 0,
        falhou: false,
        erro: null,
      });
    });
    await waitFor(() =>
      expect(chamadas.filter((c) => c.url.pathname === '/api/ativos/1').length).toBeGreaterThan(
        antes,
      ),
    );
    const depoisCiclo = chamadas.length;
    act(() => {
      es.falhar();
      es.abrir();
    });
    await waitFor(() => expect(chamadas.length).toBeGreaterThan(depoisCiclo));
  });
});
