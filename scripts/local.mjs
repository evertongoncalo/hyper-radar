// Arranque, paragem e estado locais do HyperRadar (um único processo: a API serve o frontend).
// Núcleo comum a scripts/start|stop.(sh|bat) e aos scripts npm start:local, stop:local e status:local.
// Uso: node scripts/local.mjs <iniciar|parar|estado>
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const DADOS = join(RAIZ, 'data');
const LOGS = join(DADOS, 'logs');
const FICHEIRO_PID = join(DADOS, 'hyperradar.pid');
// Ficheiro-sinal de encerramento limpo (ver scripts/sinal-encerramento.mjs).
const FICHEIRO_PARAGEM = join(DADOS, 'hyperradar.parar');
const HASH_BUILD = join(DADOS, 'build.hash');
// Dentro de node_modules: se a pasta for apagada, o hash desaparece com ela.
const HASH_LOCK = join(RAIZ, 'node_modules', '.hyperradar-lock.hash');
const ENTRADA_API = join(RAIZ, 'apps', 'api', 'dist', 'index.js');
const INDEX_WEB = join(RAIZ, 'apps', 'web', 'dist', 'index.html');
const PRELOAD = join(RAIZ, 'scripts', 'sinal-encerramento.mjs');
const WINDOWS = process.platform === 'win32';
const NODE_MINIMO = 22;
const ESPERA_ARRANQUE_MS = 60_000;
const ESPERA_PARAGEM_MS = 20_000;

// Código-fonte e configuração que entram no build (alterações → novo build).
const PASTAS_BUILD = ['packages/shared/src', 'apps/api/src', 'apps/web/src', 'apps/web/public'];
const FICHEIROS_BUILD = [
  'package-lock.json',
  'tsconfig.base.json',
  'packages/shared/package.json',
  'apps/api/package.json',
  'apps/api/tsconfig.json',
  'apps/api/tsdown.config.ts',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'apps/web/vite.config.ts',
  'apps/web/index.html',
];

const info = (msg) => console.log(`[HyperRadar] ${msg}`);
const aviso = (msg) => console.warn(`[HyperRadar] Aviso: ${msg}`);
function falhar(msg) {
  console.error(`[HyperRadar] Erro: ${msg}`);
  process.exit(1);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Corre um comando na raiz do projeto, com a saída no terminal; devolve o código de saída. */
function correr(comando, args) {
  const r = spawnSync(comando, args, { cwd: RAIZ, stdio: 'inherit' });
  if (r.error) return -1;
  return r.status ?? 1;
}

/** Corre o npm (no Windows é um .cmd, que o Node só executa através da shell). */
function npm(args) {
  const execpath = process.env.npm_execpath;
  if (execpath && execpath.endsWith('.js')) return correr(process.execPath, [execpath, ...args]);
  if (!WINDOWS) return correr('npm', args);
  const r = spawnSync(`npm ${args.join(' ')}`, { cwd: RAIZ, stdio: 'inherit', shell: true });
  return r.status ?? 1;
}

function verificarNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < NODE_MINIMO) {
    falhar(
      `é necessário o Node.js ${NODE_MINIMO} ou superior (encontrado ${process.version}). Instale em https://nodejs.org/`,
    );
  }
}

function verificarDocker() {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    stdio: 'pipe',
    windowsHide: true,
  });
  if (r.error)
    falhar('Docker não encontrado. Instale o Docker Desktop (ou Docker Engine + Compose).');
  if (r.status !== 0)
    falhar('o Docker não está em execução. Inicie o Docker Desktop e tente de novo.');
}

/** Cria o .env a partir do .env.example, se faltar (sem preencher chaves). */
function garantirEnv() {
  const env = join(RAIZ, '.env');
  if (existsSync(env)) return;
  const exemplo = join(RAIZ, '.env.example');
  if (!existsSync(exemplo)) falhar('falta o ficheiro .env.example.');
  copyFileSync(exemplo, env);
  aviso(
    'criado o ficheiro .env a partir do .env.example. Reveja-o; para a Análise IA defina OPENAI_API_KEY (opcional).',
  );
}

/** Variáveis efetivas: as do ambiente prevalecem sobre as do .env (como no `node --env-file`). */
function lerEnv() {
  let ficheiro = {};
  try {
    ficheiro = parseEnv(readFileSync(join(RAIZ, '.env'), 'utf8'));
  } catch {
    // Sem .env legível: usar só o ambiente.
  }
  return { ...ficheiro, ...process.env };
}

function lerPorta() {
  const porta = Number(lerEnv().PORT ?? 3000);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) falhar('PORT inválida no .env.');
  return porta;
}

const sha256 = (dados) => createHash('sha256').update(dados).digest('hex');

function lerTexto(caminho) {
  try {
    return readFileSync(caminho, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Compara o package-lock.json com o lock interno que o npm escreve em node_modules: cada pacote
 * do lock (exceto opcionais, ex.: binários de outras plataformas) tem de estar instalado na
 * mesma versão, e nada pode estar instalado fora do lock.
 */
function nodeModulesCorrespondeAoLock(lock, interno) {
  try {
    const esperado = JSON.parse(readFileSync(lock, 'utf8')).packages ?? {};
    const instalado = JSON.parse(readFileSync(interno, 'utf8')).packages ?? {};
    for (const [caminho, p] of Object.entries(esperado)) {
      if (!caminho.includes('node_modules/')) continue; // Raiz e workspaces.
      const i = instalado[caminho];
      if (!i) {
        if (p.optional) continue;
        return false;
      }
      if (i.version !== p.version) return false;
    }
    return Object.keys(instalado).every((c) => c in esperado);
  } catch {
    return false;
  }
}

/** Instala dependências com `npm ci` só se faltar node_modules ou o lock tiver mudado. */
function garantirDependencias() {
  const lock = join(RAIZ, 'package-lock.json');
  const hash = sha256(readFileSync(lock));
  const nodeModules = join(RAIZ, 'node_modules');
  if (existsSync(nodeModules)) {
    if (lerTexto(HASH_LOCK) === hash) return;
    // Sem hash guardado (ou lock alterado): se o lock interno do npm já corresponder ao
    // package-lock.json, node_modules está atualizado e evita-se um `npm ci` inútil.
    if (nodeModulesCorrespondeAoLock(lock, join(nodeModules, '.package-lock.json'))) {
      writeFileSync(HASH_LOCK, hash);
      return;
    }
  }
  info('A instalar dependências (npm ci)...');
  if (npm(['ci']) !== 0) falhar('npm ci falhou.');
  writeFileSync(HASH_LOCK, hash);
}

function* ficheirosDe(pasta) {
  let entradas;
  try {
    entradas = readdirSync(pasta, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entradas.sort((a, b) => a.name.localeCompare(b.name))) {
    const caminho = join(pasta, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist', 'coverage'].includes(e.name)) yield* ficheirosDe(caminho);
    } else if (e.isFile() && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) {
      yield caminho;
    }
  }
}

/** Hash do conteúdo de tudo o que entra no build (caminho + conteúdo, ordem determinística). */
function hashCodigo() {
  const h = createHash('sha256');
  const ficheiros = [
    ...FICHEIROS_BUILD.map((f) => join(RAIZ, f)).filter((f) => existsSync(f)),
    ...PASTAS_BUILD.flatMap((p) => [...ficheirosDe(join(RAIZ, p))]),
  ];
  for (const f of ficheiros) {
    h.update(relative(RAIZ, f).replaceAll('\\', '/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Faz o build só se o código mudou desde o último build (ou se faltar algum artefacto). */
function garantirBuild() {
  const hash = hashCodigo();
  if (existsSync(ENTRADA_API) && existsSync(INDEX_WEB) && lerTexto(HASH_BUILD) === hash) {
    info('Build atualizado (código sem alterações).');
    return;
  }
  info('A fazer o build (API + frontend)...');
  if (npm(['run', 'build']) !== 0) falhar('o build falhou.');
  if (!existsSync(ENTRADA_API) || !existsSync(INDEX_WEB)) {
    falhar('o build terminou mas faltam apps/api/dist/index.js ou apps/web/dist/index.html.');
  }
  mkdirSync(DADOS, { recursive: true });
  writeFileSync(HASH_BUILD, hash);
}

function processoVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Confirma que o PID é um processo Node (protege contra reutilização de PIDs). */
function eProcessoNode(pid) {
  const r = WINDOWS
    ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    : spawnSync('ps', ['-p', String(pid), '-o', 'comm=']);
  if (r.error || r.status !== 0) return true; // Sem forma de confirmar: confiar no PID.
  return /node/i.test(String(r.stdout));
}

/** Processo arrancado por estes scripts e ainda vivo, ou null (limpa um ficheiro PID obsoleto). */
function processoAtual() {
  let dados;
  try {
    dados = JSON.parse(readFileSync(FICHEIRO_PID, 'utf8'));
  } catch {
    return null;
  }
  if (Number.isInteger(dados?.pid) && processoVivo(dados.pid) && eProcessoNode(dados.pid)) {
    return dados;
  }
  rmSync(FICHEIRO_PID, { force: true });
  return null;
}

/** GET /health: { status, corpo } ou null se nada responder na porta. */
async function saude(porta) {
  try {
    const r = await fetch(`http://127.0.0.1:${porta}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return { status: r.status, corpo: await r.text() };
  } catch {
    return null;
  }
}

function abrirBrowser(url) {
  if (process.env.HYPERRADAR_NO_BROWSER === '1') {
    info(`Browser não aberto (HYPERRADAR_NO_BROWSER=1). Abra ${url}`);
    return;
  }
  const [comando, args] = WINDOWS
    ? ['explorer.exe', [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const filho = spawn(comando, args, { detached: true, stdio: 'ignore', windowsHide: true });
  filho.on('error', () => info(`Não foi possível abrir o browser. Abra ${url}`));
  filho.unref();
}

function ultimasLinhas(ficheiro, n = 20) {
  try {
    return readFileSync(ficheiro, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

function dataLocal() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dockerCompose(args) {
  return correr('docker', ['compose', ...args]);
}

async function iniciar() {
  verificarNode();
  garantirEnv();
  const porta = lerPorta();
  const url = `http://127.0.0.1:${porta}`;

  const atual = processoAtual();
  if (atual) {
    const urlAtual = `http://127.0.0.1:${atual.porta}`;
    const s = await saude(atual.porta);
    if (s?.status === 200) {
      info(`Já está a correr (PID ${atual.pid}) em ${urlAtual}.`);
      abrirBrowser(urlAtual);
      return;
    }
    falhar(
      `o processo ${atual.pid} está a correr mas /health não responde 200 (${s ? s.status : 'sem resposta'}). ` +
        `Veja ${atual.log ?? LOGS} ou execute npm run stop:local.`,
    );
  }

  const ocupada = await saude(porta);
  if (ocupada) {
    falhar(
      `a porta ${porta} já está em uso por outro processo (não arrancado por estes scripts, ` +
        'ex.: npm run dev). Pare-o ou altere PORT no .env.',
    );
  }

  verificarDocker();
  garantirDependencias();

  info('A arrancar o Postgres (docker compose up -d --wait)...');
  if (dockerCompose(['up', '-d', '--wait']) !== 0) falhar('não foi possível arrancar o Postgres.');

  info('A aplicar as migrações...');
  if (npm(['run', 'db:migrate']) !== 0) falhar('as migrações falharam.');

  garantirBuild();

  mkdirSync(LOGS, { recursive: true });
  const log = join(LOGS, `hyperradar-${dataLocal()}.log`);
  rmSync(FICHEIRO_PARAGEM, { force: true });
  const fd = openSync(log, 'a');
  const filho = spawn(
    process.execPath,
    [`--env-file=${join(RAIZ, '.env')}`, '--import', pathToFileURL(PRELOAD).href, ENTRADA_API],
    {
      cwd: RAIZ,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, HYPERRADAR_FICHEIRO_PARAGEM: FICHEIRO_PARAGEM },
    },
  );
  closeSync(fd);
  filho.unref();
  const pid = filho.pid;
  if (!pid) falhar('não foi possível arrancar o processo da API.');
  writeFileSync(
    FICHEIRO_PID,
    JSON.stringify({ pid, porta, log, inicio: new Date().toISOString() }, null, 2),
  );
  info(`Processo arrancado (PID ${pid}); a aguardar o /health...`);

  const limite = Date.now() + ESPERA_ARRANQUE_MS;
  for (;;) {
    const s = await saude(porta);
    if (s?.status === 200) break;
    if (!processoVivo(pid)) {
      rmSync(FICHEIRO_PID, { force: true });
      console.error(ultimasLinhas(log));
      falhar(`o servidor terminou durante o arranque. Log: ${log}`);
    }
    if (Date.now() > limite) {
      falhar(`o /health não respondeu 200 em ${ESPERA_ARRANQUE_MS / 1000} s. Log: ${log}`);
    }
    await esperar(500);
  }

  info(`Pronto em ${url} (PID ${pid}).`);
  info(`Logs: ${log}`);
  info('Para parar: npm run stop:local (ou scripts/stop.bat / scripts/stop.sh).');
  abrirBrowser(url);
}

async function pararProcesso(atual) {
  info(`A parar o processo ${atual.pid}...`);
  if (WINDOWS) {
    // No Windows não há SIGINT/SIGTERM entre processos (process.kill termina à força):
    // o pedido de encerramento limpo é feito por ficheiro-sinal, vigiado dentro da API.
    writeFileSync(FICHEIRO_PARAGEM, String(atual.pid));
  } else {
    try {
      process.kill(atual.pid, 'SIGTERM');
    } catch {
      // Já terminou.
    }
  }
  const limite = Date.now() + ESPERA_PARAGEM_MS;
  while (processoVivo(atual.pid) && Date.now() < limite) await esperar(250);
  if (processoVivo(atual.pid)) {
    aviso(`o processo não terminou em ${ESPERA_PARAGEM_MS / 1000} s; a forçar a paragem.`);
    if (WINDOWS) {
      spawnSync('taskkill', ['/PID', String(atual.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(atual.pid, 'SIGKILL');
      } catch {
        // Já terminou.
      }
    }
  } else {
    info('Servidor encerrado de forma limpa.');
  }
  rmSync(FICHEIRO_PID, { force: true });
  rmSync(FICHEIRO_PARAGEM, { force: true });
}

async function parar() {
  const atual = processoAtual();
  if (atual) {
    await pararProcesso(atual);
  } else {
    info('O servidor não está a correr (sem processo arrancado por estes scripts).');
    const porta = lerPorta();
    if (await saude(porta)) {
      aviso(
        `há outro servidor na porta ${porta} que não foi arrancado por estes scripts; não foi parado.`,
      );
    }
  }

  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    stdio: 'pipe',
    windowsHide: true,
  });
  if (docker.error || docker.status !== 0) {
    aviso('Docker indisponível; o Postgres não foi parado.');
    return;
  }
  // `stop` (nunca `down -v`): o volume com os dados é sempre preservado.
  info('A parar o Postgres (docker compose stop; os dados são mantidos)...');
  if (dockerCompose(['stop']) !== 0) falhar('não foi possível parar o Postgres.');
  info('Parado.');
}

async function estado() {
  const atual = processoAtual();
  const porta = atual?.porta ?? lerPorta();
  if (atual) info(`A correr: PID ${atual.pid}, porta ${porta}, desde ${atual.inicio}.`);
  else info(`Parado (sem processo arrancado por estes scripts). Porta configurada: ${porta}.`);
  if (atual?.log) info(`Logs: ${atual.log}`);
  const s = await saude(porta);
  info(
    s
      ? `GET http://127.0.0.1:${porta}/health → ${s.status} ${s.corpo}`
      : `GET http://127.0.0.1:${porta}/health → sem resposta`,
  );
  const pg = spawnSync('docker', ['compose', 'ps', 'postgres', '--format', '{{.Status}}'], {
    cwd: RAIZ,
    stdio: 'pipe',
    windowsHide: true,
  });
  const estadoPg = pg.status === 0 ? String(pg.stdout).trim() : '';
  info(`Postgres: ${estadoPg || 'parado ou indisponível'}`);
}

const acoes = { iniciar, parar, estado };
const acao = acoes[process.argv[2]];
if (!acao) falhar('uso: node scripts/local.mjs <iniciar|parar|estado>');
await acao();
