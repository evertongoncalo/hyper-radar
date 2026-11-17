import { fileURLToPath } from 'node:url';

// Constantes partilhadas pela configuração, pelo setup global e pelos testes E2E.

export const RAIZ = fileURLToPath(new URL('..', import.meta.url));

/** Portas locais (fixas, configuráveis): API compilada e servidor falso Hyperliquid/OpenAI. */
export const PORTA_API = Number(process.env.E2E_PORTA_API ?? 3210);
export const PORTA_FALSO = Number(process.env.E2E_PORTA_FALSO ?? 3211);

export const URL_API = `http://127.0.0.1:${PORTA_API}`;
export const URL_FALSO = `http://127.0.0.1:${PORTA_FALSO}`;

/**
 * Base dedicada aos E2E (criada e apagada pelo setup). Por segurança o nome tem de terminar
 * em `_e2e`: nunca se toca na base de desenvolvimento nem na dos testes de integração.
 */
export const URL_BD_E2E =
  process.env.E2E_DATABASE_URL ?? 'postgres://hyperradar:hyperradar@127.0.0.1:5432/hyperradar_e2e';

/** Chave fictícia: só chega ao servidor falso (nunca à OpenAI real). */
export const CHAVE_OPENAI_FALSA = 'chave-falsa-apenas-e2e';

export type FaseBaleia = 'sem-posicao' | 'long-aberta';

export interface RegistoFalso {
  /** Pedidos `POST /info` por `type`. */
  info: Record<string, number>;
  /** Pedidos `POST /v1/responses`. */
  openai: number;
  /** Pedidos a rotas desconhecidas (deviam ser 0). */
  desconhecidos: number;
}
