import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agregados,
  ativoDetalhe,
  E2,
  evento,
  pagina,
  respostaSugestao,
  sugestaoCarteira,
  sugestaoProporcional,
} from '../test/dados';
import {
  erroApi,
  mockFetch,
  renderizarApp,
  rotasBase,
  type RespostaFalsa,
  type RotaFalsa,
} from '../test/utilitarios';

const n = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');

function rotas(sugestao: RespostaFalsa | ((url: URL) => RespostaFalsa)): RotaFalsa[] {
  return [
    ...rotasBase(),
    { caminho: '/api/ativos/1', resposta: { corpo: ativoDetalhe() } },
    { caminho: '/api/ativos/1/agregados', resposta: { corpo: agregados() } },
    { caminho: '/api/eventos', resposta: { corpo: pagina([evento()]) } },
    { caminho: '/api/ativos/1/sugestao', resposta: sugestao },
  ];
}

const pedidosSugestao = (chamadas: { url: URL }[]) =>
  chamadas.filter((c) => c.url.pathname === '/api/ativos/1/sugestao');

async function calcular() {
  fireEvent.click(await screen.findByRole('button', { name: 'Calcular sugestão proporcional' }));
}

const painel = () => screen.getByRole('region', { name: 'Sugestão proporcional' }) as HTMLElement;

describe('Sugestão proporcional', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('só calcula quando o utilizador pede e permite recalcular', async () => {
    const chamadas = mockFetch(rotas({ corpo: respostaSugestao() }));
    renderizarApp('/ativos/1');
    await screen.findByRole('heading', { name: 'BTC', level: 2 });
    await waitFor(() => expect(screen.getByText('Net long')).toBeInTheDocument());
    expect(pedidosSugestao(chamadas)).toHaveLength(0);

    await calcular();
    expect(await screen.findByRole('heading', { name: 'Baleia A', level: 3 })).toBeInTheDocument();
    expect(pedidosSugestao(chamadas)).toHaveLength(1);
    expect(pedidosSugestao(chamadas)[0]?.url.searchParams.has('carteira')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Recalcular' }));
    await waitFor(() => expect(pedidosSugestao(chamadas)).toHaveLength(2));
    expect(await screen.findByRole('button', { name: 'Recalcular' })).toBeEnabled();
  });

  it('renderiza um caso viável completo', async () => {
    mockFetch(rotas({ corpo: respostaSugestao() }));
    renderizarApp('/ativos/1');
    await calcular();
    const cartao = (await screen.findByRole('article', { name: 'Baleia A' })) as HTMLElement;
    const texto = n(cartao.textContent);
    expect(within(cartao).getByText('Long')).toBeInTheDocument();
    expect(within(cartao).getByText('Viável')).toBeInTheDocument();
    expect(texto).toContain('0,0019 BTC');
    expect(texto).toContain('190,00 US$');
    expect(texto).toContain('38,00 US$');
    expect(texto).toContain('5×');
    expect(texto).toContain('Limitada ao seu máximo');
    expect(texto).toContain('100 000,00');
    expect(texto).toContain('94 737,00');
    expect(texto).toContain('−5,26 %');
    expect(texto).toContain('126 320,00');
    expect(texto).toContain('+26,32 %');
    expect(texto).toContain('Liquidação (estimativa, margem isolada)');
    expect(texto).toContain('80 800,00');
    expect(texto).toContain('Perda até ao SL');
    expect(texto).toContain('9,99 US$');
    expect(texto).toContain('1 : 5');
    expect(texto).toContain('1 : 2');
    expect(texto).toContain('+5,26 % a favor');
    expect(texto).toContain('limiar 3 %');
    expect(texto).toContain('Entrada tardia');
    expect(texto).toContain('Tamanho reduzido para respeitar o risco máximo');
    // Dados da baleia.
    expect(texto).toContain('1 000 000 US$');
    expect(texto).toContain('12,5 %');
    expect(texto).toContain('10× cross');
    expect(texto).toContain('0,001');
    expect(texto).toContain('Snapshot usado');
    expect(
      within(cartao).getByText(
        'Informação para apoio à decisão. Não constitui aconselhamento financeiro.',
      ),
    ).toBeInTheDocument();
    // Instante do cálculo e resultado anunciado.
    expect(n(painel().textContent)).toContain('Calculado em');
    expect(painel().querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByText(/Análise inativa/)).not.toBeInTheDocument();
  });

  it('inviável abaixo da ordem mínima mostra o motivo e os valores calculados', async () => {
    const base = sugestaoProporcional();
    mockFetch(
      rotas({
        corpo: respostaSugestao({
          sugestoes: [
            sugestaoCarteira({
              sugestao: sugestaoProporcional({
                viavel: false,
                motivo: {
                  codigo: 'ABAIXO_ORDEM_MINIMA',
                  mensagem:
                    'O valor da ordem (6,5 USD) fica abaixo do mínimo da Hyperliquid (10 USD).',
                },
                posicao: {
                  ...base.posicao!,
                  alavancagemLimitada: true,
                  alavancagem: 3,
                  notionalUsd: 6.5,
                  tamanho: 0.00006,
                },
              }),
            }),
          ],
        }),
      }),
    );
    renderizarApp('/ativos/1');
    await calcular();
    const cartao = (await screen.findByRole('article', { name: 'Baleia A' })) as HTMLElement;
    expect(within(cartao).getByText('Inviável')).toBeInTheDocument();
    expect(within(cartao).getByText('Sem sugestão viável')).toBeInTheDocument();
    expect(within(cartao).getByText(/abaixo do mínimo da Hyperliquid/)).toBeInTheDocument();
    const texto = n(cartao.textContent);
    expect(texto).toContain('Ordem mínima: 10,00 US$');
    expect(texto).toContain('notional calculado: 6,50 US$');
    expect(texto).toContain('0,00006 BTC');
    expect(texto).toContain('Limitada ao máximo do ativo');
  });

  it('sem SL mostra o aviso crítico e a perda até à liquidação', async () => {
    const base = sugestaoProporcional();
    mockFetch(
      rotas({
        corpo: respostaSugestao({
          analiseAtiva: false,
          precoMercado: {
            valor: 100_000,
            instante: '2026-11-17T12:00:00.000Z',
            fonte: 'snapshot',
          },
          sugestoes: [
            sugestaoCarteira({
              instanteSnapshot: null,
              sugestao: sugestaoProporcional({
                rr: null,
                entradaTardia: null,
                baleia: {
                  ...base.baleia!,
                  accountValueRepresentativo: false,
                  modoConta: 'unifiedAccount',
                },
                posicao: {
                  ...base.posicao!,
                  alavancagemLimitada: false,
                  limitadoPeloRisco: false,
                  stopLoss: null,
                  takeProfit: null,
                  liquidacaoEstimada: null,
                  perdaAteStopUsd: null,
                  perdaAteLiquidacaoUsd: 38,
                },
                avisos: [
                  {
                    codigo: 'SEM_STOP_LOSS',
                    nivel: 'critico',
                    mensagem: 'A baleia não tem SL visível na exchange.',
                  },
                ],
              }),
            }),
          ],
        }),
      }),
    );
    renderizarApp('/ativos/1');
    await calcular();
    const cartao = (await screen.findByRole('article', { name: 'Baleia A' })) as HTMLElement;
    expect(within(cartao).getByText('Sem SL')).toBeInTheDocument();
    expect(within(cartao).getByText('Sem TP')).toBeInTheDocument();
    const critico = cartao.querySelector('[data-nivel="critico"]');
    expect(n(critico?.textContent)).toContain('Crítico: A baleia não tem SL visível');
    expect(critico?.querySelector('svg')).not.toBeNull();
    const texto = n(cartao.textContent);
    expect(texto).toContain('Perda até à liquidação');
    expect(texto).toContain('Sem liquidação');
    expect(texto).toContain('Não representativo');
    expect(texto).toContain('unifiedAccount');
    expect(texto).toContain('Snapshot usado: nenhum');
    expect(screen.getByText(/Análise inativa: usa-se o último snapshot/)).toBeInTheDocument();
    expect(n(painel().textContent)).toContain('último gravado');
  });

  it('avisos ordenados por nível: crítico, atenção, informação', async () => {
    mockFetch(
      rotas({
        corpo: respostaSugestao({
          sugestoes: [
            sugestaoCarteira({
              sugestao: sugestaoProporcional({
                avisos: [
                  { codigo: 'MARGEM_CRUZADA_BALEIA', nivel: 'info', mensagem: 'I1' },
                  { codigo: 'ENTRADA_TARDIA', nivel: 'atencao', mensagem: 'A1' },
                  { codigo: 'SEM_STOP_LOSS', nivel: 'critico', mensagem: 'C1' },
                  { codigo: 'ANALISE_INATIVA', nivel: 'atencao', mensagem: 'A2' },
                ],
              }),
            }),
          ],
        }),
      }),
    );
    renderizarApp('/ativos/1');
    await calcular();
    const cartao = (await screen.findByRole('article', { name: 'Baleia A' })) as HTMLElement;
    const niveis = [...cartao.querySelectorAll('[data-nivel]')].map((e) => [
      e.getAttribute('data-nivel'),
      n(e.textContent),
    ]);
    expect(niveis).toEqual([
      ['critico', 'Crítico: C1'],
      ['atencao', 'Atenção: A1'],
      ['atencao', 'Atenção: A2'],
      ['info', 'Informação: I1'],
    ]);
  });

  it('erro 422 de capital mostra o link para Definições', async () => {
    mockFetch(
      rotas(
        erroApi(
          422,
          'CAPITAL_NAO_CONFIGURADO',
          'Configure o capital disponível em Definições para obter a sugestão proporcional.',
        ),
      ),
    );
    renderizarApp('/ativos/1');
    await calcular();
    const link = await screen.findByRole('link', { name: 'Ir para Definições' });
    expect(link).toHaveAttribute('href', '/definicoes');
    expect(screen.getByText(/configure primeiro o capital disponível/)).toBeInTheDocument();
  });

  it('outros erros e estado vazio sem posições', async () => {
    let falhar = true;
    mockFetch(
      rotas(() =>
        falhar
          ? erroApi(500, 'ERRO_INTERNO', 'Falha a calcular a sugestão.')
          : { corpo: respostaSugestao({ sugestoes: [], precoMercado: null }) },
      ),
    );
    renderizarApp('/ativos/1');
    await calcular();
    expect(await screen.findByText('Falha a calcular a sugestão.')).toBeInTheDocument();
    falhar = false;
    await calcular();
    expect(await screen.findByText(/Nenhuma carteira tem posição em BTC/)).toBeInTheDocument();
  });

  it('o botão de uma carteira envia ?carteira= e leva ao painel', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const chamadas = mockFetch(rotas({ corpo: respostaSugestao(), estado: 200 }));
    renderizarApp('/ativos/1');
    // Só as carteiras com posição têm o botão.
    expect(
      screen.queryByRole('button', { name: `Sugestão para ${E2.slice(0, 6)}…${E2.slice(-4)}` }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Sugestão para Baleia A' }));
    await waitFor(() => expect(pedidosSugestao(chamadas)).toHaveLength(1));
    expect(pedidosSugestao(chamadas)[0]?.url.searchParams.get('carteira')).toBe('10');
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('painel-sugestao');

    // Recalcular mantém a carteira; "todas" retira o filtro.
    fireEvent.click(await screen.findByRole('button', { name: 'Recalcular' }));
    await waitFor(() => expect(pedidosSugestao(chamadas)).toHaveLength(2));
    expect(pedidosSugestao(chamadas)[1]?.url.searchParams.get('carteira')).toBe('10');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Calcular para todas as carteiras' }),
    );
    await waitFor(() => expect(pedidosSugestao(chamadas)).toHaveLength(3));
    expect(pedidosSugestao(chamadas)[2]?.url.searchParams.has('carteira')).toBe(false);
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  it('copiar valores escreve só texto na área de transferência', async () => {
    const escrever = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('x'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: escrever },
      configurable: true,
    });
    const chamadas = mockFetch(rotas({ corpo: respostaSugestao() }));
    renderizarApp('/ativos/1');
    await calcular();
    const botao = await screen.findByRole('button', {
      name: 'Copiar valores da sugestão para Baleia A',
    });
    const antes = chamadas.length;
    fireEvent.click(botao);
    expect(await screen.findByText('Copiado (só texto).')).toBeInTheDocument();
    const texto = escrever.mock.calls[0]?.[0] as string;
    expect(n(texto)).toContain('Lado: Long');
    expect(n(texto)).toContain('Tamanho: 0,0019 BTC');
    expect(n(texto)).toContain('Alavancagem: 5×');
    expect(n(texto)).toContain('SL: 94 737,00 (−5,26 %)');
    expect(n(texto)).toContain('TP: 126 320,00 (+26,32 %)');
    expect(texto).toContain('não é uma ordem');
    // Copiar não faz nenhum pedido.
    expect(chamadas.length).toBe(antes);

    fireEvent.click(botao);
    expect(await screen.findByText(/Não foi possível copiar/)).toBeInTheDocument();
  });
});
