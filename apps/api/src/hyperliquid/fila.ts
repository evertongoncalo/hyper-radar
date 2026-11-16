import type { Relogio } from './relogio';

export interface OpcoesFila {
  /** Máximo de pedidos em simultâneo. */
  concorrencia: number;
  /** Orçamento de peso numa janela deslizante de `janelaMs`. */
  orcamentoPeso: number;
  janelaMs: number;
  relogio: Relogio;
}

interface Pendente {
  peso: number;
  iniciar: () => void;
}

/**
 * Fila FIFO com concorrência limitada e orçamento de peso por janela deslizante
 * (modelo dos limites por IP da Hyperliquid).
 */
export class FilaPedidos {
  private readonly pendentes: Pendente[] = [];
  private readonly registos: { em: number; peso: number }[] = [];
  private ativos = 0;
  private cancelarDespertar: (() => void) | null = null;

  constructor(private readonly opcoes: OpcoesFila) {}

  /** Executa `tarefa` quando houver vaga e orçamento para `peso`. */
  executar<T>(peso: number, tarefa: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolver, rejeitar) => {
      this.pendentes.push({
        // Um pedido nunca pode exceder o orçamento inteiro, senão ficaria bloqueado para sempre.
        peso: Math.min(peso, this.opcoes.orcamentoPeso),
        iniciar: () => {
          Promise.resolve()
            .then(tarefa)
            .then(resolver, rejeitar)
            .finally(() => {
              this.ativos--;
              this.processar();
            });
        },
      });
      this.processar();
    });
  }

  /** Regista peso adicional conhecido só após a resposta (ex.: itens devolvidos em `userFills`). */
  acrescentarPeso(peso: number): void {
    if (peso <= 0) return;
    this.registos.push({ em: this.opcoes.relogio.agora(), peso });
  }

  /** Peso consumido na janela atual. */
  pesoUsado(): number {
    const limite = this.opcoes.relogio.agora() - this.opcoes.janelaMs;
    while (this.registos.length > 0 && this.registos[0]!.em <= limite) this.registos.shift();
    return this.registos.reduce((soma, r) => soma + r.peso, 0);
  }

  get emEspera(): number {
    return this.pendentes.length;
  }

  private processar(): void {
    while (this.pendentes.length > 0 && this.ativos < this.opcoes.concorrencia) {
      const proximo = this.pendentes[0]!;
      if (this.pesoUsado() + proximo.peso > this.opcoes.orcamentoPeso) {
        this.agendarDespertar();
        return;
      }
      this.pendentes.shift();
      this.registos.push({ em: this.opcoes.relogio.agora(), peso: proximo.peso });
      this.ativos++;
      proximo.iniciar();
    }
  }

  /** Acorda a fila quando o registo mais antigo sair da janela. */
  private agendarDespertar(): void {
    if (this.cancelarDespertar) return;
    const maisAntigo = this.registos[0]!;
    const ms = Math.max(1, maisAntigo.em + this.opcoes.janelaMs - this.opcoes.relogio.agora() + 1);
    this.cancelarDespertar = this.opcoes.relogio.agendar(() => {
      this.cancelarDespertar = null;
      this.processar();
    }, ms);
  }
}
