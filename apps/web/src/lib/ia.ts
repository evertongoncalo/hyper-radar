import type { EstadoIa, PrecoModeloIa, RelatorioIa } from '@hyper-radar/shared';
import { ErroApi } from '../api/cliente';
import { formatarNumero, formatarUsd } from './formatacao';

/** Textos dos enums do relatório IA. */
export const VIES_PT: Record<RelatorioIa['vies'], string> = {
  alta: 'Alta',
  baixa: 'Baixa',
  neutro: 'Neutro',
  misto: 'Misto',
};

export const ALINHAMENTO_PT: Record<RelatorioIa['alinhamento_baleias']['nivel'], string> = {
  forte: 'Forte',
  moderado: 'Moderado',
  fraco: 'Fraco',
  divergente: 'Divergente',
  sem_dados: 'Sem dados',
};

/**
 * Tokens de referência para a estimativa antes de analisar (sem histórico): um input compacto
 * típico e uma resposta estruturada completa. É só uma ordem de grandeza.
 */
export const TOKENS_REFERENCIA = { entrada: 6_000, saida: 3_000 } as const;

export function precoDoModelo(estado: EstadoIa | undefined): PrecoModeloIa | null {
  if (!estado?.modeloComPreco) return null;
  return estado.precos.find((p) => p.modelo === estado.modelo) ?? null;
}

/** Custo estimado (USD) de uma chamada; `null` sem preço conhecido. */
export function estimarCustoUsd(
  preco: PrecoModeloIa | null,
  tokens: { entrada: number; saida: number } = TOKENS_REFERENCIA,
): number | null {
  if (!preco) return null;
  return (
    (tokens.entrada * preco.entradaUsdPorMilhao + tokens.saida * preco.saidaUsdPorMilhao) / 1e6
  );
}

/** USD para custos de IA (valores pequenos com mais casas), ex.: `0,0350 US$`. */
export function formatarCustoIa(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'por estimar';
  if (n === 0) return formatarUsd(0, 2);
  return formatarUsd(n, Math.abs(n) < 0.01 ? 4 : n < 1 ? 3 : 2);
}

/** Uso face a um limite (0 = sem limite), ex.: `3 / 10` ou `3 (sem limite)`. */
export function formatarUsoLimite(usado: number, limite: number): string {
  const u = formatarNumero(usado, 0);
  return limite > 0 ? `${u} / ${formatarNumero(limite, 0)}` : `${u} (sem limite)`;
}

/** Algum limite diário já atingido (o servidor decide; isto é só um aviso prévio). */
export function limiteAtingido(hoje: EstadoIa['hoje']): boolean {
  return (
    (hoje.limiteChamadas > 0 && hoje.chamadas >= hoje.limiteChamadas) ||
    (hoje.limiteTokens > 0 && hoje.tokens >= hoje.limiteTokens)
  );
}

/** Distância percentual de um preço ao preço atual; `null` sem preço atual válido. */
export function distanciaPct(preco: number, atual: number | null | undefined): number | null {
  if (atual === null || atual === undefined || !Number.isFinite(atual) || atual === 0) return null;
  return ((preco - atual) / atual) * 100;
}

export interface ErroIaDescrito {
  titulo: string;
  mensagem: string;
  /** Mostrar ligação para Definições (limites diários). */
  ligacaoDefinicoes: boolean;
}

/** Título claro para cada erro da Análise IA (a mensagem vem da API, já em PT-PT). */
export function descreverErroIa(erro: unknown): ErroIaDescrito {
  const mensagem = erro instanceof Error && erro.message ? erro.message : 'Erro inesperado.';
  const base = { mensagem, ligacaoDefinicoes: false };
  if (!(erro instanceof ErroApi)) return { ...base, titulo: 'Não foi possível analisar.' };
  switch (erro.codigo) {
    case 'IA_NAO_CONFIGURADA':
      return { ...base, titulo: 'Análise IA não configurada.' };
    case 'LIMITE_IA_ATINGIDO':
      return { ...base, titulo: 'Limite diário da Análise IA atingido.', ligacaoDefinicoes: true };
    case 'IA_RECUSA':
      return { ...base, titulo: 'O modelo recusou responder a este pedido.' };
    case 'IA_RESPOSTA_INVALIDA':
      return { ...base, titulo: 'O modelo devolveu uma resposta inválida (não foi gravada).' };
    case 'IA_INDISPONIVEL':
      return {
        ...base,
        titulo:
          erro.estado === 504
            ? 'A OpenAI demorou demasiado a responder.'
            : 'Serviço de IA indisponível de momento.',
      };
    default:
      return { ...base, titulo: 'Não foi possível analisar.' };
  }
}
