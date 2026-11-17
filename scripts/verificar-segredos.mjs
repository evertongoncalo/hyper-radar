// Verificação de segredos nos ficheiros versionados (`git ls-files`), sem dependências.
// Uso: node scripts/verificar-segredos.mjs (sai com código 1 se encontrar algo).
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/** Palavras-passe Postgres aceites (só de desenvolvimento, as do docker-compose.yml). */
const SENHAS_DEV = new Set(['hyperradar']);

const REGRAS = [
  {
    id: 'openai',
    descricao: 'chave da OpenAI (sk-…)',
    padrao: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: 'chave-hex',
    descricao: 'possível chave privada (0x + 64 hex)',
    padrao: /(?<![0-9A-Za-z])0x[0-9a-fA-F]{64}(?![0-9A-Za-z])/g,
  },
  {
    id: 'pem',
    descricao: 'chave privada PEM',
    padrao: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  {
    id: 'database-url',
    descricao: 'URL Postgres com credenciais não-dev',
    padrao: /postgres(?:ql)?:\/\/([^\s:/@'"`]+):([^\s@/'"`]+)@/g,
    // Variáveis interpoladas (`${...}`) não são credenciais.
    filtro: (m) => !SENHAS_DEV.has(m[2]) && !/[${}]/.test(m[2]),
  },
];

/** Exceções explícitas para fixtures conhecidas (ficheiro + regra). */
const EXCECOES = [
  {
    ficheiro: 'apps/api/src/ia/cliente-openai.test.ts',
    regra: 'openai',
    motivo: 'chave fictícia dos testes (sk-teste-…)',
  },
  {
    ficheiro: 'apps/api/src/app.test.ts',
    regra: 'database-url',
    motivo: 'URLs fictícios na validação da configuração',
  },
  {
    ficheiro: 'apps/api/src/db/url-teste.test.ts',
    regra: 'database-url',
    motivo: 'URLs fictícios na resolução da base de testes',
  },
];

const EXTENSOES_CHAVE = new Set(['.pem', '.key', '.p12', '.pfx']);
const TAMANHO_MAXIMO = 2 * 1024 * 1024;

const raiz = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const ficheiros = execFileSync('git', ['ls-files', '-z'], { cwd: raiz, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const achados = [];
const excecoesUsadas = new Set();

const excecao = (ficheiro, regra) =>
  EXCECOES.find((e) => e.ficheiro === ficheiro && e.regra === regra);

function registar(ficheiro, linha, regra, descricao, valor) {
  const e = excecao(ficheiro, regra);
  if (e) {
    excecoesUsadas.add(e);
    return;
  }
  // Nunca mostrar o valor completo.
  const amostra = valor ? ` (${valor.slice(0, 8)}…)` : '';
  achados.push(`${ficheiro}${linha ? `:${linha}` : ''}  [${regra}] ${descricao}${amostra}`);
}

for (const ficheiro of ficheiros) {
  const nome = basename(ficheiro);
  if (/^\.env(\..+)?$/.test(nome) && nome !== '.env.example') {
    registar(ficheiro, 0, 'env', 'ficheiro .env versionado');
  }
  if (EXTENSOES_CHAVE.has(extname(nome).toLowerCase()) || /^id_(rsa|ed25519|ecdsa)$/.test(nome)) {
    registar(ficheiro, 0, 'ficheiro-chave', 'ficheiro de chave versionado');
  }

  const caminho = join(raiz, ficheiro);
  let conteudo;
  try {
    if (statSync(caminho).size > TAMANHO_MAXIMO) continue;
    conteudo = readFileSync(caminho);
  } catch {
    continue; // Removido da árvore de trabalho.
  }
  if (conteudo.subarray(0, 8000).includes(0)) continue; // Binário.
  const linhas = conteudo.toString('utf8').split('\n');

  linhas.forEach((texto, i) => {
    for (const regra of REGRAS) {
      for (const m of texto.matchAll(regra.padrao)) {
        if (regra.filtro && !regra.filtro(m)) continue;
        registar(ficheiro, i + 1, regra.id, regra.descricao, m[0]);
      }
    }
  });
}

for (const e of EXCECOES) {
  if (!excecoesUsadas.has(e)) {
    console.warn(`Aviso: exceção sem uso (remover?): ${e.ficheiro} [${e.regra}]`);
  }
}

if (achados.length > 0) {
  console.error(`Possíveis segredos em ficheiros versionados (${achados.length}):`);
  for (const a of achados) console.error(`  ${a}`);
  console.error('Remova-os ou, se forem fixtures fictícias, acrescente uma exceção explícita.');
  process.exit(1);
}
console.log(
  `Verificação de segredos: ${ficheiros.length} ficheiros versionados, nenhum segredo encontrado ` +
    `(${excecoesUsadas.size} exceções de fixtures aplicadas).`,
);
