import type { DexPerp, MetaDex } from '@hyper-radar/shared';
import type { ServicoAnalise } from '../analise';
import type { Db } from '../db/client';
import type { Relogio } from '../hyperliquid';

/** Leituras de mercado de que as rotas precisam (o `ClienteHyperliquid` satisfaz; falso nos testes). */
export interface FonteMercadoHyperliquid {
  perpDexs(): Promise<DexPerp[]>;
  meta(dex?: string | null): Promise<MetaDex>;
  allMids(dex?: string | null): Promise<Record<string, number>>;
}

/** Dependências injetadas nos plugins de rotas. */
export interface DependenciasRotas {
  db: Db;
  analise: ServicoAnalise;
  cliente: FonteMercadoHyperliquid;
  relogio: Relogio;
  /** Tempo máximo à espera do preço de mercado no detalhe do ativo (depois usa o snapshot). */
  timeoutPrecoMs: number;
  /** Intervalo do heartbeat SSE. */
  heartbeatSseMs: number;
}
