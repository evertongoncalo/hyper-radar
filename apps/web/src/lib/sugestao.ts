import type {
  AvisoSugestaoDto,
  NivelAviso,
  NivelProtecaoDto,
  SugestaoCarteiraDto,
} from '@hyper-radar/shared';
import { formatarNumero, formatarPct, formatarPreco, LADO_PT, nomeCarteira } from './formatacao';

/** Ordem de apresentação dos avisos: o mais grave primeiro. */
export const ORDEM_NIVEIS: readonly NivelAviso[] = ['critico', 'atencao', 'info'];

export const NIVEIS_PT: Record<NivelAviso, string> = {
  critico: 'Crítico',
  atencao: 'Atenção',
  info: 'Informação',
};

/** Avisos agrupados por nível (só os níveis com avisos), mantendo a ordem da API em cada grupo. */
export function agruparAvisos(
  avisos: readonly AvisoSugestaoDto[],
): { nivel: NivelAviso; avisos: AvisoSugestaoDto[] }[] {
  return ORDEM_NIVEIS.map((nivel) => ({
    nivel,
    avisos: avisos.filter((a) => a.nivel === nivel),
  })).filter((g) => g.avisos.length > 0);
}

/** R:R (recompensa ÷ risco) como `1 : 2,5`. */
export function formatarRR(rr: number | null | undefined): string {
  const t = formatarNumero(rr, 2);
  return t === '—' ? t : `1 : ${t}`;
}

/** Percentagem com sinal explícito, ex.: `+5,26 %` / `−3 %`. */
export function formatarPctComSinal(n: number | null | undefined, casas = 2): string {
  const t = formatarPct(n === null || n === undefined ? n : Math.abs(n), casas);
  if (t === '—' || n === 0) return t;
  return `${(n ?? 0) > 0 ? '+' : '−'}${t}`;
}

/** Quem limitou a alavancagem: o máximo do utilizador (o menor dos dois) ou o do ativo. */
export function origemLimiteAlavancagem(
  alavancagem: number,
  alavancagemMaximaUtilizador: number,
): 'utilizador' | 'ativo' {
  return alavancagem >= alavancagemMaximaUtilizador ? 'utilizador' : 'ativo';
}

function textoProtecao(nome: 'SL' | 'TP', n: NivelProtecaoDto | null): string {
  if (!n) return `${nome}: sem ${nome}`;
  return `${nome}: ${formatarPreco(n.preco)} (${formatarPctComSinal(n.distanciaPct)})`;
}

/**
 * Resumo em texto para a área de transferência (lado, tamanho, alavancagem, SL, TP). É só texto:
 * nada é enviado à exchange. `null` quando não há posição calculada.
 */
export function textoParaCopiar(item: SugestaoCarteiraDto, ticker: string): string | null {
  const { sugestao: s } = item;
  const p = s.posicao;
  if (!p || !s.lado) return null;
  return [
    `HyperRadar · ${ticker} · ${nomeCarteira(item.carteira)} (sugestão proporcional, não é uma ordem)`,
    `Lado: ${LADO_PT[s.lado]}`,
    `Tamanho: ${formatarNumero(p.tamanho, p.szDecimals)} ${ticker}`,
    `Alavancagem: ${formatarNumero(p.alavancagem, 2)}× (margem isolada)`,
    textoProtecao('SL', p.stopLoss),
    textoProtecao('TP', p.takeProfit),
    s.viavel ? null : `Inviável: ${s.motivo?.mensagem ?? 'sem motivo indicado'}`,
    s.avisoLegal,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
