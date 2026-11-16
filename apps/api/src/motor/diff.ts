import type { ConfigMotor } from './config';
import type { ProtecaoMovida, ProtecaoNormalizada } from './eventos';
import { quaseIgual } from './numeros';
import { ordenarProtecoes, type OrdemProtecaoMotor, type PosicaoMotor } from './tipos';
import type { SnapshotCarteira } from './tipos';

/*
 * Diff bruto entre dois snapshots da mesma carteira/ativo, sem limiares nem agregação (isso cabe
 * ao agregador). Funções puras: o resultado depende apenas dos argumentos.
 */

export type AlteracaoPosicao =
  | { tipo: 'OPENED'; posicao: PosicaoMotor }
  | { tipo: 'CLOSED'; posicaoAnterior: PosicaoMotor }
  | { tipo: 'FLIPPED'; posicaoAnterior: PosicaoMotor; posicao: PosicaoMotor }
  | {
      tipo: 'INCREASED' | 'REDUCED';
      posicaoAnterior: PosicaoMotor;
      posicao: PosicaoMotor;
      /** `posicao.tamanho − posicaoAnterior.tamanho`. */
      delta: number;
    };

export interface AlteracaoSltp {
  tipo: 'SLTP_CHANGED';
  antes: ProtecaoNormalizada[];
  depois: ProtecaoNormalizada[];
  adicionadas: ProtecaoNormalizada[];
  removidas: ProtecaoNormalizada[];
  movidas: ProtecaoMovida[];
}

export interface AlteracaoLiquidacao {
  tipo: 'LIQ_NEAR';
  posicao: PosicaoMotor;
  liquidationPx: number;
  precoMercado: number;
  distanciaPct: number;
}

export type AlteracaoBruta = AlteracaoPosicao | AlteracaoSltp | AlteracaoLiquidacao;

export interface ResultadoDiff {
  alteracoes: AlteracaoBruta[];
  /** Estado da histerese de `LIQ_NEAR` após este snapshot (passar ao ciclo seguinte). */
  liqArmado: boolean;
}

/** Diff de posição; `null` se não houve alteração (tamanhos iguais dentro da tolerância). */
export function diffPosicao(
  anterior: PosicaoMotor | null,
  atual: PosicaoMotor | null,
  config: ConfigMotor,
): AlteracaoPosicao | null {
  if (!anterior && !atual) return null;
  if (!anterior && atual) return { tipo: 'OPENED', posicao: atual };
  if (anterior && !atual) return { tipo: 'CLOSED', posicaoAnterior: anterior };
  const a = anterior!;
  const b = atual!;
  if (a.lado !== b.lado) return { tipo: 'FLIPPED', posicaoAnterior: a, posicao: b };
  if (quaseIgual(a.tamanho, b.tamanho, config.toleranciaRelativa)) return null;
  return {
    tipo: b.tamanho > a.tamanho ? 'INCREASED' : 'REDUCED',
    posicaoAnterior: a,
    posicao: b,
    delta: b.tamanho - a.tamanho,
  };
}

export function normalizarProtecao(ordem: OrdemProtecaoMotor): ProtecaoNormalizada {
  return { tipo: ordem.tipo, triggerPx: ordem.triggerPx, tamanho: ordem.tamanho };
}

function tamanhosIguais(a: number | null, b: number | null, config: ConfigMotor): boolean {
  if (a === null || b === null) return a === b;
  return quaseIgual(a, b, config.toleranciaRelativa);
}

function precosIguais(a: number, b: number, config: ConfigMotor): boolean {
  const tolerancia = Math.max(config.toleranciaPrecoSltpPct / 100, config.toleranciaRelativa);
  return quaseIgual(a, b, tolerancia);
}

/**
 * Compara conjuntos normalizados de {tipo, triggerPx, tamanho} (não por `oid`). Emparelha
 * primeiro as iguais (preço dentro da tolerância); das restantes, as do mesmo tipo são
 * "movidas" (por ordem de preço) e as sobrantes adicionadas/removidas. `null` se iguais.
 */
export function diffProtecoes(
  antes: readonly OrdemProtecaoMotor[],
  depois: readonly OrdemProtecaoMotor[],
  config: ConfigMotor,
): AlteracaoSltp | null {
  const a = ordenarProtecoes(antes.map(normalizarProtecao));
  const d = ordenarProtecoes(depois.map(normalizarProtecao));
  const restantesD = [...d];
  const restantesA: ProtecaoNormalizada[] = [];
  for (const pa of a) {
    const i = restantesD.findIndex(
      (pd) =>
        pd.tipo === pa.tipo &&
        precosIguais(pa.triggerPx, pd.triggerPx, config) &&
        tamanhosIguais(pa.tamanho, pd.tamanho, config),
    );
    if (i >= 0) restantesD.splice(i, 1);
    else restantesA.push(pa);
  }
  if (restantesA.length === 0 && restantesD.length === 0) return null;

  const movidas: ProtecaoMovida[] = [];
  const removidas: ProtecaoNormalizada[] = [];
  const adicionadas: ProtecaoNormalizada[] = [];
  for (const tipo of ['SL', 'TP'] as const) {
    const ra = restantesA.filter((p) => p.tipo === tipo);
    const rd = restantesD.filter((p) => p.tipo === tipo);
    const pares = Math.min(ra.length, rd.length);
    for (let i = 0; i < pares; i++) movidas.push({ tipo, antes: ra[i]!, depois: rd[i]! });
    removidas.push(...ra.slice(pares));
    adicionadas.push(...rd.slice(pares));
  }
  return { tipo: 'SLTP_CHANGED', antes: a, depois: d, adicionadas, removidas, movidas };
}

/**
 * Distância percentual do preço de mercado ao preço de liquidação, no sentido desfavorável
 * (long: preço − liq; short: liq − preço), em % do preço de mercado. Negativa se já ultrapassou.
 * `null` sem posição, sem `liquidationPx` (ou ≤ 0) ou com preço de mercado inválido.
 */
export function distanciaLiquidacaoPct(
  posicao: PosicaoMotor | null,
  precoMercado: number,
): number | null {
  if (!posicao || posicao.liquidationPx === null || posicao.liquidationPx <= 0) return null;
  if (!(precoMercado > 0)) return null;
  const diferenca =
    posicao.lado === 'long'
      ? precoMercado - posicao.liquidationPx
      : posicao.liquidationPx - precoMercado;
  return (diferenca / precoMercado) * 100;
}

/**
 * Histerese de `LIQ_NEAR`: dispara só quando armado e a distância desce abaixo de `liqNearPct`;
 * desarma ao disparar e volta a armar quando a distância sobe a `liqRearmePct` (ou deixa de
 * haver distância — sem posição/sem liquidação).
 */
export function avaliarLiqNear(
  distanciaPct: number | null,
  armado: boolean,
  config: ConfigMotor,
): { disparar: boolean; armado: boolean } {
  if (distanciaPct === null) return { disparar: false, armado: true };
  if (armado && distanciaPct < config.liqNearPct) return { disparar: true, armado: false };
  if (!armado && distanciaPct >= config.liqRearmePct) return { disparar: false, armado: true };
  return { disparar: false, armado };
}

function validarPar(anterior: SnapshotCarteira, atual: SnapshotCarteira): void {
  if (anterior.carteira !== atual.carteira || anterior.ativo !== atual.ativo) {
    throw new Error(
      `Snapshots de chaves diferentes: ${anterior.carteira}/${anterior.ativo} e ${atual.carteira}/${atual.ativo}.`,
    );
  }
  if (anterior.instante > atual.instante) {
    throw new Error('O snapshot anterior não pode ser posterior ao atual.');
  }
}

/**
 * Diff bruto `anterior → atual`. Com `anterior = null` (linha de base) não há alterações, mas o
 * estado de `LIQ_NEAR` é inicializado. `liqArmado` é o estado da histerese vindo do ciclo
 * anterior; se omitido, deriva-se só do snapshot anterior (sem memória de rearme).
 */
export function calcularDiff(
  anterior: SnapshotCarteira | null,
  atual: SnapshotCarteira,
  config: ConfigMotor,
  liqArmado?: boolean,
): ResultadoDiff {
  const distanciaAtual = distanciaLiquidacaoPct(atual.posicao, atual.precoMercado);
  if (!anterior) {
    const liq = avaliarLiqNear(distanciaAtual, liqArmado ?? true, config);
    return { alteracoes: [], liqArmado: liq.armado };
  }
  validarPar(anterior, atual);

  const alteracoes: AlteracaoBruta[] = [];
  const posicao = diffPosicao(anterior.posicao, atual.posicao, config);
  if (posicao) alteracoes.push(posicao);
  const sltp = diffProtecoes(anterior.ordensProtecao, atual.ordensProtecao, config);
  if (sltp) alteracoes.push(sltp);

  let armado =
    liqArmado ??
    avaliarLiqNear(distanciaLiquidacaoPct(anterior.posicao, anterior.precoMercado), true, config)
      .armado;
  // Posição nova (aberta ou invertida) tem outra liquidação: a histerese recomeça armada.
  if (posicao?.tipo === 'OPENED' || posicao?.tipo === 'FLIPPED') armado = true;
  const liq = avaliarLiqNear(distanciaAtual, armado, config);
  if (liq.disparar) {
    // Disparar implica distância calculada, logo posição e `liquidationPx` presentes.
    const p = atual.posicao!;
    alteracoes.push({
      tipo: 'LIQ_NEAR',
      posicao: p,
      liquidationPx: p.liquidationPx!,
      precoMercado: atual.precoMercado,
      distanciaPct: distanciaAtual!,
    });
  }
  return { alteracoes, liqArmado: liq.armado };
}
