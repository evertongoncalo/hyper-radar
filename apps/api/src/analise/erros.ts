/** Códigos dos erros de domínio do serviço de análise. */
export type CodigoErroAnalise = 'SEM_CARTEIRAS' | 'JA_EM_CURSO' | 'NAO_EM_CURSO' | 'ENCERRADO';

/** Erro de domínio do serviço de análise (mensagem pronta a mostrar, em PT-PT). */
export class ErroAnalise extends Error {
  readonly codigo: CodigoErroAnalise;

  constructor(mensagem: string, codigo: CodigoErroAnalise) {
    super(mensagem);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

export class ErroAtivoSemCarteiras extends ErroAnalise {
  constructor(ticker: string) {
    super(`O ativo "${ticker}" não tem carteiras; adicione pelo menos uma.`, 'SEM_CARTEIRAS');
  }
}

export class ErroAnaliseJaEmCurso extends ErroAnalise {
  constructor(ticker: string) {
    super(`A análise de "${ticker}" já está em curso.`, 'JA_EM_CURSO');
  }
}

export class ErroAnaliseNaoEmCurso extends ErroAnalise {
  constructor(ticker: string) {
    super(`A análise de "${ticker}" não está em curso.`, 'NAO_EM_CURSO');
  }
}

export class ErroServicoEncerrado extends ErroAnalise {
  constructor() {
    super('O serviço de análise está a encerrar.', 'ENCERRADO');
  }
}
