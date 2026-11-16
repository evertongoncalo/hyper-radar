import type { EstadoCarteiraNoAtivo, OrdemAberta } from '@hyper-radar/shared';
import type { Relogio } from '../../hyperliquid/relogio';
import type { BarramentoAnalise, EventosBarramento, NomeEventoBarramento } from '../barramento';
import type { FonteEstadoCarteira } from '../servico';

export const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
export const SEGUNDO = 1_000;
export const MINUTO = 60_000;

interface Agendado {
  id: number;
  em: number;
  ms: number;
  fn: () => void;
}

/** Relógio manual: o tempo só avança com `avancar`, que dispara os temporizadores vencidos. */
export class RelogioFalso implements Relogio {
  private t: number;
  private seq = 0;
  private agendados: Agendado[] = [];
  /** Durações pedidas a `agendar`, por ordem. */
  readonly pedidos: number[] = [];

  constructor(inicio = T0) {
    this.t = inicio;
  }

  agora(): number {
    return this.t;
  }

  agendar(fn: () => void, ms: number): () => void {
    const item = { id: ++this.seq, em: this.t + ms, ms, fn };
    this.agendados.push(item);
    this.pedidos.push(ms);
    return () => {
      this.agendados = this.agendados.filter((a) => a !== item);
    };
  }

  /** Avança o tempo, disparando por ordem os temporizadores que vencem até lá. */
  avancar(ms: number): void {
    const alvo = this.t + ms;
    for (;;) {
      const proximo = [...this.agendados]
        .filter((a) => a.em <= alvo)
        .sort((a, b) => a.em - b.em || a.id - b.id)[0];
      if (!proximo) break;
      this.agendados = this.agendados.filter((a) => a !== proximo);
      this.t = Math.max(this.t, proximo.em);
      proximo.fn();
    }
    this.t = alvo;
  }

  /** Temporizadores pendentes (opcionalmente só os de uma duração). */
  pendentes(ms?: number): number {
    return this.agendados.filter((a) => ms === undefined || a.ms === ms).length;
  }
}

type Resposta =
  | EstadoCarteiraNoAtivo
  | Error
  | Promise<EstadoCarteiraNoAtivo>
  | (() => Promise<EstadoCarteiraNoAtivo>);

/**
 * Cliente Hyperliquid falso: devolve, por endereço, o estado programado (ou lança o erro).
 * Com uma fila programada, cada chamada consome o próximo item; o último repete-se.
 */
export class ClienteFalso implements FonteEstadoCarteira {
  private readonly filas = new Map<string, Resposta[]>();
  readonly chamadas: { user: string; ticker: string }[] = [];

  definir(user: string, ...respostas: Resposta[]): this {
    this.filas.set(user.toLowerCase(), respostas);
    return this;
  }

  async obterEstadoCarteiraNoAtivo(user: string, ticker: string): Promise<EstadoCarteiraNoAtivo> {
    this.chamadas.push({ user, ticker });
    const fila = this.filas.get(user.toLowerCase());
    if (!fila || fila.length === 0) throw new Error(`Sem resposta programada para ${user}.`);
    const r = fila.length > 1 ? fila.shift()! : fila[0]!;
    if (r instanceof Error) throw r;
    const estado = await (typeof r === 'function' ? r() : r);
    return { ...estado, user: user.toLowerCase() };
  }
}

export interface OpcoesEstado {
  lado?: 'long' | 'short';
  /** Tamanho (0 ou omitido = sem posição). */
  tamanho?: number;
  entryPx?: number;
  preco?: number;
  liquidationPx?: number | null;
  sl?: number;
  tp?: number;
  coin?: string;
}

function ordem(oid: number, coin: string, tipo: 'SL' | 'TP', triggerPx: number): OrdemAberta {
  return {
    oid,
    coin,
    dex: coin.includes(':') ? coin.split(':')[0]! : null,
    lado: 'venda',
    tamanho: 0,
    tamanhoOriginal: 0,
    limitPx: triggerPx,
    isTrigger: true,
    triggerPx,
    triggerCondition: '',
    orderType: tipo === 'SL' ? 'Stop Market' : 'Take Profit Market',
    reduceOnly: true,
    isPositionTpsl: true,
    protecao: tipo === 'SL' ? 'stop_loss' : 'take_profit',
    timestamp: 0,
  };
}

/** Estado fictício de uma carteira num ativo, como o cliente o devolveria. */
export function estadoCarteira(opcoes: OpcoesEstado = {}): EstadoCarteiraNoAtivo {
  const { lado = 'long', tamanho = 0, entryPx = 100, preco = 100, coin = 'BTC' } = opcoes;
  const ordens: OrdemAberta[] = [];
  if (opcoes.sl !== undefined) ordens.push(ordem(1, coin, 'SL', opcoes.sl));
  if (opcoes.tp !== undefined) ordens.push(ordem(2, coin, 'TP', opcoes.tp));
  return {
    user: '',
    coin,
    dex: coin.includes(':') ? coin.split(':')[0]! : null,
    posicao:
      tamanho > 0
        ? {
            coin,
            dex: null,
            lado,
            tamanho,
            szi: lado === 'long' ? tamanho : -tamanho,
            entryPx,
            leverage: { tipo: 'cross', valor: 5 },
            liquidationPx: opcoes.liquidationPx ?? null,
            marginUsed: (tamanho * preco) / 5,
            unrealizedPnl: 0,
            positionValue: tamanho * preco,
            returnOnEquity: 0,
            maxLeverage: 50,
          }
        : null,
    ordensProtecao: ordens,
    accountValue: 1_000_000,
    modoConta: 'default',
    accountValueRepresentativo: true,
    mercado: { markPx: preco, midPx: preco, oraclePx: preco },
    time: 0,
  };
}

/** Promessa controlável à mão (para simular leituras lentas). */
export function adiada<T>() {
  let resolver!: (v: T) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise<T>((r, j) => {
    resolver = r;
    rejeitar = j;
  });
  return { promessa, resolver, rejeitar };
}

/** Recolhe tudo o que o barramento publica, por tipo. */
export function gravador(barramento: BarramentoAnalise) {
  const recebido: { [K in NomeEventoBarramento]: EventosBarramento[K][] } = {
    evento: [],
    'estado-ativo': [],
    ciclo: [],
  };
  barramento.on('evento', (e) => recebido.evento.push(e));
  barramento.on('estado-ativo', (e) => recebido['estado-ativo'].push(e));
  barramento.on('ciclo', (e) => recebido.ciclo.push(e));
  return recebido;
}

/** Promessa do próximo `ciclo` publicado (opcionalmente de um ativo). */
export function proximoCiclo(
  barramento: BarramentoAnalise,
  assetId?: number,
): Promise<EventosBarramento['ciclo']> {
  return new Promise((resolver) => {
    const cancelar = barramento.on('ciclo', (c) => {
      if (assetId !== undefined && c.assetId !== assetId) return;
      cancelar();
      resolver(c);
    });
  });
}

/** Deixa correr as microtarefas/IO pendentes (útil após `avancar`). */
export const esperarIo = () => new Promise<void>((r) => setTimeout(r, 20));
