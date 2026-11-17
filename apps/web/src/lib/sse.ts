import {
  NOMES_EVENTOS_SSE,
  schemasEventosSse,
  type DadosEventoSse,
  type NomeEventoSse,
} from '@hyper-radar/shared';
import { PREFIXO_API } from '../api/cliente';

/** Estado da ligação SSE mostrado na UI. */
export type EstadoLigacao = 'a-ligar' | 'ligado' | 'a-reconectar' | 'desligado';

export const ESTADOS_LIGACAO_PT: Record<EstadoLigacao, string> = {
  'a-ligar': 'A ligar…',
  ligado: 'Ligado',
  'a-reconectar': 'A reconectar…',
  desligado: 'Desligado',
};

export const URL_STREAM = `${PREFIXO_API}/stream`;

export type ManipuladorSse = <N extends NomeEventoSse>(nome: N, dados: DadosEventoSse[N]) => void;

export interface OpcoesLigador {
  aoEvento: ManipuladorSse;
  /** Chamado quando a ligação volta depois de uma quebra (pode ter havido mudanças perdidas). */
  aoReligar?: () => void;
  url?: string;
  /** Atraso antes de recriar a ligação depois de o browser desistir (ms). */
  atrasoRecriar?: (tentativa: number) => number;
}

export interface LigadorSse {
  ligar(): void;
  desligar(): void;
  estado(): EstadoLigacao;
  subscrever(ouvinte: (e: EstadoLigacao) => void): () => void;
}

const ATRASO_MAXIMO_MS = 30_000;
const atrasoOmissao = (tentativa: number) => Math.min(ATRASO_MAXIMO_MS, 1000 * 2 ** tentativa);

/**
 * Ligador ao `GET /api/stream`. O browser religa sozinho (reenviando `Last-Event-ID`); se
 * desistir (ex.: resposta não-200), recria a ligação com *backoff*, pedindo os eventos em
 * falta com `?desdeId=`.
 */
export function criarLigadorSse(opcoes: OpcoesLigador): LigadorSse {
  const url = opcoes.url ?? URL_STREAM;
  const atraso = opcoes.atrasoRecriar ?? atrasoOmissao;
  const ouvintes = new Set<(e: EstadoLigacao) => void>();
  let estado: EstadoLigacao = 'desligado';
  let fonte: EventSource | null = null;
  let temporizador: ReturnType<typeof setTimeout> | null = null;
  let jaLigou = false;
  let tentativas = 0;
  let ultimoId: string | null = null;
  let ativo = false;

  const definir = (novo: EstadoLigacao) => {
    if (novo === estado) return;
    estado = novo;
    for (const o of ouvintes) o(novo);
  };

  const abrir = () => {
    const destino = ultimoId ? `${url}?desdeId=${encodeURIComponent(ultimoId)}` : url;
    const es = new EventSource(destino);
    fonte = es;
    es.onopen = () => {
      tentativas = 0;
      definir('ligado');
      if (jaLigou) opcoes.aoReligar?.();
      jaLigou = true;
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        fonte = null;
        definir('desligado');
        if (ativo) temporizador = setTimeout(abrir, atraso(tentativas++));
      } else {
        definir('a-reconectar');
      }
    };
    for (const nome of NOMES_EVENTOS_SSE) {
      es.addEventListener(nome, (m) => {
        const mensagem = m as MessageEvent<string>;
        let dados: unknown;
        try {
          dados = JSON.parse(mensagem.data);
        } catch {
          return;
        }
        const r = schemasEventosSse[nome].safeParse(dados);
        if (!r.success) return;
        if (mensagem.lastEventId) ultimoId = mensagem.lastEventId;
        opcoes.aoEvento(nome, r.data as DadosEventoSse[typeof nome]);
      });
    }
  };

  return {
    ligar() {
      if (ativo) return;
      ativo = true;
      definir(jaLigou ? 'a-reconectar' : 'a-ligar');
      abrir();
    },
    desligar() {
      ativo = false;
      if (temporizador) clearTimeout(temporizador);
      temporizador = null;
      fonte?.close();
      fonte = null;
      definir('desligado');
    },
    estado: () => estado,
    subscrever(ouvinte) {
      ouvintes.add(ouvinte);
      return () => ouvintes.delete(ouvinte);
    },
  };
}
