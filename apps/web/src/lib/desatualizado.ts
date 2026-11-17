import type { AtivoResumo } from '@hyper-radar/shared';

/** Um ciclo conta como antigo se tiver mais do que este múltiplo do intervalo de recolha. */
export const FATOR_CICLO_ANTIGO = 3;
export const INTERVALO_OMISSAO_S = 60;

export interface Desatualizacao {
  desatualizado: boolean;
  /** Motivo legível (PT-PT) quando desatualizado. */
  motivo: string | null;
}

const OK: Desatualizacao = { desatualizado: false, motivo: null };
const motivo = (m: string): Desatualizacao => ({ desatualizado: true, motivo: m });

/**
 * Indicador "dados desatualizados" de um ativo em análise: carteiras com leitura falhada, último
 * ciclo falhado ou último ciclo com sucesso demasiado antigo face ao intervalo de recolha.
 */
export function avaliarDesatualizacao(
  ativo: Pick<AtivoResumo, 'estado' | 'saude'>,
  agora: number,
  intervaloS: number = INTERVALO_OMISSAO_S,
): Desatualizacao {
  if (ativo.estado !== 'running' && ativo.estado !== 'restarting') return OK;
  const s = ativo.saude;
  if (!s) return motivo('A análise não está a correr neste servidor.');
  const n = s.carteirasDesatualizadas.length;
  if (n > 0) {
    return motivo(
      n === 1 ? '1 carteira com leitura falhada.' : `${n} carteiras com leitura falhada.`,
    );
  }
  const sucesso = s.ultimoCicloSucesso ? Date.parse(s.ultimoCicloSucesso) : null;
  if (s.ultimoErro && (sucesso === null || Date.parse(s.ultimoErro.instante) > sucesso)) {
    return motivo(`Último ciclo falhou: ${s.ultimoErro.mensagem}`);
  }
  if (sucesso !== null && agora - sucesso > FATOR_CICLO_ANTIGO * intervaloS * 1000) {
    return motivo('O último ciclo com sucesso é antigo face ao intervalo de recolha.');
  }
  return OK;
}

/** Distância (%) do preço de mercado ao preço de liquidação. */
export function distanciaLiquidacaoPct(
  preco: number | null | undefined,
  liquidacao: number | null | undefined,
): number | null {
  if (!preco || liquidacao === null || liquidacao === undefined || !Number.isFinite(liquidacao)) {
    return null;
  }
  return (Math.abs(preco - liquidacao) / preco) * 100;
}
