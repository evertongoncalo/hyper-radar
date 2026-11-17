import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App, AVISO_LEGAL } from './App';
import { mockFetch, renderizarApp, rotasBase } from './test/utilitarios';

describe('App', () => {
  it('mostra o título HyperRadar', () => {
    mockFetch(rotasBase());
    render(<App />);
    expect(screen.getByRole('heading', { name: 'HyperRadar' })).toBeInTheDocument();
  });

  it('mostra o aviso de que não é aconselhamento financeiro', () => {
    mockFetch(rotasBase());
    render(<App />);
    expect(
      screen.getByText('Informação para apoio à decisão. Não constitui aconselhamento financeiro.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(AVISO_LEGAL);
  });

  it('navegação principal e contagem de não lidos', async () => {
    mockFetch([
      ...rotasBase(),
      {
        caminho: '/api/eventos/nao-lidos/contagem',
        resposta: { corpo: { total: 4, porAtivo: [] } },
      },
    ]);
    renderizarApp('/');
    const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
    expect(nav).toBeInTheDocument();
    expect(await screen.findByText('não lidos', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Definições/ }));
    expect(
      await screen.findByRole('heading', { name: 'Definições', level: 2 }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Carteiras/ }));
    expect(await screen.findByRole('heading', { name: 'Carteiras', level: 2 })).toBeInTheDocument();
  });

  it('rota desconhecida', () => {
    mockFetch(rotasBase());
    renderizarApp('/nada');
    expect(screen.getByText('Página não encontrada')).toBeInTheDocument();
  });
});
