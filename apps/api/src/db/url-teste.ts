/** Base usada pelos testes de integração quando nada é configurado (Postgres do docker-compose). */
export const URL_TESTE_OMISSAO = 'postgres://hyperradar:hyperradar@127.0.0.1:5432/hyperradar_test';

/**
 * Resolve o URL da base de testes de integração:
 * `TEST_DATABASE_URL` → `DATABASE_URL` com a base trocada por `hyperradar_test` → omissão local.
 * Por segurança, recusa qualquer base cujo nome não termine em `_test`
 * (nunca se toca na base de desenvolvimento).
 */
export function resolverUrlTeste(env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  if (env.TEST_DATABASE_URL) {
    url = new URL(env.TEST_DATABASE_URL);
  } else if (env.DATABASE_URL) {
    url = new URL(env.DATABASE_URL);
    url.pathname = '/hyperradar_test';
  } else {
    url = new URL(URL_TESTE_OMISSAO);
  }

  const nomeBase = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!nomeBase.endsWith('_test')) {
    throw new Error(`A base de testes tem de terminar em "_test" (recebido: "${nomeBase}").`);
  }
  return url.toString();
}
