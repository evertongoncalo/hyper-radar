/*
 * Comparações numéricas tolerantes a ruído de vírgula flutuante. Os tamanhos e preços chegam da
 * API como decimais em string convertidos para double; somas e subtrações podem deixar resíduos
 * (ex.: 0.1 + 0.2) que não podem gerar eventos falsos.
 */

/** Tolerância absoluta mínima, para valores próximos de zero. */
export const EPSILON_ABSOLUTO = 1e-12;

/** `true` se `a` e `b` diferem menos do que a tolerância relativa (ou absoluta mínima). */
export function quaseIgual(a: number, b: number, toleranciaRelativa: number): boolean {
  const escala = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(EPSILON_ABSOLUTO, toleranciaRelativa * escala);
}

/** `valor ≥ limiar`, aceitando um resíduo de arredondamento abaixo do limiar. */
export function atingeLimiar(valor: number, limiar: number, toleranciaRelativa: number): boolean {
  return valor >= limiar - Math.max(EPSILON_ABSOLUTO, toleranciaRelativa * Math.abs(limiar));
}

/** Variação percentual de `atual` face a `base`; `null` se a base for (quase) zero. */
export function variacaoPct(atual: number, base: number): number | null {
  if (Math.abs(base) <= EPSILON_ABSOLUTO) return null;
  return ((atual - base) / Math.abs(base)) * 100;
}
