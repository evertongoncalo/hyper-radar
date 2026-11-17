import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import {
  CHAVE_OPENAI_FALSA,
  PORTA_API,
  PORTA_FALSO,
  RAIZ,
  URL_API,
  URL_BD_E2E,
  URL_FALSO,
} from './configuracao';
import { arrancarServidorFalso, type ServidorFalso } from './servidor-falso';

/*
 * Setup global dos E2E: servidor falso (Hyperliquid + OpenAI) → base `*_e2e` criada de raiz e
 * migrada → API compilada (que também serve o frontend) a apontar para o servidor falso.
 * Devolve o teardown: pára a API e o servidor falso e apaga a base E2E.
 */

const ENTRADA_API = join(RAIZ, 'apps', 'api', 'dist', 'index.js');
const INDEX_WEB = join(RAIZ, 'apps', 'web', 'dist', 'index.html');
const MIGRACAO = join(RAIZ, 'apps', 'api', 'src', 'db', 'migrate.ts');
const ESPERA_ARRANQUE_MS = 30_000;

/** Nome da base E2E, validado (só `[a-z0-9_]` e sufixo `_e2e`). */
function nomeBaseE2e(): string {
  const nome = decodeURIComponent(new URL(URL_BD_E2E).pathname.replace(/^\//, ''));
  if (!/^[a-z0-9_]+_e2e$/.test(nome)) {
    throw new Error(`A base dos E2E tem de terminar em "_e2e" (recebido: "${nome}").`);
  }
  return nome;
}

/** Corre SQL de administração na base de manutenção `postgres` (não na base E2E). */
async function administrar(sql: string): Promise<void> {
  const url = new URL(URL_BD_E2E);
  url.pathname = '/postgres';
  const ligacao = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await ligacao.unsafe(sql);
  } finally {
    await ligacao.end({ timeout: 5 });
  }
}

const apagarBase = (nome: string) => administrar(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`);

function migrar(): void {
  const r = spawnSync(process.execPath, ['--import', 'tsx', MIGRACAO], {
    cwd: RAIZ,
    env: { ...process.env, DATABASE_URL: URL_BD_E2E },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`As migrações da base E2E falharam:\n${r.stdout}\n${r.stderr}`);
  }
}

/** Ambiente da API: sem herdar `.env` nem chaves/URLs reais do ambiente. */
function ambienteApi(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(OPENAI_|HYPERLIQUID_|DATABASE_URL|TEST_DATABASE_URL|PORT$|ALLOWED_ORIGINS)/.test(k)) {
      env[k] = v;
    }
  }
  return {
    ...env,
    NODE_ENV: 'production',
    PORT: String(PORTA_API),
    DATABASE_URL: URL_BD_E2E,
    LOG_LEVEL: 'warn',
    HYPERLIQUID_API_URL: URL_FALSO,
    OPENAI_BASE_URL: `${URL_FALSO}/v1`,
    OPENAI_API_KEY: CHAVE_OPENAI_FALSA,
  };
}

async function esperarSaude(api: ChildProcess, saida: () => string): Promise<void> {
  const limite = Date.now() + ESPERA_ARRANQUE_MS;
  for (;;) {
    if (api.exitCode !== null) {
      throw new Error(`A API terminou durante o arranque (código ${api.exitCode}):\n${saida()}`);
    }
    try {
      const r = await fetch(`${URL_API}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return;
    } catch {
      // Ainda a arrancar.
    }
    if (Date.now() > limite) {
      throw new Error(`O /health não respondeu 200 em ${ESPERA_ARRANQUE_MS / 1000} s:\n${saida()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function pararApi(api: ChildProcess | null): Promise<void> {
  if (!api || api.exitCode !== null) return;
  const terminou = new Promise<void>((r) => api.once('exit', () => r()));
  api.kill();
  await Promise.race([terminou, new Promise((r) => setTimeout(r, 10_000))]);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(ENTRADA_API) || !existsSync(INDEX_WEB)) {
    throw new Error('Falta o build (apps/api/dist e apps/web/dist): execute "npm run build".');
  }
  const nome = nomeBaseE2e();
  let falso: ServidorFalso | null = null;
  let api: ChildProcess | null = null;
  let baseCriada = false;

  const teardown = async () => {
    await pararApi(api);
    await falso?.fechar();
    if (baseCriada) await apagarBase(nome);
  };

  try {
    falso = await arrancarServidorFalso(PORTA_FALSO);

    await apagarBase(nome);
    await administrar(`CREATE DATABASE "${nome}"`);
    baseCriada = true;
    migrar();

    const linhas: string[] = [];
    api = spawn(process.execPath, [ENTRADA_API], {
      cwd: RAIZ,
      env: ambienteApi(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const guardar = (b: Buffer) => {
      linhas.push(...b.toString('utf8').split('\n').filter(Boolean));
      linhas.splice(0, Math.max(0, linhas.length - 50));
    };
    api.stdout?.on('data', guardar);
    api.stderr?.on('data', guardar);
    await esperarSaude(api, () => linhas.join('\n'));
  } catch (erro) {
    await teardown();
    throw erro;
  }
  return teardown;
}
