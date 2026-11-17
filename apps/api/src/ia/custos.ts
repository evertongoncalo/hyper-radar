import type { PrecoModeloIa } from '@hyper-radar/shared';

/*
 * Preços por 1M tokens (USD, escalão Standard, contexto curto), confirmados na página oficial
 * https://developers.openai.com/api/docs/pricing em 2026-11-17. A lista muda com frequência:
 * reconfirmar antes de alterar o modelo por omissão.
 */

/** Modelo por omissão (secção 7.2): melhor equilíbrio qualidade/custo. */
export const MODELO_IA_OMISSAO = 'gpt-6.1-sol';

export const PRECOS_MODELOS: readonly PrecoModeloIa[] = [
  { modelo: 'gpt-6.1-sol', entradaUsdPorMilhao: 2, saidaUsdPorMilhao: 10 },
  { modelo: 'gpt-6.1-terra', entradaUsdPorMilhao: 1, saidaUsdPorMilhao: 5 },
  { modelo: 'gpt-6-astra', entradaUsdPorMilhao: 10, saidaUsdPorMilhao: 50 },
];

export function precoDoModelo(modelo: string): PrecoModeloIa | null {
  return PRECOS_MODELOS.find((p) => p.modelo === modelo) ?? null;
}

export interface UsoTokens {
  tokensEntrada: number;
  tokensSaida: number;
}

/**
 * Custo estimado em USD (arredondado a 6 casas, como a coluna `numeric(14,6)`).
 * Modelo sem preço conhecido → `null` (o chamador regista um aviso).
 */
export function estimarCusto(modelo: string, uso: UsoTokens): number | null {
  const preco = precoDoModelo(modelo);
  if (!preco) return null;
  const custo =
    (uso.tokensEntrada * preco.entradaUsdPorMilhao + uso.tokensSaida * preco.saidaUsdPorMilhao) /
    1_000_000;
  return Math.round(custo * 1e6) / 1e6;
}
