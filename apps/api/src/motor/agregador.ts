import { CONFIG_OMISSAO, type ConfigMotor } from './config';
import { calcularDiff, diffPosicao, diffProtecoes, normalizarProtecao } from './diff';
import { criarEvento, type EventoMotor } from './eventos';
import { atingeLimiar } from './numeros';
import type { OrdemProtecaoMotor, PosicaoMotor, SnapshotCarteira } from './tipos';

/*
 * Limiares e agregação (debounce) por (carteira, ativo), para não alertar a cada micro-ordem de
 * baleias algorítmicas. Puro e imutável: `processarSnapshot` devolve um estado novo.
 *
 * Semântica do debounce:
 * - A referência é a posição da linha de base ou do último evento de posição emitido.
 * - OPENED/CLOSED/FLIPPED (face à referência) saem de imediato se o notional relevante for
 *   ≥ `notionalMinimoUsd`; abaixo disso é ruído (sem posição de referência fica `null`).
 * - INCREASED/REDUCED: com divergência de tamanho face à referência, emite quando a variação
 *   acumulada é significativa (≥ `limiarVariacaoPct` do tamanho de referência ou ≥
 *   `limiarVariacaoUsd`) **e** (o tamanho não mudou entre o snapshot anterior e o atual **ou**
 *   passaram `janelaAgregacaoMs` desde a primeira divergência). Se a divergência volta a zero,
 *   é descartada sem evento. Abaixo do limiar continua a acumular (a janela não reinicia).
 * - SLTP_CHANGED: o mesmo esquema face às proteções de referência, com `janelaSltpMs` e sem
 *   limiar; descartado (e a referência absorvida) quando não há posição de referência ou houve
 *   OPENED/CLOSED/FLIPPED no ciclo (as proteções seguem esses eventos no payload).
 * - LIQ_NEAR: imediato, com a histerese de `avaliarLiqNear`.
 */

interface JanelaPendente {
  /** Instante da primeira divergência face à referência. */
  desde: number;
  /** Ciclos com alteração efetiva desde `desde`. */
  ciclos: number;
}

export interface EstadoChave {
  referencia: PosicaoMotor | null;
  divergencia: JanelaPendente | null;
  protecoesReferencia: readonly OrdemProtecaoMotor[];
  sltpPendente: JanelaPendente | null;
  liqArmado: boolean;
}

export interface EstadoAgregador {
  readonly chaves: Readonly<Record<string, EstadoChave>>;
}

export interface ResultadoProcessamento {
  estado: EstadoAgregador;
  eventos: EventoMotor[];
}

export function chaveEstado(carteira: string, ativo: string): string {
  return `${carteira.toLowerCase()}|${ativo}`;
}

export function criarEstadoInicial(): EstadoAgregador {
  return { chaves: {} };
}

function linhaBase(snapshot: SnapshotCarteira, config: ConfigMotor): EstadoChave {
  return {
    referencia: snapshot.posicao,
    divergencia: null,
    protecoesReferencia: snapshot.ordensProtecao,
    sltpPendente: null,
    liqArmado: calcularDiff(null, snapshot, config).liqArmado,
  };
}

/** Avança uma janela pendente; `null` se esta é a primeira divergência. */
function avancarJanela(
  pendente: JanelaPendente | null,
  instante: number,
  mudouNoCiclo: boolean,
): JanelaPendente {
  return {
    desde: pendente?.desde ?? instante,
    ciclos: Math.max(1, (pendente?.ciclos ?? 0) + (mudouNoCiclo ? 1 : 0)),
  };
}

/**
 * Processa o snapshot atual de uma carteira/ativo. `anterior = null` ⇒ linha de base: zero
 * eventos, mas regista a referência, as proteções e o estado de `LIQ_NEAR`.
 */
export function processarSnapshot(
  estado: EstadoAgregador,
  anterior: SnapshotCarteira | null,
  atual: SnapshotCarteira,
  config: ConfigMotor = CONFIG_OMISSAO,
): ResultadoProcessamento {
  const chave = chaveEstado(atual.carteira, atual.ativo);
  const comChave = (novo: EstadoChave): EstadoAgregador => ({
    chaves: { ...estado.chaves, [chave]: novo },
  });

  if (!anterior) return { estado: comChave(linhaBase(atual, config)), eventos: [] };

  // Sem estado para esta chave (ex.: estado perdido): o snapshot anterior serve de linha de base.
  const ce = estado.chaves[chave] ?? linhaBase(anterior, config);
  const ciclo = calcularDiff(anterior, atual, config, ce.liqArmado);
  const eventos: EventoMotor[] = [];
  const base = { carteira: atual.carteira, ativo: atual.ativo, instante: atual.instante };
  const preco = atual.precoMercado;
  const protecoesAtuais = atual.ordensProtecao.map(normalizarProtecao);

  // --- Posição face à referência ------------------------------------------------------------
  let referencia = ce.referencia;
  let divergencia: JanelaPendente | null = null;
  let estrutural = false;
  const alteracao = diffPosicao(ce.referencia, atual.posicao, config);

  if (alteracao?.tipo === 'OPENED') {
    estrutural = true;
    if (
      atingeLimiar(alteracao.posicao.notional, config.notionalMinimoUsd, config.toleranciaRelativa)
    ) {
      eventos.push(
        criarEvento(
          'OPENED',
          base,
          { posicao: alteracao.posicao, protecoes: protecoesAtuais, precoMercado: preco },
          config,
        ),
      );
      referencia = alteracao.posicao;
    }
  } else if (alteracao?.tipo === 'CLOSED') {
    estrutural = true;
    const notionalFechado = alteracao.posicaoAnterior.tamanho * preco;
    if (atingeLimiar(notionalFechado, config.notionalMinimoUsd, config.toleranciaRelativa)) {
      eventos.push(
        criarEvento(
          'CLOSED',
          base,
          { posicaoAnterior: alteracao.posicaoAnterior, notionalFechado, precoMercado: preco },
          config,
        ),
      );
    }
    referencia = null;
  } else if (alteracao?.tipo === 'FLIPPED') {
    estrutural = true;
    const notional = Math.max(
      alteracao.posicaoAnterior.tamanho * preco,
      alteracao.posicao.notional,
    );
    if (atingeLimiar(notional, config.notionalMinimoUsd, config.toleranciaRelativa)) {
      eventos.push(
        criarEvento(
          'FLIPPED',
          base,
          {
            posicaoAnterior: alteracao.posicaoAnterior,
            posicao: alteracao.posicao,
            protecoes: protecoesAtuais,
            precoMercado: preco,
          },
          config,
        ),
      );
    }
    referencia = alteracao.posicao;
  } else if (alteracao) {
    const { posicaoAnterior: ref, posicao } = alteracao;
    const mudouNoCiclo = diffPosicao(anterior.posicao, atual.posicao, config) !== null;
    const janela = avancarJanela(ce.divergencia, atual.instante, mudouNoCiclo);
    const deltaAbs = Math.abs(alteracao.delta);
    const variacaoPct = (deltaAbs / ref.tamanho) * 100;
    const deltaNotional = deltaAbs * preco;
    const tol = config.toleranciaRelativa;
    const significativa =
      atingeLimiar(variacaoPct, config.limiarVariacaoPct, tol) ||
      atingeLimiar(deltaNotional, config.limiarVariacaoUsd, tol);
    const expirou = atual.instante - janela.desde >= config.janelaAgregacaoMs;
    if (significativa && (!mudouNoCiclo || expirou)) {
      eventos.push(
        criarEvento(
          alteracao.tipo,
          { ...base, inicioJanela: janela.desde },
          {
            lado: posicao.lado,
            tamanhoAnterior: ref.tamanho,
            tamanhoNovo: posicao.tamanho,
            delta: alteracao.delta,
            variacaoPct,
            deltaNotional,
            entryPxAnterior: ref.entryPx,
            entryPxNovo: posicao.entryPx,
            leverage: posicao.leverage,
            tipoMargem: posicao.tipoMargem,
            notional: posicao.notional,
            liquidationPx: posicao.liquidationPx,
            precoMercado: preco,
            ciclosConsolidados: janela.ciclos,
            inicioJanela: janela.desde,
          },
          config,
        ),
      );
      referencia = posicao;
    } else {
      divergencia = janela;
    }
  }

  // --- SL/TP face às proteções de referência ------------------------------------------------
  let protecoesReferencia = ce.protecoesReferencia;
  let sltpPendente: JanelaPendente | null = null;
  const sltp = diffProtecoes(ce.protecoesReferencia, atual.ordensProtecao, config);
  if (estrutural || referencia === null) {
    protecoesReferencia = atual.ordensProtecao;
  } else if (sltp) {
    const mudouNoCiclo =
      diffProtecoes(anterior.ordensProtecao, atual.ordensProtecao, config) !== null;
    const janela = avancarJanela(ce.sltpPendente, atual.instante, mudouNoCiclo);
    const expirou = atual.instante - janela.desde >= config.janelaSltpMs;
    if (!mudouNoCiclo || expirou) {
      eventos.push(
        criarEvento(
          'SLTP_CHANGED',
          { ...base, inicioJanela: janela.desde },
          {
            lado: referencia.lado,
            antes: sltp.antes,
            depois: sltp.depois,
            adicionadas: sltp.adicionadas,
            removidas: sltp.removidas,
            movidas: sltp.movidas,
            ciclosConsolidados: janela.ciclos,
            inicioJanela: janela.desde,
          },
          config,
        ),
      );
      protecoesReferencia = atual.ordensProtecao;
    } else {
      sltpPendente = janela;
    }
  }

  // --- Proximidade da liquidação ------------------------------------------------------------
  for (const a of ciclo.alteracoes) {
    if (a.tipo !== 'LIQ_NEAR') continue;
    eventos.push(
      criarEvento(
        'LIQ_NEAR',
        base,
        {
          lado: a.posicao.lado,
          tamanho: a.posicao.tamanho,
          notional: a.posicao.notional,
          leverage: a.posicao.leverage,
          tipoMargem: a.posicao.tipoMargem,
          liquidationPx: a.liquidationPx,
          precoMercado: a.precoMercado,
          distanciaPct: a.distanciaPct,
          limiarPct: config.liqNearPct,
        },
        config,
      ),
    );
  }

  return {
    estado: comChave({
      referencia,
      divergencia,
      protecoesReferencia,
      sltpPendente,
      liqArmado: ciclo.liqArmado,
    }),
    eventos,
  };
}
