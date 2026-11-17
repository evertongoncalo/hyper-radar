import type { CodigoErroApi, ProblemaValidacao, RespostaErro } from '@hyper-radar/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErroAnalise, type CodigoErroAnalise } from '../analise';
import { ErroHyperliquid } from '../hyperliquid';
import { ErroIa, type CodigoErroIa } from '../ia/erros';
import { ErroRepositorio, type CodigoErroRepositorio } from '../repositorios';

/** Erro com estado HTTP e código da API (mensagem pronta a mostrar, em PT-PT). */
export class ErroApi extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: CodigoErroApi,
    mensagem: string,
    readonly detalhes?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroApi';
  }
}

export const naoEncontrado = (entidade: string, id: number) =>
  new ErroApi(404, 'NAO_ENCONTRADO', `${entidade} ${id} não encontrado(a).`);

/** Valida `dados` com o schema; lança `ErroApi` 400 com os problemas (caminho prefixado). */
export function analisar<S extends z.ZodType>(
  schema: S,
  dados: unknown,
  origem: 'params' | 'query' | 'body',
): z.output<S> {
  const r = schema.safeParse(dados ?? (origem === 'body' ? undefined : {}));
  if (r.success) return r.data;
  const problemas: ProblemaValidacao[] = r.error.issues.map((i) => ({
    caminho: [origem, ...i.path.map(String)].join('.'),
    mensagem: i.message,
  }));
  const primeiro = problemas[0]!;
  throw new ErroApi(
    400,
    'VALIDACAO',
    `Pedido inválido (${primeiro.caminho}): ${primeiro.mensagem}`,
    {
      problemas,
    },
  );
}

const ESTADO_REPOSITORIO: Record<CodigoErroRepositorio, number> = {
  TICKER_INVALIDO: 400,
  ENDERECO_INVALIDO: 400,
  VALOR_INVALIDO: 400,
  RESTRICAO_VIOLADA: 400,
  NAO_ENCONTRADO: 404,
  TICKER_DUPLICADO: 409,
  RUN_JA_ABERTO: 409,
  RUN_FECHADO: 409,
};

const ESTADO_ANALISE: Record<CodigoErroAnalise, { estado: number; codigo: CodigoErroApi }> = {
  SEM_CARTEIRAS: { estado: 409, codigo: 'SEM_CARTEIRAS' },
  JA_EM_CURSO: { estado: 409, codigo: 'JA_EM_CURSO' },
  NAO_EM_CURSO: { estado: 409, codigo: 'NAO_EM_CURSO' },
  ENCERRADO: { estado: 503, codigo: 'SERVICO_INDISPONIVEL' },
};

const ESTADO_IA: Record<CodigoErroIa, { estado: number; codigo: CodigoErroApi }> = {
  NAO_CONFIGURADA: { estado: 503, codigo: 'IA_NAO_CONFIGURADA' },
  LIMITE_DIARIO: { estado: 429, codigo: 'LIMITE_IA_ATINGIDO' },
  RECUSA: { estado: 502, codigo: 'IA_RECUSA' },
  RESPOSTA_INVALIDA: { estado: 502, codigo: 'IA_RESPOSTA_INVALIDA' },
  AUTENTICACAO: { estado: 502, codigo: 'IA_INDISPONIVEL' },
  LIMITE_OPENAI: { estado: 503, codigo: 'IA_INDISPONIVEL' },
  INDISPONIVEL: { estado: 503, codigo: 'IA_INDISPONIVEL' },
  TIMEOUT: { estado: 504, codigo: 'IA_INDISPONIVEL' },
};

/** Erros do Fastify (parsing do corpo) com mensagem em PT-PT. */
const ERROS_FASTIFY: Record<string, { estado: number; codigo: CodigoErroApi; mensagem: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    estado: 413,
    codigo: 'CORPO_DEMASIADO_GRANDE',
    mensagem: 'O corpo do pedido excede o tamanho máximo permitido.',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    estado: 415,
    codigo: 'TIPO_CONTEUDO_INVALIDO',
    mensagem: 'Tipo de conteúdo não suportado; use application/json.',
  },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    estado: 400,
    codigo: 'JSON_INVALIDO',
    mensagem: 'O corpo do pedido não é JSON válido.',
  },
  FST_ERR_BAD_URL: {
    estado: 400,
    codigo: 'PEDIDO_INVALIDO',
    mensagem: 'Caminho do pedido mal codificado.',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    estado: 400,
    codigo: 'JSON_INVALIDO',
    mensagem: 'O corpo do pedido está vazio mas foi declarado como JSON.',
  },
};

interface ErroTraduzido {
  estado: number;
  corpo: RespostaErro;
}

const corpo = (codigo: CodigoErroApi, mensagem: string, detalhes?: unknown): RespostaErro => ({
  erro: detalhes === undefined ? { codigo, mensagem } : { codigo, mensagem, detalhes },
});

/** Mapeamento central erro → HTTP. Erros desconhecidos dão 500 sem detalhes internos. */
export function traduzirErro(erro: unknown): ErroTraduzido {
  if (erro instanceof ErroApi) {
    return { estado: erro.estado, corpo: corpo(erro.codigo, erro.message, erro.detalhes) };
  }
  if (erro instanceof ErroRepositorio) {
    return { estado: ESTADO_REPOSITORIO[erro.codigo], corpo: corpo(erro.codigo, erro.message) };
  }
  if (erro instanceof ErroAnalise) {
    const { estado, codigo } = ESTADO_ANALISE[erro.codigo];
    return { estado, corpo: corpo(codigo, erro.message) };
  }
  if (erro instanceof ErroIa) {
    const { estado, codigo } = ESTADO_IA[erro.codigo];
    return { estado, corpo: corpo(codigo, erro.message) };
  }
  if (erro instanceof ErroHyperliquid) {
    if (erro.codigo === 'PARAMETRO_INVALIDO') {
      return { estado: 400, corpo: corpo('PEDIDO_INVALIDO', erro.message) };
    }
    // Circuito aberto ou limite de taxa: indisponível temporariamente; resto: gateway inválido.
    const temporario = erro.codigo === 'CIRCUITO_ABERTO' || erro.codigo === 'LIMITE_TAXA';
    return {
      estado: temporario ? 503 : 502,
      corpo: corpo(
        'HYPERLIQUID_INDISPONIVEL',
        temporario
          ? 'A Hyperliquid está temporariamente indisponível; tente novamente dentro de instantes.'
          : 'Não foi possível obter uma resposta válida da Hyperliquid.',
      ),
    };
  }
  const fst = erro as Partial<FastifyError>;
  const conhecido = typeof fst.code === 'string' ? ERROS_FASTIFY[fst.code] : undefined;
  if (conhecido) {
    return { estado: conhecido.estado, corpo: corpo(conhecido.codigo, conhecido.mensagem) };
  }
  if (typeof fst.statusCode === 'number' && fst.statusCode >= 400 && fst.statusCode < 500) {
    return { estado: fst.statusCode, corpo: corpo('PEDIDO_INVALIDO', 'Pedido inválido.') };
  }
  return { estado: 500, corpo: corpo('ERRO_INTERNO', 'Erro interno do servidor.') };
}

/** `setErrorHandler` da aplicação: regista 5xx e responde no formato uniforme. */
export function tratarErro(erro: unknown, pedido: FastifyRequest, resposta: FastifyReply) {
  const { estado, corpo: c } = traduzirErro(erro);
  if (estado >= 500) pedido.log.error({ err: erro }, 'Erro no pedido');
  else pedido.log.info({ codigo: c.erro.codigo }, c.erro.mensagem);
  return resposta.status(estado).send(c);
}

/** Atalho para enviar um erro uniforme (hooks e handlers sem `throw`). */
export function enviarErro(resposta: FastifyReply, erro: ErroApi) {
  const { estado, corpo: c } = traduzirErro(erro);
  return resposta.status(estado).send(c);
}
