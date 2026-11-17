import type {
  AgregadosAtivoResposta,
  AtivoDetalhe,
  AtivoResumo,
  CarteiraComAtivosDto,
  CarteiraNoAtivo,
  DefinicoesDto,
  EventoDto,
  PaginaEventosDto,
  RespostaSugestao,
  SugestaoCarteiraDto,
  SugestaoProporcionalDto,
} from '@hyper-radar/shared';

// Dados fictícios para os testes (endereços inventados).
export const E1 = `0x${'a'.repeat(40)}`;
export const E2 = `0x${'b'.repeat(40)}`;

export const INSTANTE = '2026-11-17T12:00:00.000Z';

export function ativoResumo(extra: Partial<AtivoResumo> = {}): AtivoResumo {
  return {
    id: 1,
    ticker: 'BTC',
    dex: null,
    estado: 'idle',
    criadoEm: INSTANTE,
    numeroCarteiras: 2,
    eventosNaoLidos: 3,
    saude: null,
    ...extra,
  };
}

export function carteiraNoAtivo(extra: Partial<CarteiraNoAtivo> = {}): CarteiraNoAtivo {
  return {
    id: 10,
    endereco: E1,
    alias: 'Baleia A',
    entidade: 'Fundo X',
    desatualizada: false,
    ultimoSnapshot: {
      instante: INSTANTE,
      runId: 1,
      accountValue: 1_000_000,
      accountValueRepresentativo: true,
      modoConta: null,
      precoMercado: 100_000,
      posicao: {
        lado: 'long',
        tamanho: 12.5,
        entryPx: 95_000,
        alavancagem: 10,
        tipoMargem: 'cross',
        liquidationPx: 80_000,
        unrealizedPnl: 62_500,
        marginUsed: 125_000,
        notional: 1_250_000,
      },
      ordens: [
        { tipo: 'SL', triggerPx: 90_000, tamanho: null, reduceOnly: true },
        { tipo: 'TP', triggerPx: 120_000, tamanho: 5, reduceOnly: true },
      ],
    },
    ...extra,
  };
}

export function ativoDetalhe(extra: Partial<AtivoDetalhe> = {}): AtivoDetalhe {
  return {
    ...ativoResumo({ estado: 'running' }),
    precoMercado: { valor: 100_000, instante: INSTANTE, fonte: 'hyperliquid' },
    carteiras: [
      carteiraNoAtivo(),
      carteiraNoAtivo({
        id: 11,
        endereco: E2,
        alias: null,
        entidade: null,
        desatualizada: true,
        ultimoSnapshot: {
          ...carteiraNoAtivo().ultimoSnapshot!,
          accountValueRepresentativo: false,
          posicao: null,
          ordens: [],
        },
      }),
    ],
    ...extra,
  };
}

export function agregados(): AgregadosAtivoResposta {
  const lado = (carteiras: number, notionalUsd: number) => ({
    carteiras,
    tamanho: notionalUsd / 100_000,
    notionalUsd,
    entradaMedia: 95_000,
    alavancagemMedia: 10,
  });
  return {
    atual: {
      ativo: 'BTC',
      instante: INSTANTE,
      precoReferencia: 100_000,
      totalCarteiras: 2,
      carteirasSemPosicao: 1,
      long: lado(1, 1_250_000),
      short: lado(0, 0),
      netUsd: 1_250_000,
      alavancagemMedia: 10,
      zonasLiquidacao: [
        {
          preco: 80_000,
          lado: 'long',
          notional: 1_250_000,
          carteiras: [E1],
          distanciaPct: 20,
          notionalAcumulado: 1_250_000,
        },
      ],
      entidades: [
        {
          entidade: 'Fundo X',
          carteiras: [E1],
          longUsd: 1_250_000,
          shortUsd: 0,
          netUsd: 1_250_000,
          hedgeInterno: true,
          notionalHedgeado: 50_000,
        },
      ],
      entidadesComHedge: 1,
    },
    variacao1h: {
      intervaloMs: 3_600_000,
      netUsd: { absoluta: 250_000, pct: 25 },
      longUsd: { absoluta: 250_000, pct: 25 },
      shortUsd: { absoluta: 0, pct: null },
      carteirasLong: 1,
      carteirasShort: 0,
      entradaMediaLong: null,
      entradaMediaShort: null,
      alavancagemMedia: null,
      precoReferencia: { absoluta: 1000, pct: 1 },
    },
    variacao24h: null,
  };
}

export function evento(extra: Partial<EventoDto> = {}): EventoDto {
  return {
    id: 100,
    tipo: 'OPENED',
    assetId: 1,
    walletId: 10,
    runId: 1,
    ticker: 'BTC',
    endereco: E1,
    alias: 'Baleia A',
    payload: {
      posicao: { lado: 'long', tamanho: 12.5, entryPx: 95_000, leverage: 10 },
      protecoes: [],
      precoMercado: 100_000,
    },
    lido: false,
    criadoEm: INSTANTE,
    ...extra,
  };
}

export function pagina(itens: EventoDto[], proximoCursor: number | null = null): PaginaEventosDto {
  return { itens, proximoCursor };
}

export function carteiraGlobal(extra: Partial<CarteiraComAtivosDto> = {}): CarteiraComAtivosDto {
  return {
    id: 10,
    endereco: E1,
    alias: 'Baleia A',
    entidade: 'Fundo X',
    criadoEm: INSTANTE,
    ativos: [{ id: 1, ticker: 'BTC' }],
    ...extra,
  };
}

export function definicoes(extra: Partial<DefinicoesDto> = {}): DefinicoesDto {
  return {
    capitalUsd: 1000,
    alavancagemMaxima: 5,
    riscoPorOperacaoPct: 1,
    intervaloRecolhaSegundos: 60,
    limiteDiarioChamadasIa: 10,
    limiteDiarioTokensIa: 100_000,
    atualizadoEm: INSTANTE,
    ...extra,
  };
}

const LEGAL = 'Informação para apoio à decisão. Não constitui aconselhamento financeiro.';

/** Sugestão viável completa (Baleia A, long, alavancagem limitada ao máximo do utilizador). */
export function sugestaoProporcional(
  extra: Partial<SugestaoProporcionalDto> = {},
): SugestaoProporcionalDto {
  return {
    viavel: true,
    motivo: null,
    lado: 'long',
    fator: 0.001,
    baleia: {
      accountValue: 1_000_000,
      accountValueRepresentativo: true,
      modoConta: null,
      percentagemMargemPct: 12.5,
      alavancagem: 10,
      tipoMargem: 'cross',
      entryPx: 95_000,
      tamanho: 12.5,
      notional: 1_250_000,
      liquidationPx: 80_000,
    },
    posicao: {
      precoEntrada: 100_000,
      alavancagem: 5,
      alavancagemLimitada: true,
      margemUsd: 38,
      notionalUsd: 190,
      tamanho: 0.0019,
      szDecimals: 5,
      stopLoss: { precoBaleia: 90_000, distanciaPct: -5.263158, preco: 94_737 },
      takeProfit: { precoBaleia: 120_000, distanciaPct: 26.315789, preco: 126_320 },
      liquidacaoEstimada: 80_800,
      riscoMaximoUsd: 10,
      perdaAteStopUsd: 9.99,
      perdaAteLiquidacaoUsd: null,
      limitadoPeloRisco: true,
    },
    entradaTardia: { variacaoFavoravelPct: 5.263158, limiarPct: 3, tardia: true },
    rr: { sugerido: 5, baleia: 5, aosNiveisDaBaleia: 2 },
    ordemMinimaUsd: 10,
    avisos: [
      { codigo: 'ENTRADA_TARDIA', nivel: 'atencao', mensagem: 'O preço já andou 5,26 % a favor.' },
      { codigo: 'MARGEM_CRUZADA_BALEIA', nivel: 'info', mensagem: 'A baleia usa margem cruzada.' },
      {
        codigo: 'ALAVANCAGEM_LIMITADA',
        nivel: 'atencao',
        mensagem: 'Alavancagem da baleia (10x) limitada a 5x (máximo das suas definições).',
      },
    ],
    avisoLegal: LEGAL,
    ...extra,
  };
}

export function sugestaoCarteira(extra: Partial<SugestaoCarteiraDto> = {}): SugestaoCarteiraDto {
  return {
    carteira: { id: 10, endereco: E1, alias: 'Baleia A', entidade: 'Fundo X' },
    instanteSnapshot: INSTANTE,
    runId: 1,
    sugestao: sugestaoProporcional(),
    ...extra,
  };
}

export function respostaSugestao(extra: Partial<RespostaSugestao> = {}): RespostaSugestao {
  return {
    ativoId: 1,
    ticker: 'BTC',
    analiseAtiva: true,
    precoMercado: { valor: 100_000, instante: INSTANTE, fonte: 'hyperliquid' },
    definicoes: { capitalUsd: 1000, alavancagemMaxima: 5, riscoPorOperacaoPct: 1 },
    sugestoes: [sugestaoCarteira()],
    avisoLegal: LEGAL,
    ...extra,
  };
}
