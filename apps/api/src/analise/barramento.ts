import type { Logger } from 'pino';
import type { EstadoAtivo, EventoDetalhado } from '../repositorios';

/** Mudança de estado de um ativo (`idle`/`running`/`restarting`/`stopped`). */
export interface MudancaEstadoAtivo {
  assetId: number;
  ticker: string;
  anterior: EstadoAtivo;
  estado: EstadoAtivo;
  /** Run em curso após a mudança (`null` se parado). */
  runId: number | null;
  instante: Date;
}

/** Resumo de um ciclo de recolha terminado. */
export interface ResumoCiclo {
  assetId: number;
  ticker: string;
  runId: number;
  instante: Date;
  duracaoMs: number;
  carteirasOk: number;
  carteirasFalhadas: number;
  /** Eventos efetivamente inseridos (e publicados) neste ciclo. */
  eventos: number;
  /** `true` se o ciclo falhou no todo (circuito aberto, BD, nenhuma carteira lida). */
  falhou: boolean;
  erro: string | null;
}

/** Mapa nome → argumentos dos eventos do barramento. */
export interface EventosBarramento {
  /** Evento do motor já persistido, com ticker, endereço e alias da carteira. */
  evento: EventoDetalhado;
  'estado-ativo': MudancaEstadoAtivo;
  ciclo: ResumoCiclo;
}

export type NomeEventoBarramento = keyof EventosBarramento;
type Ouvinte<K extends NomeEventoBarramento> = (dados: EventosBarramento[K]) => void;

/**
 * Barramento em memória, tipado, entre o serviço de análise e os consumidores (SSE na Fase 3).
 * Um ouvinte que lance erro é registado e não impede os restantes nem o emissor.
 */
export class BarramentoAnalise {
  private readonly ouvintes = new Map<NomeEventoBarramento, Set<Ouvinte<never>>>();

  constructor(private readonly logger?: Logger) {}

  /** Subscreve; devolve a função que cancela a subscrição. */
  on<K extends NomeEventoBarramento>(nome: K, ouvinte: Ouvinte<K>): () => void {
    let conjunto = this.ouvintes.get(nome);
    if (!conjunto) {
      conjunto = new Set();
      this.ouvintes.set(nome, conjunto);
    }
    conjunto.add(ouvinte as Ouvinte<never>);
    return () => this.off(nome, ouvinte);
  }

  off<K extends NomeEventoBarramento>(nome: K, ouvinte: Ouvinte<K>): void {
    this.ouvintes.get(nome)?.delete(ouvinte as Ouvinte<never>);
  }

  emitir<K extends NomeEventoBarramento>(nome: K, dados: EventosBarramento[K]): void {
    for (const ouvinte of [...(this.ouvintes.get(nome) ?? [])]) {
      try {
        (ouvinte as Ouvinte<K>)(dados);
      } catch (erro) {
        this.logger?.error({ err: erro, evento: nome }, 'Ouvinte do barramento falhou');
      }
    }
  }

  /** Número de ouvintes de um evento (diagnóstico e testes). */
  contarOuvintes(nome: NomeEventoBarramento): number {
    return this.ouvintes.get(nome)?.size ?? 0;
  }
}
