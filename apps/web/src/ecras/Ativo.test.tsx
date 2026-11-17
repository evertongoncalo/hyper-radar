import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { agregados, ativoDetalhe, E2, evento, pagina } from '../test/dados';
import { erroApi, mockFetch, renderizarApp, rotasBase, type RotaFalsa } from '../test/utilitarios';

const n = (s: string | null) => (s ?? '').replace(/\s/g, ' ');

function rotasAtivo(extra: RotaFalsa[] = []): RotaFalsa[] {
  return [
    ...rotasBase(),
    { caminho: '/api/ativos/1', resposta: { corpo: ativoDetalhe() } },
    { caminho: '/api/ativos/1/agregados', resposta: { corpo: agregados() } },
    { caminho: '/api/eventos', resposta: { corpo: pagina([evento()]) } },
    ...extra,
  ];
}

describe('Ativo (detalhe)', () => {
  it('carregamento', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    renderizarApp('/ativos/1');
    expect(screen.getByText('A carregar ativo…')).toBeInTheDocument();
  });

  it('erro (ativo inexistente) e id inválido', async () => {
    mockFetch([
      ...rotasBase(),
      {
        caminho: '/api/ativos/9',
        resposta: erroApi(404, 'NAO_ENCONTRADO', 'Ativo 9 não encontrado(a).'),
      },
    ]);
    const { unmount } = renderizarApp('/ativos/9');
    expect(await screen.findByText('Ativo 9 não encontrado(a).')).toBeInTheDocument();
    unmount();
    renderizarApp('/ativos/abc');
    expect(screen.getByText('Identificador de ativo inválido.')).toBeInTheDocument();
  });

  it('cabeçalho, tabela de carteiras com SL/TP e marcações', async () => {
    mockFetch(rotasAtivo());
    renderizarApp('/ativos/1');
    expect(await screen.findByRole('heading', { name: 'BTC', level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText('Em análise').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Parar análise de BTC' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Só são visíveis SL/TP colocados na exchange; stops geridos fora dela não aparecem.',
      ),
    ).toBeInTheDocument();

    const tabela = screen.getByRole('table', { name: /Carteiras e posições/ });
    const linhaA = within(tabela)
      .getByRole('rowheader', { name: /Baleia A/ })
      .closest('tr')!;
    const texto = n(linhaA.textContent);
    expect(texto).toContain('Long');
    expect(texto).toContain('1 250 000 US$');
    expect(texto).toContain('95 000,00');
    expect(texto).toContain('10×');
    expect(texto).toContain('cross');
    expect(texto).toContain('80 000,00');
    expect(texto).toContain('20 %');
    expect(texto).toContain('+62 500 US$');
    expect(texto).toContain('90 000,00');
    expect(texto).toContain('120 000,00');
    expect(texto).toContain('Entidade: Fundo X');

    const linhaB = within(tabela)
      .getByRole('rowheader', { name: /0xbbbb…bbbb/ })
      .closest('tr')!;
    expect(within(linhaB).getByText('Desatualizada')).toBeInTheDocument();
    expect(within(linhaB).getByText(/Equity não representativa/)).toBeInTheDocument();
    expect(within(linhaB).getByText('Sem posição neste ativo.')).toBeInTheDocument();
  });

  it('agregados, sugestão a pedido e espaço reservado para a Fase 6', async () => {
    mockFetch(rotasAtivo());
    renderizarApp('/ativos/1');
    expect(await screen.findByText('Net long')).toBeInTheDocument();
    expect(screen.getByText('1 / 0')).toBeInTheDocument();
    expect(screen.getByText(/Hedge interno/)).toBeInTheDocument();
    expect(screen.getByText('Variação 1 h')).toBeInTheDocument();
    expect(screen.getByText('Sem histórico suficiente.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calcular sugestão proporcional' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Pedir análise IA' })).toBeDisabled();
    expect(screen.getAllByText('Disponível em breve.')).toHaveLength(1);
  });

  it('erro nos agregados não esconde o resto', async () => {
    mockFetch(
      rotasAtivo([
        {
          caminho: '/api/ativos/1/agregados',
          resposta: erroApi(500, 'ERRO_INTERNO', 'Falha a calcular.'),
        },
      ]),
    );
    renderizarApp('/ativos/1');
    expect(await screen.findByText('Falha a calcular.')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('feed: marcar um evento e todos como lidos', async () => {
    const chamadas = mockFetch(
      rotasAtivo([
        {
          metodo: 'POST',
          caminho: '/api/eventos/100/lido',
          resposta: { corpo: { id: 100, lido: true } },
        },
        {
          metodo: 'POST',
          caminho: '/api/ativos/1/eventos/lidos',
          resposta: { corpo: { marcados: 3 } },
        },
      ]),
    );
    renderizarApp('/ativos/1');
    fireEvent.click(await screen.findByRole('button', { name: /Marcar como lido: Abriu posição/ }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.url.pathname === '/api/eventos/100/lido')).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Marcar todos como lidos (3)' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.url.pathname === '/api/ativos/1/eventos/lidos')).toBe(true),
    );
    // O feed pede só os eventos deste ativo.
    expect(
      chamadas.find((c) => c.url.pathname === '/api/eventos')?.url.searchParams.get('ativo'),
    ).toBe('1');
  });

  it('feed vazio', async () => {
    mockFetch(rotasAtivo([{ caminho: '/api/eventos', resposta: { corpo: pagina([]) } }]));
    renderizarApp('/ativos/1');
    expect(await screen.findByText('Ainda não há eventos para este ativo.')).toBeInTheDocument();
  });

  it('remover carteira pede confirmação (reinicia a análise)', async () => {
    const chamadas = mockFetch(
      rotasAtivo([
        { metodo: 'DELETE', caminho: '/api/ativos/1/carteiras/10', resposta: { estado: 204 } },
      ]),
    );
    const confirmar = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderizarApp('/ativos/1');
    const botao = await screen.findByRole('button', { name: 'Remover Baleia A deste ativo' });
    fireEvent.click(botao);
    expect(confirmar.mock.calls[0]?.[0]).toMatch(/reiniciada/);
    expect(chamadas.some((c) => c.metodo === 'DELETE')).toBe(false);
    fireEvent.click(botao);
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'DELETE')).toBe(true));
  });

  it('adicionar carteira: valida o endereço e avisa que a análise foi reiniciada', async () => {
    const chamadas = mockFetch(
      rotasAtivo([
        {
          metodo: 'POST',
          caminho: '/api/ativos/1/carteiras',
          resposta: {
            estado: 201,
            corpo: {
              carteira: {
                id: 12,
                endereco: E2,
                alias: 'Nova',
                entidade: null,
                criadoEm: '2026-11-17T12:00:00.000Z',
              },
              analiseReiniciada: true,
            },
          },
        },
      ]),
    );
    renderizarApp('/ativos/1');
    expect(await screen.findByText(/reinicia a análise deste ativo/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Endereço'), { target: { value: '0x123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar carteira' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(chamadas.some((c) => c.url.pathname === '/api/ativos/1/carteiras')).toBe(false);

    fireEvent.change(screen.getByLabelText('Endereço'), { target: { value: E2 } });
    fireEvent.change(screen.getByLabelText('Alias (opcional)'), { target: { value: 'Nova' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar carteira' }));
    expect(
      await screen.findByText('Carteira adicionada. A análise foi reiniciada.'),
    ).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname === '/api/ativos/1/carteiras')?.corpo).toEqual({
      endereco: E2,
      alias: 'Nova',
      entidade: null,
    });
  });

  it('erro da API ao adicionar carteira já associada', async () => {
    mockFetch(
      rotasAtivo([
        {
          metodo: 'POST',
          caminho: '/api/ativos/1/carteiras',
          resposta: erroApi(409, 'CARTEIRA_JA_ASSOCIADA', 'A carteira já está associada a "BTC".'),
        },
      ]),
    );
    renderizarApp('/ativos/1');
    fireEvent.change(await screen.findByLabelText('Endereço'), { target: { value: E2 } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar carteira' }));
    expect(await screen.findByText('A carteira já está associada a "BTC".')).toBeInTheDocument();
  });

  it('preço do último snapshot quando a Hyperliquid está indisponível', async () => {
    mockFetch(
      rotasAtivo([
        {
          caminho: '/api/ativos/1',
          resposta: {
            corpo: ativoDetalhe({
              carteiras: [],
              precoMercado: {
                valor: 99_000,
                instante: '2026-11-17T12:00:00.000Z',
                fonte: 'snapshot',
              },
            }),
          },
        },
      ]),
    );
    renderizarApp('/ativos/1');
    expect(await screen.findByText(/último gravado/)).toBeInTheDocument();
    expect(screen.getByText(/ainda não tem carteiras/)).toBeInTheDocument();
  });
});
