import { ErroCircuitoAberto } from './erros';
import type { Relogio } from './relogio';

export type EstadoCircuito = 'fechado' | 'aberto' | 'meio-aberto';

export interface OpcoesCircuito {
  /** Falhas seguidas que abrem o circuito. */
  limiarFalhas: number;
  /** Tempo em aberto antes de deixar passar um pedido de teste. */
  intervaloMeioAbertoMs: number;
  relogio: Relogio;
}

/** Circuit breaker simples: fechado → aberto (N falhas) → meio-aberto (1 pedido de teste). */
export class Circuito {
  private falhasSeguidas = 0;
  private abertoEm: number | null = null;
  private testeEmCurso = false;

  constructor(private readonly opcoes: OpcoesCircuito) {}

  get estado(): EstadoCircuito {
    if (this.abertoEm === null) return 'fechado';
    return this.opcoes.relogio.agora() - this.abertoEm >= this.opcoes.intervaloMeioAbertoMs
      ? 'meio-aberto'
      : 'aberto';
  }

  /** Lança `ErroCircuitoAberto` se o pedido não puder avançar. */
  autorizar(): void {
    const estado = this.estado;
    if (estado === 'fechado') return;
    if (estado === 'meio-aberto' && !this.testeEmCurso) {
      this.testeEmCurso = true;
      return;
    }
    const decorrido = this.opcoes.relogio.agora() - this.abertoEm!;
    throw new ErroCircuitoAberto(Math.max(0, this.opcoes.intervaloMeioAbertoMs - decorrido));
  }

  registarSucesso(): void {
    this.falhasSeguidas = 0;
    this.abertoEm = null;
    this.testeEmCurso = false;
  }

  registarFalha(): void {
    this.falhasSeguidas++;
    if (this.testeEmCurso || this.falhasSeguidas >= this.opcoes.limiarFalhas) {
      this.abertoEm = this.opcoes.relogio.agora();
    }
    this.testeEmCurso = false;
  }

  /** Liberta o pedido de teste sem alterar o estado (ex.: falha não imputável ao servidor). */
  libertarTeste(): void {
    this.testeEmCurso = false;
  }
}
