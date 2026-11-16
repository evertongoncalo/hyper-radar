import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('mostra o título HyperRadar', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'HyperRadar' })).toBeInTheDocument();
  });

  it('mostra o aviso de que não é aconselhamento financeiro', () => {
    render(<App />);
    expect(
      screen.getByText('Informação para apoio à decisão. Não constitui aconselhamento financeiro.'),
    ).toBeInTheDocument();
  });
});
