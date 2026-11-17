import type { EventoDto } from '@hyper-radar/shared';
import {
  formatarPct,
  formatarPreco,
  formatarTamanho,
  LADO_PT,
  nomeCarteira,
  TIPOS_EVENTO_PT,
} from './formatacao';

type Registo = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const reg = (v: unknown): Registo | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Registo) : null;
const lado = (v: unknown): 'long' | 'short' | null => (v === 'long' || v === 'short' ? v : null);

/** Campos principais de um evento, extraídos do `payload` (que depende do tipo). */
export interface DadosEvento {
  lado: 'long' | 'short' | null;
  tamanho: number | null;
  entrada: number | null;
  /** Informação extra (ex.: distância à liquidação, variação). */
  extra: string | null;
}

/** Extrai lado, tamanho e preço de entrada do payload, de forma defensiva. */
export function dadosDoEvento(evento: Pick<EventoDto, 'tipo' | 'payload'>): DadosEvento {
  const p = evento.payload;
  const deposicao = (pos: Registo | null, extra: string | null = null): DadosEvento => ({
    lado: lado(pos?.lado),
    tamanho: num(pos?.tamanho),
    entrada: num(pos?.entryPx),
    extra,
  });
  switch (evento.tipo) {
    case 'OPENED':
      return deposicao(reg(p.posicao));
    case 'CLOSED':
      return deposicao(reg(p.posicaoAnterior));
    case 'FLIPPED': {
      const anterior = lado(reg(p.posicaoAnterior)?.lado);
      return deposicao(reg(p.posicao), anterior ? `antes ${LADO_PT[anterior]}` : null);
    }
    case 'INCREASED':
    case 'REDUCED': {
      const ant = num(p.tamanhoAnterior);
      return {
        lado: lado(p.lado),
        tamanho: num(p.tamanhoNovo),
        entrada: num(p.entryPxNovo),
        extra: ant === null ? null : `antes ${formatarTamanho(ant)}`,
      };
    }
    case 'LIQ_NEAR': {
      const liq = num(p.liquidationPx);
      const dist = num(p.distanciaPct);
      return {
        lado: lado(p.lado),
        tamanho: num(p.tamanho),
        entrada: null,
        extra:
          liq === null
            ? null
            : `liquidação ${formatarPreco(liq)}${dist === null ? '' : ` (${formatarPct(dist)})`}`,
      };
    }
    case 'SLTP_CHANGED': {
      const depois = Array.isArray(p.depois) ? p.depois.map(reg).filter((x) => x !== null) : [];
      const texto = depois
        .map((o) => `${String(o.tipo)} ${formatarPreco(num(o.triggerPx))}`)
        .join(', ');
      return { lado: lado(p.lado), tamanho: null, entrada: null, extra: texto || 'sem SL/TP' };
    }
  }
}

/** Resumo legível: `Long 12,5 · entrada 97 000,00 · …`. */
export function resumoEvento(evento: Pick<EventoDto, 'tipo' | 'payload'>): string {
  const d = dadosDoEvento(evento);
  const partes: string[] = [];
  if (d.lado)
    partes.push(
      d.tamanho === null ? LADO_PT[d.lado] : `${LADO_PT[d.lado]} ${formatarTamanho(d.tamanho)}`,
    );
  else if (d.tamanho !== null) partes.push(formatarTamanho(d.tamanho));
  if (d.entrada !== null) partes.push(`entrada ${formatarPreco(d.entrada)}`);
  if (d.extra) partes.push(d.extra);
  return partes.join(' · ');
}

/** Título e corpo de uma notificação de evento. */
export function textoNotificacao(evento: EventoDto): { titulo: string; corpo: string } {
  const resumo = resumoEvento(evento);
  return {
    titulo: `${evento.ticker} · ${TIPOS_EVENTO_PT[evento.tipo]}`,
    corpo: [nomeCarteira(evento), resumo].filter(Boolean).join(' — '),
  };
}

export type EstadoPermissao = NotificationPermission | 'indisponivel';

export function suportaNotificacoes(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function permissaoNotificacoes(): EstadoPermissao {
  return suportaNotificacoes() ? Notification.permission : 'indisponivel';
}

/** Pede permissão (só por ação explícita do utilizador). */
export async function pedirPermissaoNotificacoes(): Promise<EstadoPermissao> {
  if (!suportaNotificacoes()) return 'indisponivel';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Mostra uma notificação do sistema; devolve `false` se não for possível (sem suporte,
 * sem permissão ou erro), para o chamador usar o fallback in-app.
 */
export function mostrarNotificacaoSistema(evento: EventoDto, aoClicar: () => void): boolean {
  if (permissaoNotificacoes() !== 'granted') return false;
  try {
    const { titulo, corpo } = textoNotificacao(evento);
    const n = new Notification(titulo, { body: corpo, tag: `evento-${evento.id}` });
    n.onclick = () => {
      window.focus();
      aoClicar();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
