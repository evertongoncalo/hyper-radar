import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Garantia estática (secção 7.2): a IA só é chamada por pedido manual. Só a rota POST invoca
 * `ServicoIa.analisar`; o polling (análise/motor), o SSE, o arranque e o cliente Hyperliquid
 * nem sequer importam o módulo da IA.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function ficheiros(pasta: string): string[] {
  return readdirSync(pasta, { withFileTypes: true }).flatMap((e) => {
    const caminho = join(pasta, e.name);
    if (e.isDirectory()) return ficheiros(caminho);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !caminho.includes('__testes__')
      ? [caminho]
      : [];
  });
}

const fonte = ficheiros(SRC).map((f) => ({
  rel: relative(SRC, f).split(sep).join('/'),
  texto: readFileSync(f, 'utf8'),
}));

/** Ficheiros (fora de `ia/`) autorizados a importar o módulo da IA, e o que podem usar. */
const AUTORIZADOS: Record<string, string> = {
  'app.ts': 'constrói o serviço sem chave por omissão e regista as rotas',
  'index.ts': 'constrói o serviço com a configuração (sem chamar)',
  'config.ts': 'lê o modelo por omissão',
  'rotas/ia.ts': 'rota POST manual',
  'rotas/erros.ts': 'mapeia ErroIa para HTTP',
};

describe('a IA nunca é chamada automaticamente', () => {
  it('só os ficheiros autorizados importam o módulo da IA', () => {
    // Resolve cada import relativo e verifica se aponta para `src/ia` (ou um ficheiro lá dentro).
    const apontaParaIa = (rel: string, alvo: string) => {
      const resolvido = posix.normalize(posix.join(posix.dirname(rel), alvo));
      return resolvido === 'ia' || resolvido.startsWith('ia/');
    };
    const importam = fonte
      .filter((f) => !f.rel.startsWith('ia/'))
      .filter((f) =>
        [...f.texto.matchAll(/from '(\.{1,2}\/[^']+)'/g)].some((m) => apontaParaIa(f.rel, m[1]!)),
      )
      .map((f) => f.rel)
      .sort();
    expect(importam).toEqual(Object.keys(AUTORIZADOS).sort());
  });

  it('`analisar(` do serviço IA só é invocado pela rota POST', () => {
    const chamadas = fonte.filter((f) => /\bia\.analisar\(/.test(f.texto)).map((f) => f.rel);
    expect(chamadas).toEqual(['rotas/ia.ts']);
    const rota = fonte.find((f) => f.rel === 'rotas/ia.ts')!.texto;
    expect(rota.match(/\bia\.analisar\(/g)).toHaveLength(1);
    expect(rota).toMatch(/app\.post\('\/ativos\/:id\/ia\/analise'[\s\S]*ia\.analisar\(/);
  });

  it('o arranque não invoca a IA (só constrói o serviço)', () => {
    const indice = fonte.find((f) => f.rel === 'index.ts')!.texto;
    expect(indice).not.toMatch(/\.analisar\(|\.gerar\(/);
    const appTs = fonte.find((f) => f.rel === 'app.ts')!.texto;
    expect(appTs).not.toMatch(/\.analisar\(|\.gerar\(/);
  });
});
