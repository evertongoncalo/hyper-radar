import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ativoResumo, carteiraGlobal, evento, pagina } from '../test/dados';
import { erroApi, mockFetch, renderizarApp, rotasBase, type Chamada } from '../test/utilitarios';
import { paraFiltros } from './Eventos';

const pedidosEventos = (chamadas: Chamada[]) =>
  chamadas
    .filter((c) => c.url.pathname === '/api/eventos')
    .map((c) => Object.fromEntries(c.url.searchParams));

describe('Eventos (histórico)', () => {
  it('carregamento, vazio e erro', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    const r1 = renderizarApp('/eventos');
    expect(screen.getByText('A carregar eventos…')).toBeInTheDocument();
    r1.unmount();

    mockFetch(rotasBase());
    const r2 = renderizarApp('/eventos');
    expect(await screen.findByText('Nenhum evento com estes filtros.')).toBeInTheDocument();
    r2.unmount();

    mockFetch([
      ...rotasBase(),
      { caminho: '/api/eventos', resposta: erroApi(400, 'VALIDACAO', 'Pedido inválido.') },
    ]);
    renderizarApp('/eventos');
    expect(await screen.findByText('Pedido inválido.')).toBeInTheDocument();
  });

  it('paginação "carregar mais" por cursor', async () => {
    const chamadas = mockFetch([
      ...rotasBase(),
      {
        caminho: '/api/eventos',
        resposta: (url) =>
          url.searchParams.get('cursor') === '100'
            ? { corpo: pagina([evento({ id: 99, tipo: 'CLOSED', payload: {} })], null) }
            : { corpo: pagina([evento()], 100) },
      },
    ]);
    renderizarApp('/eventos');
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
    expect(
      await screen.findByRole('button', { name: 'Marcar como lido: Fechou de Baleia A em BTC' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();
    expect(pedidosEventos(chamadas).map((q) => q.cursor)).toEqual([undefined, '100']);
  });

  it('filtros: ativo, carteira, tipos, só não lidos e datas em hora de Lisboa', async () => {
    const chamadas = mockFetch([
      ...rotasBase(),
      { caminho: '/api/ativos', resposta: { corpo: [ativoResumo()] } },
      { caminho: '/api/carteiras', resposta: { corpo: [carteiraGlobal()] } },
      { caminho: '/api/eventos', resposta: { corpo: pagina([evento()]) } },
    ]);
    renderizarApp('/eventos');
    await screen.findByRole('option', { name: 'BTC' });
    await screen.findByRole('option', { name: 'Baleia A' });
    fireEvent.change(screen.getByLabelText('Ativo'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Carteira'), { target: { value: '10' } });
    fireEvent.click(screen.getByLabelText('Abriu posição'));
    fireEvent.click(screen.getByLabelText('Inverteu'));
    fireEvent.click(screen.getByLabelText('Só não lidos'));
    fireEvent.change(screen.getByLabelText('Desde (Lisboa)'), {
      target: { value: '2026-07-10T12:00' },
    });
    fireEvent.change(screen.getByLabelText('Até (Lisboa)'), {
      target: { value: '2026-12-10T12:00' },
    });

    await waitFor(() =>
      expect(pedidosEventos(chamadas).at(-1)).toEqual({
        ativo: '1',
        carteira: '10',
        tipos: 'OPENED,FLIPPED',
        naoLidos: 'true',
        desde: '2026-07-10T11:00:00.000Z',
        ate: '2026-12-10T12:00:00.000Z',
        limite: '50',
      }),
    );

    // Desmarcar um tipo e limpar tudo.
    fireEvent.click(screen.getByLabelText('Abriu posição'));
    await waitFor(() => expect(pedidosEventos(chamadas).at(-1)?.tipos).toBe('FLIPPED'));
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(pedidosEventos(chamadas).at(-1)).toEqual({ limite: '50' }));
  });

  it('intervalo de datas incoerente mostra erro e não filtra por datas', async () => {
    mockFetch(rotasBase());
    renderizarApp('/eventos');
    fireEvent.change(await screen.findByLabelText('Desde (Lisboa)'), {
      target: { value: '2026-07-10T12:00' },
    });
    fireEvent.change(screen.getByLabelText('Até (Lisboa)'), {
      target: { value: '2026-07-01T12:00' },
    });
    expect(
      await screen.findByText('"Desde" tem de ser anterior ou igual a "Até".'),
    ).toBeInTheDocument();
  });

  it('marcar como lido no histórico', async () => {
    const chamadas = mockFetch([
      ...rotasBase(),
      {
        caminho: '/api/eventos',
        resposta: { corpo: pagina([evento(), evento({ id: 7, lido: true })]) },
      },
      {
        metodo: 'POST',
        caminho: '/api/eventos/100/lido',
        resposta: { corpo: { id: 100, lido: true } },
      },
    ]);
    renderizarApp('/eventos');
    const botoes = await screen.findAllByRole('button', { name: /Marcar como lido/ });
    expect(botoes).toHaveLength(1);
    fireEvent.click(botoes[0]!);
    await waitFor(() =>
      expect(chamadas.some((c) => c.url.pathname === '/api/eventos/100/lido')).toBe(true),
    );
  });

  it('erro ao marcar como lido', async () => {
    mockFetch([
      ...rotasBase(),
      { caminho: '/api/eventos', resposta: { corpo: pagina([evento()]) } },
      {
        metodo: 'POST',
        caminho: '/api/eventos/100/lido',
        resposta: erroApi(404, 'NAO_ENCONTRADO', 'Evento 100 não encontrado(a).'),
      },
    ]);
    renderizarApp('/eventos');
    fireEvent.click(await screen.findByRole('button', { name: /Marcar como lido/ }));
    expect(await screen.findByText('Evento 100 não encontrado(a).')).toBeInTheDocument();
  });

  it('paraFiltros: datas inválidas', () => {
    const base = { ativo: '', carteira: '', tipos: [], naoLidos: false, desde: '', ate: '' };
    expect(paraFiltros({ ...base, desde: 'lixo' }).erro).toBe('Data inválida.');
    expect(paraFiltros(base)).toEqual({
      erro: null,
      filtros: {
        ativo: undefined,
        carteira: undefined,
        tipos: undefined,
        naoLidos: undefined,
        desde: undefined,
        ate: undefined,
        limite: 50,
      },
    });
  });
});
