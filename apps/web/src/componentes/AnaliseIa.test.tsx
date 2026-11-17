import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  agregados,
  ativoDetalhe,
  estadoIaBase,
  evento,
  pagina,
  relatorioIaDto,
  respostaAnaliseIa,
  resumoRelatorioIa,
} from '../test/dados';
import { EventSourceFalso } from '../test/eventSourceFalso';
import {
  erroApi,
  mockFetch,
  renderizarApp,
  rotasBase,
  type Chamada,
  type RespostaFalsa,
  type RotaFalsa,
} from '../test/utilitarios';

const n = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');

function rotas(
  analise: RespostaFalsa | ((url: URL, init: RequestInit | undefined) => RespostaFalsa),
  extra: RotaFalsa[] = [],
): RotaFalsa[] {
  return [
    ...rotasBase(),
    { caminho: '/api/ativos/1', resposta: { corpo: ativoDetalhe() } },
    { caminho: '/api/ativos/1/agregados', resposta: { corpo: agregados() } },
    { caminho: '/api/eventos', resposta: { corpo: pagina([evento()]) } },
    { metodo: 'POST', caminho: '/api/ativos/1/ia/analise', resposta: analise },
    ...extra,
  ];
}

const pedidosAnalise = (c: Chamada[]) =>
  c.filter((x) => x.url.pathname === '/api/ativos/1/ia/analise');
const pedidosHistorico = (c: Chamada[]) =>
  c.filter((x) => x.url.pathname === '/api/ativos/1/ia/relatorios');

const painel = () => screen.getByRole('region', { name: 'Análise IA' }) as HTMLElement;

/** Botão "Analisar com IA" depois de o estado da IA ter carregado. */
async function botaoAnalisar(): Promise<HTMLElement> {
  await screen.findByText('Chamadas hoje');
  return screen.getByRole('button', { name: 'Analisar com IA' });
}

async function analisar() {
  fireEvent.click(await botaoAnalisar());
  fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }));
}

describe('Análise IA', () => {
  it('não chama ao montar, nem com eventos SSE, nem ao focar a janela', async () => {
    const chamadas = mockFetch(rotas({ corpo: respostaAnaliseIa() }));
    renderizarApp('/ativos/1');
    expect(await botaoAnalisar()).toBeEnabled();
    const es = EventSourceFalso.ultima();
    act(() => {
      es.abrir();
      es.emitir('evento', evento({ id: 200 }), '200');
      es.falhar();
      es.abrir();
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(pedidosAnalise(chamadas)).toHaveLength(0);
    expect(pedidosHistorico(chamadas)).toHaveLength(0);
  });

  it('mostra estado: modelo, preços e uso de hoje', async () => {
    mockFetch(rotas({ corpo: respostaAnaliseIa() }));
    renderizarApp('/ativos/1');
    await botaoAnalisar();
    const texto = n(painel().textContent);
    expect(texto).toContain('gpt-6.1-sol');
    expect(texto).toContain('2,00 US$ / 10,00 US$');
    expect(texto).toContain('2 / 10');
    expect(texto).toContain('12 000 / 100 000');
    expect(texto).toContain('0,050 US$');
  });

  it('cancelar a confirmação não chama; confirmar chama uma vez', async () => {
    const chamadas = mockFetch(rotas({ corpo: respostaAnaliseIa() }));
    renderizarApp('/ativos/1');
    fireEvent.click(await botaoAnalisar());
    const dialogo = screen.getByRole('alertdialog');
    expect(n(dialogo.textContent)).toContain('Poderá custar ~0,042 US$');
    expect(n(dialogo.textContent)).toContain('gpt-6.1-sol');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(pedidosAnalise(chamadas)).toHaveLength(0);

    await analisar();
    await waitFor(() => expect(pedidosAnalise(chamadas)).toHaveLength(1));
    expect(pedidosAnalise(chamadas)[0]?.corpo).toEqual({});
  });

  it('renderiza um relatório completo', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    mockFetch(rotas({ corpo: respostaAnaliseIa() }));
    renderizarApp('/ativos/1');
    await analisar();
    const rel = (await screen.findByRole('article', { name: /Relatório IA de/ })) as HTMLElement;
    const texto = n(rel.textContent);
    expect(texto).toContain('As baleias seguidas mantêm exposição líquida comprada.');
    expect(rel.querySelector('[data-vies="alta"]')?.textContent).toContain('Viés: Alta');
    const meter = within(rel).getByRole('meter', { name: 'Confiança do modelo' });
    expect(meter).toHaveAttribute('aria-valuenow', '65');
    expect(texto).toContain('Confiança: 65 %');
    expect(texto).toContain('Moderado: Duas de três carteiras em long.');
    expect(texto).toContain('Funding elevado');
    // Níveis-chave ordenados por preço (desc.) com distância ao preço atual (100 000).
    const niveis = within(within(rel).getByRole('list', { name: 'Níveis-chave por preço' }))
      .getAllByRole('listitem')
      .map((li) => n(li.textContent));
    expect(niveis[0]).toContain('110 000,00 (+10 %)');
    expect(niveis[1]).toContain('90 000,00 (−10 %)');
    expect(texto).toContain('Continuação · 55 %');
    expect(texto).toContain('Gatilho: Fecho acima de 102 000');
    // Cenário hipotético rotulado.
    const hip = within(rel).getByRole('region', {
      name: 'Cenário hipotético — não é uma recomendação',
    });
    const th = n(hip.textContent);
    expect(th).toContain('Long');
    expect(th).toContain('100 000,00');
    expect(th).toContain('95 000,00 (−5 %)');
    expect(th).toContain('110 000,00 (+10 %)');
    expect(th).toContain('Alinhado com a média de entrada');
    fireEvent.click(
      within(hip).getByRole('button', { name: 'Comparar com a Sugestão proporcional' }),
    );
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('painel-sugestao');
    // Avisos, aviso legal e metadados.
    expect(texto).toContain('não constitui aconselhamento financeiro; a decisão é sempre sua');
    expect(texto).toContain('Informação para apoio à decisão.');
    expect(texto).toContain('5 400 / 1 850');
    expect(texto).toContain('0,029 US$');
    expect(texto).toContain('17/11/2026, 12:00:00');
    expect(texto).toContain('Nova chamada');
    expect(screen.queryByRole('button', { name: 'Forçar nova análise' })).not.toBeInTheDocument();
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  it('relatório sem cenário de entrada, sem riscos/níveis/cenários e sem preço', async () => {
    const base = relatorioIaDto();
    mockFetch(
      rotas({
        corpo: respostaAnaliseIa({
          relatorio: relatorioIaDto({
            custoEstimadoUsd: null,
            relatorio: {
              ...base.relatorio,
              vies: 'misto',
              riscos: [],
              niveis_chave: [],
              cenarios: [],
              cenario_entrada_sugerido: null,
            },
          }),
        }),
      }),
    );
    renderizarApp('/ativos/1');
    await analisar();
    const rel = (await screen.findByRole('article', { name: /Relatório IA de/ })) as HTMLElement;
    const texto = n(rel.textContent);
    expect(texto).toContain('Viés: Misto');
    expect(texto).toContain('O modelo não indicou um cenário de entrada.');
    expect(texto).toContain('Sem riscos indicados.');
    expect(texto).toContain('Sem níveis indicados.');
    expect(texto).toContain('Sem cenários indicados.');
    expect(texto).toContain('por estimar');
  });

  it('da cache: mostra a origem e "Forçar nova análise" envia forcar: true', async () => {
    const chamadas = mockFetch(
      rotas({ corpo: respostaAnaliseIa({ daCache: true, custoEstimadoUsd: 0 }) }),
    );
    renderizarApp('/ativos/1');
    await analisar();
    expect(await screen.findByText('Da cache (sem nova chamada nem custo)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forçar nova análise' }));
    expect(n(screen.getByRole('alertdialog').textContent)).toContain('A cache é ignorada');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(pedidosAnalise(chamadas)).toHaveLength(2));
    expect(pedidosAnalise(chamadas)[1]?.corpo).toEqual({ forcar: true });
  });

  it('durante a análise: aria-busy e botão desativado', async () => {
    let resolver: (r: Response) => void = () => undefined;
    mockFetch(rotas({ corpo: respostaAnaliseIa() }));
    const fetchBase = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url.includes('/ia/analise')
          ? new Promise<Response>((r) => (resolver = r))
          : fetchBase(url, init),
      ),
    );
    renderizarApp('/ativos/1');
    await analisar();
    const botao = await screen.findByRole('button', { name: 'A analisar…' });
    expect(botao).toBeDisabled();
    expect(painel().querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText(/A analisar com IA…/)).toBeInTheDocument();
    resolver(new Response(JSON.stringify(respostaAnaliseIa())));
    expect(await screen.findByRole('article', { name: /Relatório IA de/ })).toBeInTheDocument();
    expect(painel().querySelector('[aria-busy="false"]')).not.toBeNull();
  });

  it('sem chave: instruções e botão desativado', async () => {
    const chamadas = mockFetch(
      rotas({ corpo: respostaAnaliseIa() }, [
        {
          caminho: '/api/ia/estado',
          resposta: { corpo: estadoIaBase({ configurada: false, modeloComPreco: false }) },
        },
      ]),
    );
    renderizarApp('/ativos/1');
    expect(await screen.findByText('Análise IA não configurada.')).toBeInTheDocument();
    expect(n(painel().textContent)).toContain('Defina OPENAI_API_KEY no ficheiro .env e reinicie');
    expect(n(painel().textContent)).toContain('Sem preço conhecido');
    const botao = screen.getByRole('button', { name: 'Analisar com IA' });
    expect(botao).toBeDisabled();
    fireEvent.click(botao);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(pedidosAnalise(chamadas)).toHaveLength(0);
  });

  it('modelo sem preço: confirmação indica custo por estimar', async () => {
    mockFetch(
      rotas({ corpo: respostaAnaliseIa() }, [
        {
          caminho: '/api/ia/estado',
          resposta: { corpo: estadoIaBase({ modelo: 'outro', modeloComPreco: false }) },
        },
      ]),
    );
    renderizarApp('/ativos/1');
    fireEvent.click(await botaoAnalisar());
    expect(n(screen.getByRole('alertdialog').textContent)).toContain('Custo por estimar');
  });

  it('erro no estado permite repetir', async () => {
    mockFetch(
      rotas({ corpo: respostaAnaliseIa() }, [
        { caminho: '/api/ia/estado', resposta: erroApi(500, 'ERRO_INTERNO', 'Falha no estado.') },
      ]),
    );
    renderizarApp('/ativos/1');
    expect(await screen.findByText('Falha no estado.')).toBeInTheDocument();
  });

  it('limite atingido no estado mostra aviso', async () => {
    mockFetch(
      rotas({ corpo: respostaAnaliseIa() }, [
        {
          caminho: '/api/ia/estado',
          resposta: {
            corpo: estadoIaBase({
              hoje: { ...estadoIaBase().hoje, chamadas: 10, limiteTokens: 0 },
            }),
          },
        },
      ]),
    );
    renderizarApp('/ativos/1');
    expect(await screen.findByText(/Limite diário atingido/)).toBeInTheDocument();
    expect(n(painel().textContent)).toContain('12 000 (sem limite)');
  });

  it('429: limite diário com link para Definições', async () => {
    mockFetch(
      rotas(erroApi(429, 'LIMITE_IA_ATINGIDO', 'Limite diário de chamadas IA atingido (10).')),
    );
    renderizarApp('/ativos/1');
    await analisar();
    expect(await screen.findByText('Limite diário da Análise IA atingido.')).toBeInTheDocument();
    expect(screen.getByText('Limite diário de chamadas IA atingido (10).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rever limites em Definições' })).toHaveAttribute(
      'href',
      '/definicoes',
    );
  });

  it.each([
    [502, 'IA_RECUSA', 'O modelo recusou responder a este pedido.'],
    [502, 'IA_RESPOSTA_INVALIDA', 'O modelo devolveu uma resposta inválida (não foi gravada).'],
    [503, 'IA_INDISPONIVEL', 'Serviço de IA indisponível de momento.'],
    [504, 'IA_INDISPONIVEL', 'A OpenAI demorou demasiado a responder.'],
    [503, 'IA_NAO_CONFIGURADA', 'Análise IA não configurada.'],
  ])('erro %i %s', async (estado, codigo, titulo) => {
    mockFetch(rotas(erroApi(estado, codigo, 'Mensagem do servidor.')));
    renderizarApp('/ativos/1');
    await analisar();
    const alerta = await screen.findByText('Mensagem do servidor.');
    expect(n(alerta.closest('[role="alert"]')?.textContent)).toContain(titulo);
    expect(screen.queryByRole('link', { name: 'Rever limites em Definições' })).toBeNull();
  });

  it('histórico só carrega ao abrir; abre um relatório antigo e volta à última análise', async () => {
    const antigo = relatorioIaDto({
      id: 3,
      criadoEm: '2026-11-16T09:30:00.000Z',
      modelo: 'gpt-6.1-terra',
      relatorio: { ...relatorioIaDto().relatorio, resumo: 'Relatório antigo.', vies: 'baixa' },
    });
    const chamadas = mockFetch(
      rotas({ corpo: respostaAnaliseIa() }, [
        {
          caminho: '/api/ativos/1/ia/relatorios',
          resposta: (url) =>
            url.searchParams.get('cursor') === '3'
              ? {
                  corpo: {
                    itens: [resumoRelatorioIa({ id: 2, resumo: 'Mais antigo.' })],
                    proximoCursor: null,
                  },
                }
              : {
                  corpo: {
                    itens: [
                      resumoRelatorioIa(),
                      resumoRelatorioIa({
                        id: 3,
                        criadoEm: antigo.criadoEm,
                        resumo: 'Relatório antigo.',
                        vies: 'baixa',
                        modelo: 'gpt-6.1-terra',
                      }),
                    ],
                    proximoCursor: 3,
                  },
                },
        },
        { caminho: '/api/ia/relatorios/3', resposta: { corpo: antigo } },
      ]),
    );
    renderizarApp('/ativos/1');
    await botaoAnalisar();
    expect(pedidosHistorico(chamadas)).toHaveLength(0);

    await analisar();
    await screen.findByText('Nova chamada');

    const detalhes = painel().querySelector('details')!;
    act(() => {
      detalhes.open = true;
      detalhes.dispatchEvent(new Event('toggle'));
    });
    const abrir = await screen.findByRole('button', {
      name: 'Abrir relatório de 16/11/2026, 09:30:00',
    });
    expect(pedidosHistorico(chamadas)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais relatórios' }));
    expect(await screen.findByText('Mais antigo.')).toBeInTheDocument();
    expect(pedidosHistorico(chamadas)[1]?.url.searchParams.get('cursor')).toBe('3');

    fireEvent.click(abrir);
    const rel = await screen.findByRole('article', {
      name: 'Relatório IA de 16/11/2026, 09:30:00',
    });
    expect(n(rel.textContent)).toContain('Viés: Baixa');
    expect(n(rel.textContent)).toContain('Histórico');
    expect(abrir).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Voltar à última análise' }));
    expect(await screen.findByText('Nova chamada')).toBeInTheDocument();
  });

  it('histórico vazio e erro ao abrir relatório', async () => {
    mockFetch(
      rotas({ corpo: respostaAnaliseIa() }, [
        {
          caminho: '/api/ativos/1/ia/relatorios',
          resposta: { corpo: { itens: [], proximoCursor: null } },
        },
      ]),
    );
    renderizarApp('/ativos/1');
    await botaoAnalisar();
    const detalhes = painel().querySelector('details')!;
    act(() => {
      detalhes.open = true;
      detalhes.dispatchEvent(new Event('toggle'));
    });
    expect(await screen.findByText('Ainda não há relatórios para este ativo.')).toBeInTheDocument();
  });

  it('erro no histórico e no relatório antigo', async () => {
    mockFetch(
      rotas({ corpo: respostaAnaliseIa() }, [
        {
          caminho: '/api/ativos/1/ia/relatorios',
          resposta: { corpo: { itens: [resumoRelatorioIa({ id: 4 })], proximoCursor: null } },
        },
        {
          caminho: '/api/ia/relatorios/4',
          resposta: erroApi(404, 'NAO_ENCONTRADO', 'Relatório IA 4 não encontrado(a).'),
        },
      ]),
    );
    renderizarApp('/ativos/1');
    await botaoAnalisar();
    const detalhes = painel().querySelector('details')!;
    act(() => {
      detalhes.open = true;
      detalhes.dispatchEvent(new Event('toggle'));
    });
    fireEvent.click(await screen.findByRole('button', { name: /Abrir relatório de/ }));
    expect(await screen.findByText('Relatório IA 4 não encontrado(a).')).toBeInTheDocument();
  });

  it('erro a listar o histórico', async () => {
    mockFetch(
      rotas({ corpo: respostaAnaliseIa() }, [
        {
          caminho: '/api/ativos/1/ia/relatorios',
          resposta: erroApi(500, 'ERRO_INTERNO', 'Falha no histórico.'),
        },
      ]),
    );
    renderizarApp('/ativos/1');
    await botaoAnalisar();
    const detalhes = painel().querySelector('details')!;
    act(() => {
      detalhes.open = true;
      detalhes.dispatchEvent(new Event('toggle'));
    });
    expect(await screen.findByText('Falha no histórico.')).toBeInTheDocument();
  });
});
