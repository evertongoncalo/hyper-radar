import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { obterPreferencias } from '../lib/preferencias';
import { definicoes } from '../test/dados';
import { erroApi, mockFetch, renderizarApp, rotasBase } from '../test/utilitarios';
import { lerNumero, validarDefinicoes } from './Definicoes';

const valores = {
  capitalUsd: '1000',
  alavancagemMaxima: '5',
  riscoPorOperacaoPct: '1',
  intervaloRecolhaSegundos: '60',
  limiteDiarioChamadasIa: '10',
  limiteDiarioTokensIa: '100000',
};

describe('Definições', () => {
  it('carregamento e erro', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    const r = renderizarApp('/definicoes');
    expect(screen.getByText('A carregar definições…')).toBeInTheDocument();
    r.unmount();
    mockFetch([
      ...rotasBase(),
      { caminho: '/api/definicoes', resposta: erroApi(500, 'ERRO_INTERNO', 'Erro interno.') },
    ]);
    renderizarApp('/definicoes');
    expect(await screen.findByText('Erro interno.')).toBeInTheDocument();
  });

  it('mostra os valores atuais e guarda só os campos alterados', async () => {
    const chamadas = mockFetch([
      ...rotasBase(),
      {
        metodo: 'PATCH',
        caminho: '/api/definicoes',
        resposta: {
          corpo: definicoes({ capitalUsd: 2500.5, atualizadoEm: '2026-11-17T13:00:00.000Z' }),
        },
      },
    ]);
    renderizarApp('/definicoes');
    const capital = await screen.findByLabelText('Capital (USD)');
    expect(capital).toHaveValue('1000');
    fireEvent.change(capital, { target: { value: '2 500,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar definições' }));
    expect(await screen.findByText('Definições guardadas.')).toBeInTheDocument();
    expect(chamadas.find((c) => c.metodo === 'PATCH')?.corpo).toEqual({ capitalUsd: 2500.5 });
    // Sem mais alterações.
    fireEvent.click(screen.getByRole('button', { name: 'Guardar definições' }));
    expect(await screen.findByText('Sem alterações para guardar.')).toBeInTheDocument();
  });

  it('validação no cliente com o schema partilhado (intervalo ≥ 15 s)', async () => {
    const chamadas = mockFetch(rotasBase());
    renderizarApp('/definicoes');
    fireEvent.change(await screen.findByLabelText('Intervalo de recolha (s)'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('Risco por operação (%)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar definições' }));
    expect(await screen.findByText('Intervalo de recolha: mínimo 15.')).toBeInTheDocument();
    expect(screen.getByText('Risco por operação: tem de ser um número.')).toBeInTheDocument();
    expect(screen.getByLabelText('Intervalo de recolha (s)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(chamadas.some((c) => c.metodo === 'PATCH')).toBe(false);
  });

  it('erros de validação da API aparecem no campo', async () => {
    mockFetch([
      ...rotasBase(),
      {
        metodo: 'PATCH',
        caminho: '/api/definicoes',
        resposta: erroApi(
          400,
          'VALIDACAO',
          'Pedido inválido (body.alavancagemMaxima): máximo 50.',
          [{ caminho: 'body.alavancagemMaxima', mensagem: 'Alavancagem máxima: máximo 50.' }],
        ),
      },
    ]);
    renderizarApp('/definicoes');
    fireEvent.change(await screen.findByLabelText('Alavancagem máxima'), {
      target: { value: '60' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar definições' }));
    expect(await screen.findByText('Alavancagem máxima: máximo 50.')).toBeInTheDocument();
    expect(screen.getByText(/Pedido inválido \(body.alavancagemMaxima\)/)).toBeInTheDocument();
  });

  it('preferências de notificação e som (localStorage) e pedido de permissão por botão', async () => {
    const pedir = vi.fn(async () => 'granted' as NotificationPermission);
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: pedir });
    mockFetch(rotasBase());
    renderizarApp('/definicoes');
    expect(
      screen.getByText(/Sem esta aba aberta não há notificações \(não é usado Web Push\)/),
    ).toBeInTheDocument();
    expect(screen.getByText('Ainda não pedidas')).toBeInTheDocument();
    expect(pedir).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ativar notificações do sistema' }));
    });
    expect(pedir).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Permitidas')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Tocar som nos avisos dentro da app'));
    fireEvent.click(screen.getByLabelText(/Mostrar notificações do sistema/));
    await waitFor(() => expect(obterPreferencias()).toEqual({ notificacoes: false, som: false }));
    expect(JSON.parse(localStorage.getItem('hyperradar.preferencias')!)).toEqual({
      notificacoes: false,
      som: false,
    });
  });

  it('browser sem notificações', () => {
    mockFetch(rotasBase());
    renderizarApp('/definicoes');
    expect(screen.getByText(/Não suportadas por este browser/)).toBeInTheDocument();
  });

  it('lerNumero e validarDefinicoes', () => {
    expect(lerNumero(' 1 234,5 ')).toBe(1234.5);
    expect(lerNumero('')).toBeNaN();
    expect(validarDefinicoes(valores, definicoes())).toEqual({ ok: true, alteracoes: {} });
    expect(validarDefinicoes({ ...valores, alavancagemMaxima: '2.5' }, definicoes())).toEqual({
      ok: false,
      erros: { alavancagemMaxima: 'Alavancagem máxima: tem de ser um número inteiro.' },
    });
  });
});
