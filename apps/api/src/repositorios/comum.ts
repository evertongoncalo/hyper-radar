import type { Db } from '../db/client';
import { ErroValorInvalido } from './erros';

/** Instância Drizzle ou transação em curso: permite compor várias operações numa só transação. */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/*
 * Conversão numérica entre `numeric` da BD (string, sem perda) e `number` do domínio.
 * Único sítio onde esta conversão acontece. Um double tem ~15–17 algarismos significativos,
 * suficiente para análise (preços com 8+ casas decimais incluídos); nunca se assinam ordens.
 */

/** `numeric` (string) → `number`. */
export function decimalParaNumero(valor: string): number {
  const n = Number(valor);
  if (!Number.isFinite(n)) throw new ErroValorInvalido(`"${valor}" não é um número finito.`);
  return n;
}

export function decimalOuNuloParaNumero(valor: string | null): number | null {
  return valor === null ? null : decimalParaNumero(valor);
}

/** `number` → string aceite pelo `numeric` do Postgres (notação científica incluída). */
export function numeroParaDecimal(valor: number): string {
  if (!Number.isFinite(valor)) throw new ErroValorInvalido(`${valor} não é um número finito.`);
  // `-0` passaria a "0"; `String` devolve a representação mais curta que reconstrói o double.
  return String(valor === 0 ? 0 : valor);
}

export function numeroOuNuloParaDecimal(valor: number | null | undefined): string | null {
  return valor === null || valor === undefined ? null : numeroParaDecimal(valor);
}
