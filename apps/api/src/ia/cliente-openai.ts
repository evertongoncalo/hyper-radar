import { z } from 'zod';
import { ErroIa, erroNaoConfigurada } from './erros';

/*
 * Cliente mínimo da Responses API da OpenAI (`POST /v1/responses`) com Structured Outputs
 * (`text.format` = `json_schema`, `strict: true`). `fetch` direto, sem SDK: um único endpoint.
 * A chave só vai no cabeçalho `Authorization`; nunca é registada nem incluída em erros.
 */

export const URL_OPENAI_OMISSAO = 'https://api.openai.com/v1';
export const TIMEOUT_OMISSAO_MS = 90_000;
/** Novas tentativas (além da primeira), só em 429 (sem ser quota) e 5xx. */
export const TENTATIVAS_EXTRA_OMISSAO = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAXIMO_MS = 10_000;

export type FuncaoFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OpcoesClienteOpenAi {
  /** `null` = sem chave configurada (todas as chamadas falham com `NAO_CONFIGURADA`). */
  chave: string | null;
  fetch?: FuncaoFetch;
  urlBase?: string;
  timeoutMs?: number;
  tentativasExtra?: number;
  /** Espera entre tentativas (injetável nos testes). */
  esperar?: (ms: number) => Promise<void>;
}

export interface PedidoGeracao {
  modelo: string;
  instrucoes: string;
  entrada: string;
  schema: { nome: string; schema: Record<string, unknown> };
  maxTokensSaida: number;
}

export interface RespostaGeracao {
  /** JSON já interpretado (ainda por validar com zod). */
  dados: unknown;
  /** Modelo reportado pela OpenAI (pode incluir a data do snapshot). */
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
}

/** O que o serviço precisa de um gerador (substituível nos testes). */
export interface GeradorIa {
  readonly configurado: boolean;
  gerar(pedido: PedidoGeracao): Promise<RespostaGeracao>;
}

const conteudoSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  refusal: z.string().optional(),
});

const respostaSchema = z.looseObject({
  status: z.string().optional(),
  model: z.string().optional(),
  incomplete_details: z.looseObject({ reason: z.string().optional() }).nullish(),
  output: z.array(z.looseObject({ type: z.string(), content: z.array(conteudoSchema).optional() })),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

const erroCorpoSchema = z.looseObject({
  error: z.looseObject({ code: z.string().nullish(), type: z.string().nullish() }).nullish(),
});

/** Marca de corpo que não é JSON. */
const SEM_JSON = Symbol('sem-json');

const esperaReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ClienteOpenAi implements GeradorIa {
  private readonly chave: string | null;
  private readonly fetch: FuncaoFetch;
  private readonly urlBase: string;
  private readonly timeoutMs: number;
  private readonly tentativasExtra: number;
  private readonly esperar: (ms: number) => Promise<void>;

  constructor(opcoes: OpcoesClienteOpenAi) {
    this.chave = opcoes.chave;
    // Resolvido em cada chamada: o `fetch` global pode ser substituído (ex.: bloqueado nos testes).
    this.fetch = opcoes.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.urlBase = (opcoes.urlBase ?? URL_OPENAI_OMISSAO).replace(/\/+$/, '');
    this.timeoutMs = opcoes.timeoutMs ?? TIMEOUT_OMISSAO_MS;
    this.tentativasExtra = opcoes.tentativasExtra ?? TENTATIVAS_EXTRA_OMISSAO;
    this.esperar = opcoes.esperar ?? esperaReal;
  }

  get configurado(): boolean {
    return this.chave !== null;
  }

  async gerar(pedido: PedidoGeracao): Promise<RespostaGeracao> {
    if (this.chave === null) throw erroNaoConfigurada();
    const corpo = JSON.stringify({
      model: pedido.modelo,
      instructions: pedido.instrucoes,
      input: pedido.entrada,
      max_output_tokens: pedido.maxTokensSaida,
      // Sem guardar a resposta do lado da OpenAI (não é necessária para nada).
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: pedido.schema.nome,
          schema: pedido.schema.schema,
          strict: true,
        },
      },
    });

    for (let tentativa = 0; ; tentativa++) {
      const resposta = await this.tentar(corpo);
      if (resposta.estado >= 200 && resposta.estado < 300) {
        if (resposta.json === SEM_JSON) {
          throw new ErroIa('RESPOSTA_INVALIDA', 'A OpenAI devolveu uma resposta que não é JSON.');
        }
        return this.interpretar(resposta.json);
      }
      const erro = this.erroHttp(resposta.estado, resposta.json);
      const repetivel = (resposta.estado === 429 && !erro.quota) || resposta.estado >= 500;
      if (!repetivel || tentativa >= this.tentativasExtra) throw erro.erro;
      await this.esperar(this.atraso(tentativa, resposta.retryAfter));
    }
  }

  /** Uma tentativa: pedido e leitura do corpo sob o mesmo timeout. */
  private async tentar(
    corpo: string,
  ): Promise<{ estado: number; retryAfter: string | null; json: unknown }> {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), this.timeoutMs);
    try {
      const resposta = await this.fetch(`${this.urlBase}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.chave}`,
        },
        body: corpo,
        signal: controlador.signal,
      });
      const texto = await resposta.text();
      let json: unknown = SEM_JSON;
      try {
        json = JSON.parse(texto);
      } catch {
        // Fica `SEM_JSON`; decide-se pelo estado.
      }
      return { estado: resposta.status, retryAfter: resposta.headers.get('retry-after'), json };
    } catch (erro) {
      if (controlador.signal.aborted) throw this.erroTimeout(erro);
      throw new ErroIa('INDISPONIVEL', 'Não foi possível contactar a OpenAI (erro de rede).', {
        cause: erro,
      });
    } finally {
      clearTimeout(temporizador);
    }
  }

  private erroTimeout(causa: unknown): ErroIa {
    return new ErroIa(
      'TIMEOUT',
      `A OpenAI não respondeu em ${Math.round(this.timeoutMs / 1000)} s; tente novamente.`,
      { cause: causa },
    );
  }

  /** Erro tipado a partir do estado HTTP (só o `code` do corpo é lido; a mensagem não). */
  private erroHttp(estado: number, json: unknown): { erro: ErroIa; quota: boolean } {
    const corpo = erroCorpoSchema.safeParse(json);
    const bruto = corpo.success ? (corpo.data.error?.code ?? corpo.data.error?.type ?? null) : null;
    // Só identificadores simples (ex.: `invalid_json_schema`); nunca texto livre da OpenAI.
    const codigoOpenAi = bruto !== null && /^[a-z0-9_.-]{1,60}$/i.test(bruto) ? bruto : null;
    const criar = (codigo: ErroIa['codigo'], mensagem: string, quota = false) => ({
      erro: new ErroIa(codigo, mensagem, { estadoHttp: estado }),
      quota,
    });
    if (estado === 401 || estado === 403) {
      return criar(
        'AUTENTICACAO',
        'A OpenAI rejeitou a chave configurada (OPENAI_API_KEY); verifique-a no ficheiro .env.',
      );
    }
    if (estado === 429) {
      const quota = codigoOpenAi === 'insufficient_quota';
      return criar(
        'LIMITE_OPENAI',
        quota
          ? 'A conta OpenAI não tem quota/saldo disponível.'
          : 'Limite de pedidos da OpenAI atingido; tente novamente dentro de instantes.',
        quota,
      );
    }
    if (estado >= 500) {
      return criar('INDISPONIVEL', `A OpenAI está indisponível (HTTP ${estado}).`);
    }
    return criar(
      'RESPOSTA_INVALIDA',
      `A OpenAI rejeitou o pedido (HTTP ${estado}${codigoOpenAi ? `, ${codigoOpenAi}` : ''}).`,
    );
  }

  private atraso(tentativa: number, retryAfter: string | null): number {
    const segundos = retryAfter === null ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(segundos) && segundos >= 0) {
      return Math.min(segundos * 1000, BACKOFF_MAXIMO_MS);
    }
    return Math.min(BACKOFF_BASE_MS * 2 ** tentativa, BACKOFF_MAXIMO_MS);
  }

  private interpretar(json: unknown): RespostaGeracao {
    const r = respostaSchema.safeParse(json);
    if (!r.success) {
      throw new ErroIa('RESPOSTA_INVALIDA', 'Resposta da OpenAI com formato inesperado.');
    }
    const uso = {
      tokensEntrada: r.data.usage.input_tokens,
      tokensSaida: r.data.usage.output_tokens,
    };
    const partes = r.data.output.flatMap((o) => (o.type === 'message' ? (o.content ?? []) : []));
    if (partes.some((p) => p.type === 'refusal')) {
      throw new ErroIa('RECUSA', 'O modelo recusou produzir a análise para estes dados.', { uso });
    }
    if (r.data.status !== undefined && r.data.status !== 'completed') {
      const motivo = r.data.incomplete_details?.reason;
      throw new ErroIa(
        'RESPOSTA_INVALIDA',
        motivo === 'max_output_tokens'
          ? 'A resposta da OpenAI ficou incompleta (limite de tokens de saída).'
          : `A resposta da OpenAI não ficou completa (estado "${r.data.status}").`,
        { uso },
      );
    }
    const texto = partes
      .filter((p) => p.type === 'output_text')
      .map((p) => p.text ?? '')
      .join('');
    let dados: unknown;
    try {
      dados = JSON.parse(texto);
    } catch (erro) {
      throw new ErroIa('RESPOSTA_INVALIDA', 'A OpenAI devolveu um relatório que não é JSON.', {
        cause: erro,
        uso,
      });
    }
    return { dados, modelo: r.data.model ?? '', ...uso };
  }
}
