import type { LadoPosicao } from '@hyper-radar/shared';
import { EPSILON_ABSOLUTO, variacaoPct } from './numeros';
import type { SnapshotCarteira } from './tipos';

/*
 * Agregados por ativo a partir dos snapshots de um mesmo ciclo (secção 6.2) e agrupamento por
 * entidade com deteção de hedge interno (secção 12). Funções puras.
 */

export interface AgregadoLado {
  carteiras: number;
  /** Soma dos tamanhos absolutos (unidades do ativo). */
  tamanho: number;
  notionalUsd: number;
  /** Preço médio de entrada ponderado pelo tamanho; `null` sem posições. */
  entradaMedia: number | null;
  /** Alavancagem média ponderada pelo notional; `null` sem posições. */
  alavancagemMedia: number | null;
}

export interface ZonaLiquidacao {
  preco: number;
  lado: LadoPosicao;
  notional: number;
  carteiras: string[];
  /** Distância (com sinal) ao preço de referência, em %. */
  distanciaPct: number;
  /**
   * Notional acumulado do mesmo lado desde o preço de referência até esta zona (longs a descer,
   * shorts a subir): quanto seria liquidado se o preço lá chegasse.
   */
  notionalAcumulado: number;
}

export interface BucketLiquidacao {
  /** Intervalo `[inicioPct, fimPct)` de distância ao preço de referência. */
  inicioPct: number;
  fimPct: number;
  notionalLong: number;
  notionalShort: number;
  notional: number;
  carteiras: number;
}

export interface AgregadoEntidade {
  entidade: string;
  carteiras: string[];
  longUsd: number;
  shortUsd: number;
  netUsd: number;
  /** A mesma entidade tem carteiras long e short no ativo. */
  hedgeInterno: boolean;
  /** Notional compensado entre as pernas (`min(long, short)`). */
  notionalHedgeado: number;
}

export interface AgregadoAtivo {
  ativo: string;
  /** Instante mais recente entre os snapshots; `null` sem snapshots. */
  instante: number | null;
  /** Mediana dos preços de mercado (ou o fornecido); `null` sem preço válido. */
  precoReferencia: number | null;
  totalCarteiras: number;
  carteirasSemPosicao: number;
  long: AgregadoLado;
  short: AgregadoLado;
  /** Notional long − notional short (USD). */
  netUsd: number;
  alavancagemMedia: number | null;
  /** Ordenadas por preço ascendente. */
  zonasLiquidacao: ZonaLiquidacao[];
  /** Por entidade (carteira sem entidade = entidade própria), ordenadas por nome. */
  entidades: AgregadoEntidade[];
  entidadesComHedge: number;
}

export interface OpcoesAgregados {
  /** Mapa carteira → entidade (chaves comparadas em minúsculas). */
  entidades?: Readonly<Record<string, string>>;
  /** Preço de referência explícito (omissão: mediana dos `precoMercado`). */
  precoReferencia?: number;
}

function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null;
  const v = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[meio]! : (v[meio - 1]! + v[meio]!) / 2;
}

function agregarLado(snapshots: SnapshotCarteira[], lado: LadoPosicao): AgregadoLado {
  const posicoes = snapshots.flatMap((s) => (s.posicao?.lado === lado ? [s.posicao] : []));
  const tamanho = posicoes.reduce((t, p) => t + p.tamanho, 0);
  const notionalUsd = posicoes.reduce((t, p) => t + p.notional, 0);
  return {
    carteiras: posicoes.length,
    tamanho,
    notionalUsd,
    entradaMedia:
      tamanho > EPSILON_ABSOLUTO
        ? posicoes.reduce((t, p) => t + p.entryPx * p.tamanho, 0) / tamanho
        : null,
    alavancagemMedia:
      notionalUsd > EPSILON_ABSOLUTO
        ? posicoes.reduce((t, p) => t + p.leverage * p.notional, 0) / notionalUsd
        : null,
  };
}

function calcularZonas(snapshots: SnapshotCarteira[], preco: number | null): ZonaLiquidacao[] {
  if (preco === null) return [];
  const porChave = new Map<string, ZonaLiquidacao>();
  for (const s of snapshots) {
    const p = s.posicao;
    if (!p || p.liquidationPx === null || p.liquidationPx <= 0) continue;
    const chave = `${p.lado}|${p.liquidationPx}`;
    const zona = porChave.get(chave) ?? {
      preco: p.liquidationPx,
      lado: p.lado,
      notional: 0,
      carteiras: [],
      distanciaPct: ((p.liquidationPx - preco) / preco) * 100,
      notionalAcumulado: 0,
    };
    zona.notional += p.notional;
    zona.carteiras.push(s.carteira);
    porChave.set(chave, zona);
  }
  const zonas = [...porChave.values()].sort(
    (a, b) => a.preco - b.preco || a.lado.localeCompare(b.lado),
  );
  for (const z of zonas) z.carteiras.sort();
  // Acumulado a partir do preço de referência, para fora, em cada lado.
  for (const lado of ['long', 'short'] as const) {
    const doLado = zonas.filter((z) => z.lado === lado);
    if (lado === 'long') doLado.reverse();
    let acumulado = 0;
    for (const z of doLado) {
      acumulado += z.notional;
      z.notionalAcumulado = acumulado;
    }
  }
  return zonas;
}

function calcularEntidades(
  snapshots: SnapshotCarteira[],
  mapa: Readonly<Record<string, string>>,
): AgregadoEntidade[] {
  const normalizado = new Map(Object.entries(mapa).map(([c, e]) => [c.toLowerCase(), e]));
  const porEntidade = new Map<string, AgregadoEntidade>();
  for (const s of snapshots) {
    const nome = normalizado.get(s.carteira.toLowerCase()) ?? s.carteira;
    const e = porEntidade.get(nome) ?? {
      entidade: nome,
      carteiras: [],
      longUsd: 0,
      shortUsd: 0,
      netUsd: 0,
      hedgeInterno: false,
      notionalHedgeado: 0,
    };
    e.carteiras.push(s.carteira);
    if (s.posicao?.lado === 'long') e.longUsd += s.posicao.notional;
    if (s.posicao?.lado === 'short') e.shortUsd += s.posicao.notional;
    porEntidade.set(nome, e);
  }
  return [...porEntidade.values()]
    .map((e) => ({
      ...e,
      carteiras: [...e.carteiras].sort(),
      netUsd: e.longUsd - e.shortUsd,
      hedgeInterno: e.longUsd > EPSILON_ABSOLUTO && e.shortUsd > EPSILON_ABSOLUTO,
      notionalHedgeado: Math.min(e.longUsd, e.shortUsd),
    }))
    .sort((a, b) => a.entidade.localeCompare(b.entidade));
}

/** Agregados de um ativo para os snapshots de um ciclo (uma entrada por carteira). */
export function calcularAgregados(
  ativo: string,
  snapshots: readonly SnapshotCarteira[],
  opcoes: OpcoesAgregados = {},
): AgregadoAtivo {
  const lista = [...snapshots];
  const vistas = new Set<string>();
  for (const s of lista) {
    if (s.ativo !== ativo) throw new Error(`Snapshot de ${s.ativo} no agregado de ${ativo}.`);
    const c = s.carteira.toLowerCase();
    if (vistas.has(c)) throw new Error(`Carteira repetida no ciclo: ${s.carteira}.`);
    vistas.add(c);
  }
  const precoReferencia =
    opcoes.precoReferencia ?? mediana(lista.map((s) => s.precoMercado).filter((p) => p > 0));
  const long = agregarLado(lista, 'long');
  const short = agregarLado(lista, 'short');
  const notionalTotal = long.notionalUsd + short.notionalUsd;
  const entidades = calcularEntidades(lista, opcoes.entidades ?? {});
  return {
    ativo,
    instante: lista.length > 0 ? Math.max(...lista.map((s) => s.instante)) : null,
    precoReferencia,
    totalCarteiras: lista.length,
    carteirasSemPosicao: lista.filter((s) => !s.posicao).length,
    long,
    short,
    netUsd: long.notionalUsd - short.notionalUsd,
    alavancagemMedia:
      notionalTotal > EPSILON_ABSOLUTO
        ? ((long.alavancagemMedia ?? 0) * long.notionalUsd +
            (short.alavancagemMedia ?? 0) * short.notionalUsd) /
          notionalTotal
        : null,
    zonasLiquidacao: calcularZonas(lista, precoReferencia),
    entidades,
    entidadesComHedge: entidades.filter((e) => e.hedgeInterno).length,
  };
}

/** Agrupa as zonas de liquidação em buckets de `bucketPct` % de distância ao preço. */
export function agruparZonasLiquidacao(
  zonas: readonly ZonaLiquidacao[],
  bucketPct: number,
): BucketLiquidacao[] {
  if (!(bucketPct > 0)) throw new Error('O bucket de liquidação tem de ser positivo.');
  const buckets = new Map<number, BucketLiquidacao & { conjunto: Set<string> }>();
  for (const z of zonas) {
    // Arredondamento prévio evita que 2.0000000001 / 1 caia no bucket seguinte por ruído.
    const indice = Math.floor(Number((z.distanciaPct / bucketPct).toFixed(9)));
    const b = buckets.get(indice) ?? {
      inicioPct: indice * bucketPct,
      fimPct: (indice + 1) * bucketPct,
      notionalLong: 0,
      notionalShort: 0,
      notional: 0,
      carteiras: 0,
      conjunto: new Set<string>(),
    };
    if (z.lado === 'long') b.notionalLong += z.notional;
    else b.notionalShort += z.notional;
    b.notional += z.notional;
    for (const c of z.carteiras) b.conjunto.add(c);
    b.carteiras = b.conjunto.size;
    buckets.set(indice, b);
  }
  return [...buckets.values()]
    .sort((a, b) => a.inicioPct - b.inicioPct)
    .map((b) => ({
      inicioPct: b.inicioPct,
      fimPct: b.fimPct,
      notionalLong: b.notionalLong,
      notionalShort: b.notionalShort,
      notional: b.notional,
      carteiras: b.carteiras,
    }));
}

export interface Delta {
  absoluta: number;
  /** `null` quando o valor passado é (quase) zero. */
  pct: number | null;
}

export interface VariacaoAgregado {
  /** Diferença de instantes (ms); `null` se algum agregado não tiver instante. */
  intervaloMs: number | null;
  netUsd: Delta;
  longUsd: Delta;
  shortUsd: Delta;
  carteirasLong: number;
  carteirasShort: number;
  entradaMediaLong: Delta | null;
  entradaMediaShort: Delta | null;
  alavancagemMedia: Delta | null;
  precoReferencia: Delta | null;
}

function delta(atual: number, passado: number): Delta {
  return { absoluta: atual - passado, pct: variacaoPct(atual, passado) };
}

function deltaOpcional(atual: number | null, passado: number | null): Delta | null {
  return atual === null || passado === null ? null : delta(atual, passado);
}

/**
 * Variação de um agregado face a um agregado passado (ex.: há 1 h / 24 h, fornecido pelo
 * chamador). `null` se não houver agregado passado.
 */
export function calcularVariacao(
  atual: AgregadoAtivo,
  passado: AgregadoAtivo | null,
): VariacaoAgregado | null {
  if (!passado) return null;
  if (atual.ativo !== passado.ativo) {
    throw new Error(`Agregados de ativos diferentes: ${atual.ativo} e ${passado.ativo}.`);
  }
  return {
    intervaloMs:
      atual.instante === null || passado.instante === null
        ? null
        : atual.instante - passado.instante,
    netUsd: delta(atual.netUsd, passado.netUsd),
    longUsd: delta(atual.long.notionalUsd, passado.long.notionalUsd),
    shortUsd: delta(atual.short.notionalUsd, passado.short.notionalUsd),
    carteirasLong: atual.long.carteiras - passado.long.carteiras,
    carteirasShort: atual.short.carteiras - passado.short.carteiras,
    entradaMediaLong: deltaOpcional(atual.long.entradaMedia, passado.long.entradaMedia),
    entradaMediaShort: deltaOpcional(atual.short.entradaMedia, passado.short.entradaMedia),
    alavancagemMedia: deltaOpcional(atual.alavancagemMedia, passado.alavancagemMedia),
    precoReferencia: deltaOpcional(atual.precoReferencia, passado.precoReferencia),
  };
}
