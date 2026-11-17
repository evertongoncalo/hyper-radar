import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { enviarErro, ErroApi } from './erros';

/** Tipos MIME dos ficheiros gerados pelo Vite. */
const TIPOS_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

const naoEncontrado = () => new ErroApi(404, 'NAO_ENCONTRADO', 'Recurso não encontrado.');

/** `/api/*` e `/health` nunca caem no frontend: respondem 404 em JSON. */
function eRotaDoServidor(caminho: string): boolean {
  return /^\/(api|health)(\/|$)/.test(caminho);
}

/** Descodifica o caminho; se for inválido, devolve um valor que nunca corresponde a um ficheiro. */
function decodificar(caminho: string): string {
  try {
    return decodeURIComponent(caminho);
  } catch {
    return '\0';
  }
}

async function eFicheiro(caminho: string): Promise<boolean> {
  try {
    return (await stat(caminho)).isFile();
  } catch {
    return false;
  }
}

/**
 * Handler de "não encontrado" da aplicação. Se `pastaWeb` tiver um `index.html` (build do Vite),
 * serve os ficheiros estáticos na raiz com fallback SPA para `index.html` (só caminhos sem
 * extensão), protegido contra path traversal. Caso contrário, 404 uniforme em JSON.
 */
export function instalarFrontend(app: FastifyInstance, pastaWeb: string | null): void {
  const raiz = pastaWeb && existsSync(join(pastaWeb, 'index.html')) ? resolve(pastaWeb) : null;

  app.setNotFoundHandler(async (pedido, resposta) => {
    const caminho = pedido.url.split('?')[0]!;
    if (
      raiz === null ||
      eRotaDoServidor(caminho) ||
      (pedido.method !== 'GET' && pedido.method !== 'HEAD')
    ) {
      return enviarErro(resposta, naoEncontrado());
    }

    // URLs mal codificadas já foram rejeitadas pelo Fastify (`FST_ERR_BAD_URL` → 400).
    const relativo = decodificar(caminho);
    const alvo = resolve(raiz, `.${relativo}`);
    // Path traversal (`..`, `%2e%2e`, `\` no Windows, bytes nulos): nunca sair da pasta.
    if (relativo.includes('\0') || (alvo !== raiz && !alvo.startsWith(raiz + sep))) {
      return enviarErro(resposta, naoEncontrado());
    }

    let ficheiro: string;
    if (alvo !== raiz && (await eFicheiro(alvo))) ficheiro = alvo;
    else if (extname(relativo) === '') ficheiro = join(raiz, 'index.html');
    else return enviarErro(resposta, naoEncontrado());

    const extensao = extname(ficheiro).toLowerCase();
    const imutavel = relativo.startsWith('/assets/') && ficheiro !== join(raiz, 'index.html');
    return resposta
      .status(200)
      .header('content-type', TIPOS_MIME[extensao] ?? 'application/octet-stream')
      .header('cache-control', imutavel ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(await readFile(ficheiro));
  });
}
