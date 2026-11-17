/** Códigos dos erros da Análise IA. */
export type CodigoErroIa =
  | 'NAO_CONFIGURADA'
  | 'LIMITE_DIARIO'
  | 'RECUSA'
  | 'RESPOSTA_INVALIDA'
  | 'LIMITE_OPENAI'
  | 'TIMEOUT'
  | 'AUTENTICACAO'
  | 'INDISPONIVEL';

/**
 * Erro da Análise IA (mensagem pronta a mostrar, em PT-PT). Nunca inclui a chave nem o texto
 * devolvido pela OpenAI (que pode ecoar parte da chave).
 */
export class ErroIa extends Error {
  /** Estado HTTP devolvido pela OpenAI, se houver. */
  readonly estadoHttp: number | null;
  /** Tokens consumidos apesar do erro (recusa, resposta inválida): contam para os limites. */
  readonly uso: { tokensEntrada: number; tokensSaida: number } | null;

  constructor(
    readonly codigo: CodigoErroIa,
    mensagem: string,
    opcoes?: {
      cause?: unknown;
      estadoHttp?: number;
      uso?: { tokensEntrada: number; tokensSaida: number };
    },
  ) {
    super(mensagem, opcoes?.cause === undefined ? undefined : { cause: opcoes.cause });
    this.name = 'ErroIa';
    this.estadoHttp = opcoes?.estadoHttp ?? null;
    this.uso = opcoes?.uso ?? null;
  }
}

export const erroNaoConfigurada = () =>
  new ErroIa(
    'NAO_CONFIGURADA',
    'A Análise IA não está configurada: defina OPENAI_API_KEY no ficheiro .env e reinicie o servidor.',
  );
