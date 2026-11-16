import { describe, expect, it } from 'vitest';
import { resolverUrlTeste, URL_TESTE_OMISSAO } from './url-teste';

describe('resolverUrlTeste', () => {
  it('usa TEST_DATABASE_URL quando definido', () => {
    const url = 'postgres://u:s@db:5432/outra_test';
    expect(resolverUrlTeste({ TEST_DATABASE_URL: url, DATABASE_URL: 'postgres://x@y/z' })).toBe(
      url,
    );
  });

  it('deriva hyperradar_test a partir de DATABASE_URL', () => {
    const url = resolverUrlTeste({ DATABASE_URL: 'postgres://u:s@127.0.0.1:5433/hyperradar' });
    expect(url).toBe('postgres://u:s@127.0.0.1:5433/hyperradar_test');
  });

  it('recorre ao Postgres local por omissão', () => {
    expect(resolverUrlTeste({})).toBe(URL_TESTE_OMISSAO);
  });

  it('recusa bases que não terminem em _test', () => {
    expect(() => resolverUrlTeste({ TEST_DATABASE_URL: 'postgres://u:s@h/hyperradar' })).toThrow(
      /_test/,
    );
  });
});
