/** Códigos dos erros de domínio da camada de persistência. */
export type CodigoErroRepositorio =
  | 'TICKER_INVALIDO'
  | 'TICKER_DUPLICADO'
  | 'ENDERECO_INVALIDO'
  | 'NAO_ENCONTRADO'
  | 'RUN_FECHADO'
  | 'RUN_JA_ABERTO'
  | 'VALOR_INVALIDO'
  | 'RESTRICAO_VIOLADA';

/** Base dos erros de domínio dos repositórios (mensagens prontas a mostrar, em PT-PT). */
export class ErroRepositorio extends Error {
  readonly codigo: CodigoErroRepositorio;

  constructor(mensagem: string, codigo: CodigoErroRepositorio, opcoes?: { cause?: unknown }) {
    super(mensagem, opcoes);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

export class ErroTickerInvalido extends ErroRepositorio {
  constructor(ticker: string, opcoes?: { cause?: unknown }) {
    super(`Ticker inválido: "${ticker}". Use "ATIVO" ou "dex:ATIVO".`, 'TICKER_INVALIDO', opcoes);
  }
}

export class ErroTickerDuplicado extends ErroRepositorio {
  constructor(ticker: string | null, opcoes?: { cause?: unknown }) {
    super(
      ticker ? `O ativo "${ticker}" já existe.` : 'Já existe um ativo com esse ticker.',
      'TICKER_DUPLICADO',
      opcoes,
    );
  }
}

export class ErroEnderecoInvalido extends ErroRepositorio {
  constructor(endereco: string) {
    super(
      `Endereço inválido: "${endereco}". Deve ser 0x seguido de 40 caracteres hexadecimais.`,
      'ENDERECO_INVALIDO',
    );
  }
}

export class ErroNaoEncontrado extends ErroRepositorio {
  constructor(entidade: string, id?: number | string, opcoes?: { cause?: unknown }) {
    super(
      id === undefined ? `${entidade} não encontrado(a).` : `${entidade} ${id} não encontrado(a).`,
      'NAO_ENCONTRADO',
      opcoes,
    );
  }
}

export class ErroRunFechado extends ErroRepositorio {
  constructor(runId: number) {
    super(`O run ${runId} já terminou; não aceita novos snapshots.`, 'RUN_FECHADO');
  }
}

export class ErroRunJaAberto extends ErroRepositorio {
  constructor(opcoes?: { cause?: unknown }) {
    super('Já existe uma análise em curso para este ativo.', 'RUN_JA_ABERTO', opcoes);
  }
}

export class ErroValorInvalido extends ErroRepositorio {
  constructor(detalhe: string, opcoes?: { cause?: unknown }) {
    super(`Valor inválido: ${detalhe}`, 'VALOR_INVALIDO', opcoes);
  }
}

/** Violação de uma constraint de validação (CHECK) da BD; `restricao` é o nome da constraint. */
export class ErroRestricaoViolada extends ErroRepositorio {
  readonly restricao: string | null;

  constructor(restricao: string | null, opcoes?: { cause?: unknown }) {
    super(
      `Dados rejeitados pela base de dados${restricao ? ` (regra "${restricao}")` : ''}.`,
      'RESTRICAO_VIOLADA',
      opcoes,
    );
    this.restricao = restricao;
  }
}

interface ErroPg {
  code?: string;
  constraint_name?: string;
}

/** Extrai o erro do Postgres (o Drizzle embrulha-o em `cause`). */
function erroPg(erro: unknown): ErroPg | null {
  if (typeof erro !== 'object' || erro === null) return null;
  const e = erro as ErroPg & { cause?: unknown };
  if (typeof e.code === 'string') return e;
  return e.cause !== undefined ? erroPg(e.cause) : null;
}

/** Contexto opcional para enriquecer as mensagens (ex.: o ticker que se tentou criar). */
export interface ContextoErro {
  ticker?: string;
}

/**
 * Converte erros de constraint do Postgres em erros de domínio; outros erros passam inalterados.
 * Único sítio onde os nomes das constraints são interpretados.
 */
export function traduzirErroPg(erro: unknown, contexto: ContextoErro = {}): unknown {
  if (erro instanceof ErroRepositorio) return erro;
  const pg = erroPg(erro);
  if (!pg) return erro;
  const restricao = pg.constraint_name ?? null;
  const opcoes = { cause: erro };

  switch (pg.code) {
    case '23505': // unique_violation
      if (restricao === 'assets_ticker_unique')
        return new ErroTickerDuplicado(contexto.ticker ?? null, opcoes);
      if (restricao === 'analysis_runs_one_open_per_asset') return new ErroRunJaAberto(opcoes);
      return new ErroRestricaoViolada(restricao, opcoes);
    case '23503': // foreign_key_violation
      return new ErroNaoEncontrado(entidadeDaFk(restricao), undefined, opcoes);
    case '23514': // check_violation
      if (restricao?.startsWith('assets_ticker'))
        return new ErroTickerInvalido(contexto.ticker ?? '', opcoes);
      return new ErroRestricaoViolada(restricao, opcoes);
    case '22003': // numeric_value_out_of_range
    case '22P02': // invalid_text_representation
      return new ErroValorInvalido('número fora do intervalo ou mal formado.', opcoes);
    default:
      return erro;
  }
}

function entidadeDaFk(restricao: string | null): string {
  if (restricao?.includes('wallet_id')) return 'Carteira';
  if (restricao?.includes('asset_id')) return 'Ativo';
  if (restricao?.includes('run_id')) return 'Run';
  if (restricao?.includes('snapshot_id')) return 'Snapshot';
  return 'Registo relacionado';
}

/** Executa a operação convertendo erros de constraint em erros de domínio. */
export async function comTraducao<T>(
  operacao: () => Promise<T>,
  contexto: ContextoErro = {},
): Promise<T> {
  try {
    return await operacao();
  } catch (erro) {
    throw traduzirErroPg(erro, contexto);
  }
}
