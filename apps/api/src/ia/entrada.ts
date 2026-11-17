import { createHash } from 'node:crypto';
import type { MercadoAtivo } from '@hyper-radar/shared';
import type { AgregadosAtivo } from '../analise';
import type { AgregadoLado, VariacaoAgregado } from '../motor';
import type { Carteira, Definicoes, EventoDetalhado, SnapshotCompleto } from '../repositorios';

/*
 * Input JSON compacto da análise IA (secção 7.2): só números arredondados, chaves curtas e
 * rótulos curtos; nunca texto livre longo nem endereços completos (o relatório pode ser
 * partilhado). Função pura: o mesmo estado dá sempre o mesmo JSON (e o mesmo hash).
 */

/** Versão do formato do input (entra no hash: mudar o formato invalida a cache). */
export const VERSAO_ENTRADA = 1;
export const MAX_POSICOES_OMISSAO = 15;
export const MAX_EVENTOS_OMISSAO = 30;
const MAX_ZONAS = 8;
const MAX_ROTULO = 40;

export interface DadosEntradaIa {
  ticker: string;
  agregados: AgregadosAtivo;
  carteiras: Carteira[];
  /** Último snapshot de cada carteira (run atual). */
  snapshots: SnapshotCompleto[];
  /** Eventos recentes (o chamador filtra as últimas 24 h), do mais recente para o mais antigo. */
  eventos: EventoDetalhado[];
  /** Contexto de mercado (`metaAndAssetCtxs`); `null` se indisponível. */
  mercado: MercadoAtivo | null;
  definicoes: Definicoes;
  maxPosicoes?: number;
  maxEventos?: number;
}

type Valor = number | string | boolean | null | Valor[] | { [k: string]: Valor };
export type EntradaIa = { [k: string]: Valor };

// ------------------------------------------------------------------ arredondamentos

/** `n` algarismos significativos; não finito → `null`. */
export function sig(x: number | null | undefined, n = 5): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  if (x === 0) return 0;
  return Number(x.toPrecision(n));
}

/** Casas decimais fixas (percentagens, alavancagem); não finito → `null`. */
export function casas(x: number | null | undefined, d = 1): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}

/** `0x1234…abcd`: suficiente para distinguir carteiras sem expor o endereço completo. */
export function abreviarEndereco(endereco: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(endereco)
    ? `${endereco.slice(0, 6)}…${endereco.slice(-4)}`.toLowerCase()
    : endereco.slice(0, MAX_ROTULO);
}

/** Alias do utilizador (dado, nunca instrução) ou endereço abreviado. */
export function rotuloCarteira(c: { endereco: string; alias: string | null }): string {
  const alias = c.alias?.replace(/\s+/g, ' ').trim();
  return alias ? alias.slice(0, MAX_ROTULO) : abreviarEndereco(c.endereco);
}

const minutoIso = (d: Date) => `${d.toISOString().slice(0, 16)}Z`;

// ------------------------------------------------------------------ blocos

function lado(l: AgregadoLado): EntradaIa {
  return {
    n: l.carteiras,
    sz: sig(l.tamanho),
    ntl: sig(l.notionalUsd, 4),
    e: sig(l.entradaMedia),
    lev: casas(l.alavancagemMedia),
  };
}

function variacao(v: VariacaoAgregado | null): EntradaIa | null {
  if (!v) return null;
  return {
    h: v.intervaloMs === null ? null : casas(v.intervaloMs / 3_600_000),
    net: sig(v.netUsd.absoluta, 4),
    netPct: casas(v.netUsd.pct),
    lPct: casas(v.longUsd.pct),
    sPct: casas(v.shortUsd.pct),
    nL: v.carteirasLong,
    nS: v.carteirasShort,
    pxPct: v.precoReferencia ? casas(v.precoReferencia.pct, 2) : null,
  };
}

function mercado(m: MercadoAtivo | null): EntradaIa | null {
  if (!m) return null;
  return {
    mark: sig(m.markPx),
    oracle: sig(m.oraclePx),
    // Funding horário (fração), como a Hyperliquid o devolve.
    fund: sig(m.funding, 3),
    oi: sig(m.openInterest, 4),
    oiUsd: sig(m.openInterest * m.markPx, 4),
    vol24: sig(m.dayNtlVlm, 4),
    d24Pct: m.prevDayPx > 0 ? casas(((m.markPx - m.prevDayPx) / m.prevDayPx) * 100, 2) : null,
    maxLev: m.maxLeverage,
  };
}

const num = (o: unknown, ...caminho: string[]): number | null => {
  let atual: unknown = o;
  for (const c of caminho) {
    if (typeof atual !== 'object' || atual === null) return null;
    atual = (atual as Record<string, unknown>)[c];
  }
  return typeof atual === 'number' && Number.isFinite(atual) ? atual : null;
};

const ladoCurto = (o: unknown, ...caminho: string[]): string | null => {
  let atual: unknown = o;
  for (const c of caminho) {
    if (typeof atual !== 'object' || atual === null) return null;
    atual = (atual as Record<string, unknown>)[c];
  }
  return atual === 'long' ? 'L' : atual === 'short' ? 'S' : null;
};

const precosProtecao = (lista: unknown, tipo: 'SL' | 'TP'): number[] =>
  Array.isArray(lista)
    ? lista.flatMap((p) => {
        const px = num(p, 'triggerPx');
        return (p as { tipo?: unknown }).tipo === tipo && px !== null ? [sig(px)!] : [];
      })
    : [];

/** Só os números relevantes de cada tipo de evento (o payload completo é longo). */
function resumoPayload(e: EventoDetalhado): EntradaIa {
  const p = e.payload;
  switch (e.tipo) {
    case 'OPENED':
      return {
        l: ladoCurto(p, 'posicao', 'lado'),
        sz: sig(num(p, 'posicao', 'tamanho')),
        e: sig(num(p, 'posicao', 'entryPx')),
        px: sig(num(p, 'precoMercado')),
      };
    case 'CLOSED':
      return {
        l: ladoCurto(p, 'posicaoAnterior', 'lado'),
        ntl: sig(num(p, 'notionalFechado'), 4),
        px: sig(num(p, 'precoMercado')),
      };
    case 'INCREASED':
    case 'REDUCED':
      return {
        l: ladoCurto(p, 'lado'),
        d: sig(num(p, 'delta')),
        dPct: casas(num(p, 'variacaoPct')),
        ntl: sig(num(p, 'notional'), 4),
        px: sig(num(p, 'precoMercado')),
      };
    case 'FLIPPED':
      return {
        l: ladoCurto(p, 'posicao', 'lado'),
        sz: sig(num(p, 'posicao', 'tamanho')),
        px: sig(num(p, 'precoMercado')),
      };
    case 'SLTP_CHANGED':
      return {
        l: ladoCurto(p, 'lado'),
        sl: precosProtecao(p['depois'], 'SL'),
        tp: precosProtecao(p['depois'], 'TP'),
      };
    case 'LIQ_NEAR':
      return {
        l: ladoCurto(p, 'lado'),
        liq: sig(num(p, 'liquidationPx')),
        dPct: casas(num(p, 'distanciaPct'), 2),
      };
  }
}

// ------------------------------------------------------------------ input

export function construirEntrada(dados: DadosEntradaIa): EntradaIa {
  const { atual } = dados.agregados;
  const porId = new Map(dados.carteiras.map((c) => [c.id, c]));
  const enderecos = new Map(dados.carteiras.map((c) => [c.endereco.toLowerCase(), c]));
  const rotuloDe = (endereco: string) => {
    const c = enderecos.get(endereco.toLowerCase());
    return c ? rotuloCarteira(c) : abreviarEndereco(endereco);
  };

  const posicoes = dados.snapshots
    .flatMap((s) => {
      const c = porId.get(s.walletId);
      return c && s.posicao ? [{ s, c, p: s.posicao }] : [];
    })
    .sort((a, b) => b.p.notional - a.p.notional || a.c.id - b.c.id)
    .slice(0, dados.maxPosicoes ?? MAX_POSICOES_OMISSAO)
    .map(({ s, c, p }) => ({
      w: rotuloCarteira(c),
      ent: c.entidade ? c.entidade.slice(0, MAX_ROTULO) : null,
      l: p.lado === 'long' ? 'L' : 'S',
      sz: sig(p.tamanho),
      ntl: sig(p.notional, 4),
      e: sig(p.entryPx),
      lev: casas(p.alavancagem),
      mg: p.tipoMargem === 'cross' ? 'cross' : 'iso',
      liq: sig(p.liquidationPx),
      upnl: sig(p.unrealizedPnl, 4),
      sl: s.ordens.filter((o) => o.tipo === 'SL').map((o) => sig(o.triggerPx)),
      tp: s.ordens.filter((o) => o.tipo === 'TP').map((o) => sig(o.triggerPx)),
      av: sig(s.accountValue, 4),
      // `false` em conta unificada: o accountValue não representa o colateral real.
      avRep: s.accountValueRepresentativo,
    }));

  // Zonas com mais notional (até MAX_ZONAS), apresentadas por preço.
  const zonas = [...atual.zonasLiquidacao]
    .sort((a, b) => b.notional - a.notional || a.preco - b.preco)
    .slice(0, MAX_ZONAS)
    .sort((a, b) => a.preco - b.preco)
    .map((z) => ({
      px: sig(z.preco),
      l: z.lado === 'long' ? 'L' : 'S',
      ntl: sig(z.notional, 4),
      dPct: casas(z.distanciaPct),
      n: z.carteiras.length,
    }));

  const hedges = atual.entidades
    .filter((e) => e.hedgeInterno)
    .map((e) => ({
      ent: rotuloDe(e.entidade),
      L: sig(e.longUsd, 4),
      S: sig(e.shortUsd, 4),
    }));

  const eventos = dados.eventos.slice(0, dados.maxEventos ?? MAX_EVENTOS_OMISSAO).map((e) => ({
    t: e.tipo,
    w: rotuloCarteira(e),
    em: minutoIso(e.criadoEm),
    ...resumoPayload(e),
  }));

  return {
    v: VERSAO_ENTRADA,
    at: dados.ticker,
    px: sig(dados.mercado?.markPx ?? atual.precoReferencia),
    mk: mercado(dados.mercado),
    ag: {
      n: atual.totalCarteiras,
      sp: atual.carteirasSemPosicao,
      L: lado(atual.long),
      S: lado(atual.short),
      net: sig(atual.netUsd, 4),
      lev: casas(atual.alavancagemMedia),
      liq: zonas,
      hedge: hedges,
    },
    v1h: variacao(dados.agregados.variacao1h),
    v24h: variacao(dados.agregados.variacao24h),
    pos: posicoes,
    ev: eventos,
    def: {
      cap: sig(dados.definicoes.capitalUsd, 6),
      levMax: dados.definicoes.alavancagemMaxima,
      riscoPct: casas(dados.definicoes.riscoPorOperacaoPct, 2),
    },
  };
}

// ------------------------------------------------------------------ hash

/** JSON canónico: chaves ordenadas recursivamente, sem `undefined`, sem espaços. */
export function jsonCanonico(valor: unknown): string {
  return JSON.stringify(ordenar(valor));
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.keys(valor)
        .filter((k) => (valor as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, ordenar((valor as Record<string, unknown>)[k])]),
    );
  }
  return valor;
}

/** SHA-256 (hex) do JSON canónico do input e da versão do prompt. */
export function hashEntrada(entrada: EntradaIa, versaoPrompt: number): string {
  return createHash('sha256')
    .update(jsonCanonico({ entrada, prompt: versaoPrompt }))
    .digest('hex');
}
