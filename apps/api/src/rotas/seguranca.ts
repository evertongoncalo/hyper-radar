import type { FastifyInstance } from 'fastify';
import { enviarErro, ErroApi } from './erros';

export interface OpcoesSeguranca {
  /** Porta em que o servidor escuta; se indicada, o `Host` tem de a usar. */
  porta?: number | null;
  /** Origens extra aceites em pedidos mutáveis (ex.: dev server Vite). */
  origensPermitidas?: readonly string[];
}

/** Origens do dev server Vite, aceites por omissão. */
export const ORIGENS_DEV_OMISSAO = ['http://127.0.0.1:5173', 'http://localhost:5173'] as const;

const NOMES_LOCAIS = new Set(['localhost', '127.0.0.1', '[::1]']);
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Separa `nome[:porta]` (IPv6 entre parêntesis retos); `null` se mal formado. */
function separarHost(host: string): { nome: string; porta: number | null } | null {
  const m = /^(\[[0-9a-f:]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!m) return null;
  return { nome: m[1]!.toLowerCase(), porta: m[2] === undefined ? null : Number(m[2]) };
}

/**
 * Proteção contra DNS rebinding e CSRF de páginas web maliciosas (o servidor só escuta em
 * 127.0.0.1): `Host` tem de ser local (e na porta certa); em métodos mutáveis, um `Origin`
 * presente tem de ser a própria origem ou uma das permitidas. Sem CORS: o browser bloqueia
 * leituras de outras origens.
 */
export function instalarSeguranca(app: FastifyInstance, opcoes: OpcoesSeguranca = {}): void {
  const porta = opcoes.porta ?? null;
  const permitidas = new Set(
    (opcoes.origensPermitidas ?? ORIGENS_DEV_OMISSAO).map((o) =>
      o.replace(/\/+$/, '').toLowerCase(),
    ),
  );

  app.addHook('onRequest', async (pedido, resposta) => {
    const host = pedido.headers.host;
    const separado = host === undefined ? null : separarHost(host);
    if (
      !separado ||
      !NOMES_LOCAIS.has(separado.nome) ||
      (porta !== null && separado.porta !== porta)
    ) {
      return enviarErro(
        resposta,
        new ErroApi(403, 'HOST_INVALIDO', 'Pedido recusado: cabeçalho Host não é local.'),
      );
    }

    const origem = pedido.headers.origin;
    if (origem === undefined || METODOS_SEGUROS.has(pedido.method)) return;
    const normalizada = origem.toLowerCase();
    const propria = `http://${host!.trim().toLowerCase()}`;
    if (normalizada !== propria && !permitidas.has(normalizada)) {
      return enviarErro(
        resposta,
        new ErroApi(403, 'ORIGEM_INVALIDA', 'Pedido recusado: origem não autorizada.'),
      );
    }
  });

  // Endurecimento básico: sem sniffing de tipos nem enquadramento por outras páginas.
  app.addHook('onSend', async (_pedido, resposta) => {
    resposta.header('x-content-type-options', 'nosniff');
    resposta.header('x-frame-options', 'DENY');
  });
}
