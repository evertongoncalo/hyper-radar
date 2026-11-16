/** Códigos dos erros do cliente Hyperliquid. */
export type CodigoErroHyperliquid =
  | 'LIMITE_TAXA'
  | 'TEMPO_ESGOTADO'
  | 'RESPOSTA_INVALIDA'
  | 'CIRCUITO_ABERTO'
  | 'ERRO_HTTP'
  | 'ERRO_REDE'
  | 'PARAMETRO_INVALIDO';

/** Base de todos os erros do cliente. `repetivel` indica se faz sentido tentar de novo. */
export class ErroHyperliquid extends Error {
  readonly codigo: CodigoErroHyperliquid;
  readonly repetivel: boolean;

  constructor(
    mensagem: string,
    codigo: CodigoErroHyperliquid,
    repetivel: boolean,
    opcoes?: { cause?: unknown },
  ) {
    super(mensagem, opcoes);
    this.name = new.target.name;
    this.codigo = codigo;
    this.repetivel = repetivel;
  }
}

/** HTTP 429: limite de pedidos excedido. */
export class ErroLimiteTaxa extends ErroHyperliquid {
  /** Espera sugerida pelo servidor (`Retry-After`), em ms, se existir. */
  readonly esperaSugeridaMs: number | null;

  constructor(esperaSugeridaMs: number | null = null) {
    super('Limite de pedidos da Hyperliquid excedido (HTTP 429).', 'LIMITE_TAXA', true);
    this.esperaSugeridaMs = esperaSugeridaMs;
  }
}

export class ErroTempoEsgotado extends ErroHyperliquid {
  constructor(timeoutMs: number) {
    super(`A Hyperliquid não respondeu em ${timeoutMs} ms.`, 'TEMPO_ESGOTADO', true);
  }
}

export class ErroRespostaInvalida extends ErroHyperliquid {
  constructor(detalhe: string, opcoes?: { cause?: unknown }) {
    super(`Resposta inválida da Hyperliquid: ${detalhe}`, 'RESPOSTA_INVALIDA', false, opcoes);
  }
}

export class ErroCircuitoAberto extends ErroHyperliquid {
  constructor(reabreEmMs: number) {
    super(
      `Pedidos à Hyperliquid suspensos após falhas seguidas; nova tentativa dentro de ${Math.ceil(reabreEmMs / 1000)} s.`,
      'CIRCUITO_ABERTO',
      false,
    );
  }
}

export class ErroHttp extends ErroHyperliquid {
  readonly estado: number;

  constructor(estado: number, mensagem: string, repetivel: boolean) {
    super(mensagem, 'ERRO_HTTP', repetivel);
    this.estado = estado;
  }
}

export class ErroRede extends ErroHyperliquid {
  constructor(causa: unknown) {
    super('Falha de rede ao contactar a Hyperliquid.', 'ERRO_REDE', true, { cause: causa });
  }
}

export class ErroParametroInvalido extends ErroHyperliquid {
  constructor(mensagem: string) {
    super(mensagem, 'PARAMETRO_INVALIDO', false);
  }
}
