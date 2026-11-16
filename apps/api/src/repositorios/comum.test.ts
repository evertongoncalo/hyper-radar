import { describe, expect, it } from 'vitest';
import {
  decimalOuNuloParaNumero,
  decimalParaNumero,
  numeroOuNuloParaDecimal,
  numeroParaDecimal,
} from './comum';
import {
  ErroNaoEncontrado,
  ErroRestricaoViolada,
  ErroRunJaAberto,
  ErroTickerDuplicado,
  ErroTickerInvalido,
  ErroValorInvalido,
  traduzirErroPg,
} from './erros';

describe('conversão numérica', () => {
  it('converte numeric → number sem perda relevante', () => {
    expect(decimalParaNumero('65454.12345678')).toBe(65454.12345678);
    expect(decimalParaNumero('0.000001234567890000')).toBe(0.00000123456789);
    expect(decimalParaNumero('-12.50000000')).toBe(-12.5);
    expect(decimalOuNuloParaNumero(null)).toBeNull();
  });

  it('converte number → string aceite pelo numeric', () => {
    expect(numeroParaDecimal(0.00000123456789)).toBe('0.00000123456789');
    expect(numeroParaDecimal(1.2e-7)).toBe('1.2e-7');
    expect(numeroParaDecimal(-0)).toBe('0');
    expect(numeroOuNuloParaDecimal(null)).toBeNull();
    expect(numeroOuNuloParaDecimal(undefined)).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])('rejeita %s', (n) => {
    expect(() => numeroParaDecimal(n)).toThrow(ErroValorInvalido);
  });

  it('rejeita strings não numéricas', () => {
    expect(() => decimalParaNumero('NaN')).toThrow(ErroValorInvalido);
  });
});

describe('traduzirErroPg', () => {
  const pg = (code: string, constraint_name?: string) => ({
    message: 'falha',
    cause: { code, constraint_name },
  });

  it('mapeia constraints conhecidas para erros de domínio', () => {
    expect(traduzirErroPg(pg('23505', 'assets_ticker_unique'), { ticker: 'BTC' })).toBeInstanceOf(
      ErroTickerDuplicado,
    );
    expect(traduzirErroPg(pg('23505', 'analysis_runs_one_open_per_asset'))).toBeInstanceOf(
      ErroRunJaAberto,
    );
    expect(traduzirErroPg(pg('23514', 'assets_ticker_dex_consistent'))).toBeInstanceOf(
      ErroTickerInvalido,
    );
    expect(traduzirErroPg(pg('22003'))).toBeInstanceOf(ErroValorInvalido);
  });

  it('identifica a entidade em falta nas FKs', () => {
    const casos = [
      ['events_wallet_id_wallets_id_fk', 'Carteira'],
      ['events_asset_id_assets_id_fk', 'Ativo'],
      ['snapshots_run_id_analysis_runs_id_fk', 'Run'],
      ['orders_snapshot_id_snapshots_id_fk', 'Snapshot'],
      [undefined, 'Registo relacionado'],
    ] as const;
    for (const [restricao, entidade] of casos) {
      const erro = traduzirErroPg(pg('23503', restricao));
      expect(erro).toBeInstanceOf(ErroNaoEncontrado);
      expect((erro as Error).message).toContain(entidade);
    }
  });

  it('mantém o nome da constraint nas restantes violações', () => {
    const erro = traduzirErroPg(pg('23514', 'positions_size_positive'));
    expect(erro).toBeInstanceOf(ErroRestricaoViolada);
    expect((erro as ErroRestricaoViolada).restricao).toBe('positions_size_positive');
    expect(traduzirErroPg(pg('23505', 'outra'))).toBeInstanceOf(ErroRestricaoViolada);
  });

  it('deixa passar erros que não são de constraint', () => {
    const outro = new Error('rede');
    expect(traduzirErroPg(outro)).toBe(outro);
    expect(traduzirErroPg(pg('08006'))).toEqual(pg('08006'));
    expect(traduzirErroPg('texto')).toBe('texto');
  });
});
