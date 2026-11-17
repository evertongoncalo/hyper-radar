import {
  respostaErroSchema,
  type CodigoErroApi,
  type ProblemaValidacao,
} from '@hyper-radar/shared';

/** Códigos de erro do lado do cliente, além dos da API. */
export type CodigoErroCliente = CodigoErroApi | 'REDE' | 'RESPOSTA_INVALIDA';

/** Erro uniforme de qualquer pedido à API (mensagem pronta a mostrar, em PT-PT). */
export class ErroApi extends Error {
  constructor(
    readonly codigo: CodigoErroCliente,
    mensagem: string,
    /** Estado HTTP; `null` quando o pedido nem chegou ao servidor. */
    readonly estado: number | null = null,
    readonly detalhes?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroApi';
  }

  /** Problemas por campo (erros `VALIDACAO`), quando a API os envia. */
  get problemas(): ProblemaValidacao[] {
    if (!Array.isArray(this.detalhes)) return [];
    return this.detalhes.filter(
      (p): p is ProblemaValidacao =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as ProblemaValidacao).caminho === 'string' &&
        typeof (p as ProblemaValidacao).mensagem === 'string',
    );
  }
}

/** Mensagem a mostrar para qualquer erro (incluindo os inesperados). */
export function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error && erro.message) return erro.message;
  return 'Ocorreu um erro inesperado.';
}

/** Qualquer schema com `safeParse` (zod), sem depender diretamente do zod. */
export interface Esquema<T> {
  safeParse(dados: unknown): { success: true; data: T } | { success: false };
}

export type MetodoHttp = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface OpcoesPedido {
  metodo?: MetodoHttp;
  corpo?: unknown;
  /** Parâmetros de query; `undefined`/`null`/`''` são omitidos. */
  query?: Record<string, string | number | boolean | null | undefined>;
  sinal?: AbortSignal;
}

export const PREFIXO_API = '/api';

/** Constrói `/api/caminho?query`. */
export function urlApi(caminho: string, query?: OpcoesPedido['query']): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return `${PREFIXO_API}${caminho}${qs ? `?${qs}` : ''}`;
}

async function lerJson(resposta: Response): Promise<unknown> {
  const texto = await resposta.text();
  if (texto === '') return undefined;
  return JSON.parse(texto) as unknown;
}

/**
 * Pedido à API: valida a resposta com o schema dado (ou `null` para respostas sem corpo, ex.:
 * 204) e converte qualquer falha num `ErroApi`.
 */
export async function pedirApi<T>(
  caminho: string,
  esquema: Esquema<T>,
  opcoes?: OpcoesPedido,
): Promise<T>;
export async function pedirApi(
  caminho: string,
  esquema: null,
  opcoes?: OpcoesPedido,
): Promise<void>;
export async function pedirApi<T>(
  caminho: string,
  esquema: Esquema<T> | null,
  opcoes: OpcoesPedido = {},
): Promise<T | void> {
  const temCorpo = opcoes.corpo !== undefined;
  let resposta: Response;
  try {
    resposta = await fetch(urlApi(caminho, opcoes.query), {
      method: opcoes.metodo ?? 'GET',
      headers: temCorpo
        ? { accept: 'application/json', 'content-type': 'application/json' }
        : { accept: 'application/json' },
      ...(temCorpo ? { body: JSON.stringify(opcoes.corpo) } : {}),
      ...(opcoes.sinal ? { signal: opcoes.sinal } : {}),
    });
  } catch (erro) {
    if (erro instanceof DOMException && erro.name === 'AbortError') throw erro;
    throw new ErroApi('REDE', 'Sem ligação ao servidor HyperRadar. Confirme que está a correr.');
  }

  let dados: unknown;
  try {
    dados = await lerJson(resposta);
  } catch {
    throw new ErroApi(
      'RESPOSTA_INVALIDA',
      `Resposta inválida do servidor (HTTP ${resposta.status}).`,
      resposta.status,
    );
  }

  if (!resposta.ok) {
    const erro = respostaErroSchema.safeParse(dados);
    if (erro.success) {
      const { codigo, mensagem, detalhes } = erro.data.erro;
      throw new ErroApi(codigo, mensagem, resposta.status, detalhes);
    }
    throw new ErroApi(
      'RESPOSTA_INVALIDA',
      `Erro inesperado do servidor (HTTP ${resposta.status}).`,
      resposta.status,
    );
  }

  if (esquema === null) return;
  const r = esquema.safeParse(dados);
  if (!r.success) {
    throw new ErroApi(
      'RESPOSTA_INVALIDA',
      'Resposta do servidor em formato inesperado.',
      resposta.status,
    );
  }
  return r.data;
}
