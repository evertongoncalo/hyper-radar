import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ativoResumo, INSTANTE } from '../test/dados';
import { erroApi, mockFetch, renderizarApp, rotasBase } from '../test/utilitarios';

describe('Painel', () => {
  it('estado de carregamento', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    renderizarApp('/');
    expect(screen.getByText('A carregar ativos…')).toBeInTheDocument();
  });

  it('estado de erro com nova tentativa', async () => {
    mockFetch([
      ...rotasBase(),
      {
        caminho: '/api/ativos',
        resposta: erroApi(503, 'SERVICO_INDISPONIVEL', 'BD indisponível.'),
      },
    ]);
    renderizarApp('/');
    expect(await screen.findByText('BD indisponível.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });

  it('estado vazio', async () => {
    mockFetch(rotasBase());
    renderizarApp('/');
    expect(await screen.findByText(/Ainda não há ativos/)).toBeInTheDocument();
  });

  it('lista os ativos com estado, contagens e indicador de dados desatualizados', async () => {
    mockFetch([
      ...rotasBase(),
      {
        caminho: '/api/ativos',
        resposta: {
          corpo: [
            ativoResumo(),
            ativoResumo({
              id: 2,
              ticker: 'xyz:NVDA',
              dex: 'xyz',
              estado: 'running',
              numeroCarteiras: 4,
              eventosNaoLidos: 0,
              saude: {
                runId: 1,
                cicloEmCurso: false,
                ultimoCicloSucesso: INSTANTE,
                ultimoErro: null,
                carteirasDesatualizadas: [7],
              },
            }),
          ],
        },
      },
    ]);
    renderizarApp('/');
    const nvda = (await screen.findByRole('link', { name: 'xyz:NVDA' })).closest('li')!;
    expect(within(nvda).getByText('Em análise')).toBeInTheDocument();
    expect(within(nvda).getByText('4')).toBeInTheDocument();
    expect(within(nvda).getByText(/Dados desatualizados: 1 carteira/)).toBeInTheDocument();
    expect(within(nvda).getByRole('button', { name: 'Parar análise de xyz:NVDA' })).toBeEnabled();
    const btc = screen.getByRole('link', { name: 'BTC' }).closest('li')!;
    expect(within(btc).getByText('Inativo')).toBeInTheDocument();
    expect(within(btc).queryByText(/Dados desatualizados/)).not.toBeInTheDocument();
    // Aviso legal sempre presente.
    expect(
      screen.getByText('Informação para apoio à decisão. Não constitui aconselhamento financeiro.'),
    ).toBeInTheDocument();
  });

  it('adicionar ativo: valida no cliente e mostra o erro da API com sugestão', async () => {
    const chamadas = mockFetch([
      ...rotasBase(),
      {
        metodo: 'POST',
        caminho: '/api/ativos',
        resposta: erroApi(
          400,
          'TICKER_INEXISTENTE',
          'O ativo "nvda" não existe no DEX "xyz" da Hyperliquid. Quis dizer "NVDA"?',
        ),
      },
    ]);
    renderizarApp('/');
    const campo = await screen.findByLabelText(/Ticker/);
    fireEvent.change(campo, { target: { value: 'a b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar ativo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ticker inválido');
    expect(chamadas.some((c) => c.metodo === 'POST')).toBe(false);

    fireEvent.change(campo, { target: { value: ' xyz:nvda ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar ativo' }));
    expect(await screen.findByText(/Quis dizer "NVDA"\?/)).toBeInTheDocument();
    expect(chamadas.find((c) => c.metodo === 'POST')?.corpo).toEqual({ ticker: 'xyz:nvda' });
  });

  it('adicionar ativo com sucesso atualiza a lista', async () => {
    let lista = [] as ReturnType<typeof ativoResumo>[];
    mockFetch([
      ...rotasBase(),
      { caminho: '/api/ativos', resposta: () => ({ corpo: lista }) },
      {
        metodo: 'POST',
        caminho: '/api/ativos',
        resposta: () => {
          lista = [ativoResumo({ numeroCarteiras: 0, eventosNaoLidos: 0 })];
          return { estado: 201, corpo: lista[0] };
        },
      },
    ]);
    renderizarApp('/');
    fireEvent.change(await screen.findByLabelText(/Ticker/), { target: { value: 'BTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar ativo' }));
    expect(await screen.findByRole('link', { name: 'BTC' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Ticker/)).toHaveValue('');
  });

  it('iniciar e parar análise', async () => {
    let estado: 'idle' | 'running' | 'stopped' = 'idle';
    const alternar = (novo: typeof estado) => () => {
      estado = novo;
      return { corpo: ativoResumo({ estado }) };
    };
    const chamadas = mockFetch([
      ...rotasBase(),
      { caminho: '/api/ativos', resposta: () => ({ corpo: [ativoResumo({ estado })] }) },
      { metodo: 'POST', caminho: '/api/ativos/1/analise/iniciar', resposta: alternar('running') },
      { metodo: 'POST', caminho: '/api/ativos/1/analise/parar', resposta: alternar('stopped') },
    ]);
    renderizarApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar análise de BTC' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.url.pathname === '/api/ativos/1/analise/iniciar')).toBe(true),
    );
    expect(await screen.findByText('Em análise')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Parar análise de BTC' }));
    expect(await screen.findByText('Parado')).toBeInTheDocument();
    expect(chamadas.some((c) => c.url.pathname === '/api/ativos/1/analise/parar')).toBe(true);
  });

  it('erro ao iniciar (sem carteiras) aparece junto ao botão', async () => {
    mockFetch([
      ...rotasBase(),
      { caminho: '/api/ativos', resposta: { corpo: [ativoResumo()] } },
      {
        metodo: 'POST',
        caminho: '/api/ativos/1/analise/iniciar',
        resposta: erroApi(409, 'SEM_CARTEIRAS', 'O ativo não tem carteiras.'),
      },
    ]);
    renderizarApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar análise de BTC' }));
    expect(await screen.findByText('O ativo não tem carteiras.')).toBeInTheDocument();
  });
});
