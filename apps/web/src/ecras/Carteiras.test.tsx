import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { carteiraGlobal, E1, E2 } from '../test/dados';
import { erroApi, mockFetch, renderizarApp, rotasBase, type RotaFalsa } from '../test/utilitarios';
import { lerFicheiroImportacao } from './Carteiras';

const EXPORTACAO = {
  versao: 1,
  exportadoEm: '2026-07-10T23:30:00.000Z',
  carteiras: [{ endereco: E1, alias: 'Baleia A', entidade: null }],
  ativos: [{ ticker: 'BTC', carteiras: [E1] }],
};

function rotas(extra: RotaFalsa[] = []): RotaFalsa[] {
  return [
    ...rotasBase(),
    {
      caminho: '/api/carteiras',
      resposta: {
        corpo: [
          carteiraGlobal(),
          carteiraGlobal({ id: 11, endereco: E2, alias: null, entidade: null, ativos: [] }),
        ],
      },
    },
    ...extra,
  ];
}

const ficheiro = (conteudo: string) =>
  new File([conteudo], 'backup.json', { type: 'application/json' });

describe('Carteiras', () => {
  it('carregamento, vazio e erro', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    const { unmount } = renderizarApp('/carteiras');
    expect(screen.getByText('A carregar carteiras…')).toBeInTheDocument();
    unmount();

    mockFetch(rotasBase());
    const r2 = renderizarApp('/carteiras');
    expect(await screen.findByText(/Ainda não há carteiras/)).toBeInTheDocument();
    r2.unmount();

    mockFetch([
      ...rotasBase(),
      { caminho: '/api/carteiras', resposta: erroApi(500, 'ERRO_INTERNO', 'Erro interno.') },
    ]);
    renderizarApp('/carteiras');
    expect(await screen.findByText('Erro interno.')).toBeInTheDocument();
  });

  it('lista com ativos associados', async () => {
    mockFetch(rotas());
    renderizarApp('/carteiras');
    const linha = (await screen.findByText('Baleia A')).closest('tr')!;
    expect(within(linha).getByRole('link', { name: 'BTC' })).toHaveAttribute('href', '/ativos/1');
    expect(within(linha).getByText('Fundo X')).toBeInTheDocument();
    expect(screen.getByText('Nenhum')).toBeInTheDocument();
  });

  it('editar alias e entidade inline', async () => {
    const chamadas = mockFetch(
      rotas([
        {
          metodo: 'PATCH',
          caminho: '/api/carteiras/10',
          resposta: { corpo: { ...carteiraGlobal({ alias: 'Novo' }), ativos: undefined } },
        },
      ]),
    );
    renderizarApp('/carteiras');
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Baleia A' }));
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: '  Novo ' } });
    fireEvent.change(screen.getByLabelText('Entidade'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PATCH')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PATCH')?.corpo).toEqual({
      alias: 'Novo',
      entidade: null,
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Guardar' })).not.toBeInTheDocument(),
    );
  });

  it('validação local do alias e cancelar', async () => {
    mockFetch(rotas());
    renderizarApp('/carteiras');
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Baleia A' }));
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: 'x'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByText('Máximo de 100 caracteres.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByLabelText('Alias')).not.toBeInTheDocument();
  });

  it('apagar com confirmação (avisa que reinicia análises)', async () => {
    const chamadas = mockFetch(
      rotas([{ metodo: 'DELETE', caminho: '/api/carteiras/10', resposta: { estado: 204 } }]),
    );
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderizarApp('/carteiras');
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar Baleia A' }));
    expect(confirmar.mock.calls[0]?.[0]).toMatch(/reiniciadas/);
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'DELETE')).toBe(true));
  });

  it('erro ao apagar', async () => {
    mockFetch(
      rotas([
        {
          metodo: 'DELETE',
          caminho: '/api/carteiras/11',
          resposta: erroApi(404, 'NAO_ENCONTRADO', 'Carteira 11 não encontrado(a).'),
        },
      ]),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderizarApp('/carteiras');
    fireEvent.click(await screen.findByRole('button', { name: 'Apagar 0xbbbb…bbbb' }));
    expect(await screen.findByText('Carteira 11 não encontrado(a).')).toBeInTheDocument();
  });

  it('exportar descarrega um JSON com a data de Lisboa no nome', async () => {
    mockFetch(rotas([{ caminho: '/api/exportacao', resposta: { corpo: EXPORTACAO } }]));
    const criar = vi.fn<(b: Blob) => string>(() => 'blob:falso');
    const revogar = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: criar, revokeObjectURL: revogar }));
    let nome = '';
    const clicar = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      nome = this.download;
    });
    renderizarApp('/carteiras');
    fireEvent.click(await screen.findByRole('button', { name: 'Exportar JSON' }));
    await waitFor(() => expect(clicar).toHaveBeenCalled());
    expect(nome).toBe('hyperradar-2026-07-11.json');
    expect(JSON.parse(await criar.mock.calls[0]![0].text())).toEqual(EXPORTACAO);
    expect(revogar).toHaveBeenCalledWith('blob:falso');
  });

  it('erro ao exportar', async () => {
    mockFetch(
      rotas([
        {
          caminho: '/api/exportacao',
          resposta: erroApi(503, 'SERVICO_INDISPONIVEL', 'Indisponível.'),
        },
      ]),
    );
    renderizarApp('/carteiras');
    fireEvent.click(await screen.findByRole('button', { name: 'Exportar JSON' }));
    expect(await screen.findByText('Indisponível.')).toBeInTheDocument();
  });

  it('importar: valida o ficheiro e mostra o resumo', async () => {
    const chamadas = mockFetch(
      rotas([
        {
          metodo: 'POST',
          caminho: '/api/importacao',
          resposta: {
            corpo: {
              ativosCriados: 1,
              carteirasCriadas: 1,
              carteirasAtualizadas: 0,
              associacoesCriadas: 1,
              definicoesAtualizadas: false,
              analisesReiniciadas: [1],
            },
          },
        },
      ]),
    );
    renderizarApp('/carteiras');
    const entrada = await screen.findByLabelText('Ficheiro JSON a importar');
    fireEvent.change(entrada, { target: { files: [ficheiro(JSON.stringify(EXPORTACAO))] } });
    expect(await screen.findByText('Importação concluída:')).toBeInTheDocument();
    expect(screen.getByText('1 ativo(s) criado(s)')).toBeInTheDocument();
    expect(screen.getByText('1 análise(s) reiniciada(s)')).toBeInTheDocument();
    expect(screen.getByText('Definições mantidas')).toBeInTheDocument();
    expect(chamadas.find((c) => c.metodo === 'POST')?.corpo).toEqual(EXPORTACAO);
  });

  it('importar: ficheiro inválido é rejeitado sem chamar a API', async () => {
    const chamadas = mockFetch(rotas());
    renderizarApp('/carteiras');
    const entrada = await screen.findByLabelText('Ficheiro JSON a importar');
    fireEvent.change(entrada, {
      target: {
        files: [
          ficheiro(JSON.stringify({ ...EXPORTACAO, ativos: [{ ticker: 'BTC', carteiras: [E2] }] })),
        ],
      },
    });
    expect(await screen.findByText('Ficheiro rejeitado:')).toBeInTheDocument();
    expect(
      screen.getByText(/ativos\.0\.carteiras\.0: A carteira .* não consta/),
    ).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST')).toBe(false);
  });

  it('importar: erro da API', async () => {
    mockFetch(
      rotas([
        {
          metodo: 'POST',
          caminho: '/api/importacao',
          resposta: erroApi(413, 'CORPO_DEMASIADO_GRANDE', 'Ficheiro demasiado grande.'),
        },
      ]),
    );
    renderizarApp('/carteiras');
    fireEvent.change(await screen.findByLabelText('Ficheiro JSON a importar'), {
      target: { files: [ficheiro(JSON.stringify(EXPORTACAO))] },
    });
    expect(await screen.findByText('Ficheiro demasiado grande.')).toBeInTheDocument();
  });

  it('lerFicheiroImportacao: JSON inválido e versão errada', async () => {
    await expect(lerFicheiroImportacao(ficheiro('{'))).resolves.toEqual({
      ok: false,
      problemas: ['O ficheiro não é JSON válido.'],
    });
    const r = await lerFicheiroImportacao(ficheiro(JSON.stringify({ ...EXPORTACAO, versao: 2 })));
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.problemas).toContain('versao: Versão do ficheiro não suportada.');
  });
});
