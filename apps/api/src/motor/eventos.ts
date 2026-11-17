import type { LadoPosicao, TipoMargem } from '@hyper-radar/shared';
import type { ConfigMotor } from './config';
import type { PosicaoMotor, TipoProtecaoMotor } from './tipos';

/** Tipos de evento; têm de coincidir com o enum `event_type` da BD (verificado em teste). */
export const TIPOS_EVENTO = [
  'OPENED',
  'CLOSED',
  'INCREASED',
  'REDUCED',
  'FLIPPED',
  'SLTP_CHANGED',
  'LIQ_NEAR',
] as const;

export type TipoEvento = (typeof TIPOS_EVENTO)[number];

/** SL/TP normalizado para comparação e payloads (sem `oid`, que muda a cada reposição). */
export interface ProtecaoNormalizada {
  tipo: TipoProtecaoMotor;
  triggerPx: number;
  /** `null` = posição inteira. */
  tamanho: number | null;
}

export interface ProtecaoMovida {
  tipo: TipoProtecaoMotor;
  antes: ProtecaoNormalizada;
  depois: ProtecaoNormalizada;
}

export interface PayloadAbertura {
  posicao: PosicaoMotor;
  protecoes: ProtecaoNormalizada[];
  precoMercado: number;
}

export interface PayloadFecho {
  /** Posição de referência (última conhecida pelo utilizador). */
  posicaoAnterior: PosicaoMotor;
  /** Notional fechado, avaliado ao preço de mercado atual. */
  notionalFechado: number;
  precoMercado: number;
}

export interface PayloadInversao {
  posicaoAnterior: PosicaoMotor;
  posicao: PosicaoMotor;
  protecoes: ProtecaoNormalizada[];
  precoMercado: number;
}

export interface PayloadVariacao {
  lado: LadoPosicao;
  tamanhoAnterior: number;
  tamanhoNovo: number;
  /** Variação com sinal (`tamanhoNovo − tamanhoAnterior`). */
  delta: number;
  /** |delta| em % do tamanho anterior. */
  variacaoPct: number;
  /** |delta| × preço de mercado (USD). */
  deltaNotional: number;
  entryPxAnterior: number;
  /** Preço médio de entrada após as ordens consolidadas. */
  entryPxNovo: number;
  leverage: number;
  tipoMargem: TipoMargem;
  notional: number;
  liquidationPx: number | null;
  precoMercado: number;
  /** Nº de ciclos com alteração de tamanho consolidados neste evento. */
  ciclosConsolidados: number;
  /** Instante da primeira divergência face à referência. */
  inicioJanela: number;
}

export interface PayloadSltp {
  lado: LadoPosicao | null;
  antes: ProtecaoNormalizada[];
  depois: ProtecaoNormalizada[];
  adicionadas: ProtecaoNormalizada[];
  removidas: ProtecaoNormalizada[];
  movidas: ProtecaoMovida[];
  ciclosConsolidados: number;
  inicioJanela: number;
}

export interface PayloadLiquidacao {
  lado: LadoPosicao;
  tamanho: number;
  notional: number;
  leverage: number;
  tipoMargem: TipoMargem;
  liquidationPx: number;
  precoMercado: number;
  /** Distância do preço de mercado à liquidação, em % do preço de mercado. */
  distanciaPct: number;
  limiarPct: number;
}

export interface PayloadsEvento {
  OPENED: PayloadAbertura;
  CLOSED: PayloadFecho;
  INCREASED: PayloadVariacao;
  REDUCED: PayloadVariacao;
  FLIPPED: PayloadInversao;
  SLTP_CHANGED: PayloadSltp;
  LIQ_NEAR: PayloadLiquidacao;
}

/** Evento do motor, discriminado por `tipo`. */
export type EventoMotor<T extends TipoEvento = TipoEvento> = {
  [K in T]: {
    tipo: K;
    carteira: string;
    ativo: string;
    instante: number;
    payload: PayloadsEvento[K];
    chaveDedupe: string;
  };
}[T];

/** Início do bucket temporal que contém `instante`. */
export function inicioBucket(instante: number, bucketMs: number): number {
  return Math.floor(instante / bucketMs) * bucketMs;
}

/**
 * Tipos emitidos de imediato (sem janela): a chave usa o instante exato do snapshot, para que
 * abrir → fechar → reabrir dentro do mesmo bucket não perca o segundo evento. Reprocessar o
 * mesmo snapshot dá a mesma chave (idempotente).
 */
export const TIPOS_IMEDIATOS: ReadonlySet<TipoEvento> = new Set<TipoEvento>([
  'OPENED',
  'CLOSED',
  'FLIPPED',
  'LIQ_NEAR',
]);

/**
 * Chave de deduplicação determinística: carteira + ativo + tipo + instante (do snapshot nos tipos
 * imediatos, do início da janela nos agregados). Com `bucketMs`, usa-se o início do bucket que o
 * contém; com `null`, o instante exato. Separador `|` porque os tickers HIP-3 contêm `:`.
 */
export function calcularChaveDedupe(
  carteira: string,
  ativo: string,
  tipo: TipoEvento,
  inicioJanela: number,
  bucketMs: number | null,
): string {
  const marca = bucketMs === null ? inicioJanela : inicioBucket(inicioJanela, bucketMs);
  return [carteira.toLowerCase(), ativo, tipo, marca].join('|');
}

export function criarEvento<K extends TipoEvento>(
  tipo: K,
  dados: { carteira: string; ativo: string; instante: number; inicioJanela?: number },
  payload: PayloadsEvento[K],
  config: ConfigMotor,
): EventoMotor<K> {
  const imediato = TIPOS_IMEDIATOS.has(tipo);
  const evento = {
    tipo,
    carteira: dados.carteira,
    ativo: dados.ativo,
    instante: dados.instante,
    payload,
    chaveDedupe: calcularChaveDedupe(
      dados.carteira,
      dados.ativo,
      tipo,
      imediato ? dados.instante : (dados.inicioJanela ?? dados.instante),
      imediato ? null : (config.bucketDedupeMs ?? null),
    ),
  };
  return evento as EventoMotor<K>;
}
