import {
  AVISO_LEGAL,
  type AvisoSugestaoDto,
  type CodigoAvisoSugestao,
  type LadoPosicao,
  type MotivoInviabilidade,
  type NivelAviso,
  type NivelProtecaoDto,
  type SugestaoProporcionalDto,
  type TipoMargem,
} from '@hyper-radar/shared';

/*
 * Sugestão proporcional (secção 7.1). Módulo puro: sem BD, rede nem relógio; tudo entra por
 * parâmetro. Regras da Hyperliquid validadas na documentação oficial:
 * - ordem mínima de 10 USD nos perps (erro `MinTradeNtl`, "for-developers/api/error-responses");
 * - tamanho com no máximo `szDecimals` casas; preço com até 5 algarismos significativos e no
 *   máximo `6 − szDecimals` casas decimais, inteiros sempre válidos ("api/tick-and-lot-size");
 * - liquidação: `liq = preço − lado × margem_disponível ÷ tamanho ÷ (1 − l × lado)`, com
 *   `l = 1 ÷ alavancagem_de_manutenção` e margem de manutenção = metade da margem inicial à
 *   alavancagem máxima ("trading/liquidations").
 */

export const ORDEM_MINIMA_USD = 10;
export const LIMIAR_ENTRADA_TARDIA_PCT = 2;
/** Um snapshot é antigo se tiver mais do que este múltiplo do intervalo de recolha. */
export const FATOR_DESATUALIZACAO = 2;
const MAX_DECIMAIS_PERP = 6;
const ALGARISMOS_SIGNIFICATIVOS = 5;
/** Tolerância relativa para resíduos de vírgula flutuante (ex.: 0.3 ÷ 0.1). */
const TOLERANCIA = 1e-9;

export interface PosicaoBaleia {
  lado: LadoPosicao;
  tamanho: number;
  entryPx: number;
  alavancagem: number;
  tipoMargem: TipoMargem;
  marginUsed: number;
  notional: number;
  liquidationPx: number | null;
}

export interface ProtecaoBaleia {
  tipo: 'SL' | 'TP';
  triggerPx: number;
}

export interface EntradaSugestao {
  definicoes: { capitalUsd: number; alavancagemMaxima: number; riscoPorOperacaoPct: number };
  baleia: {
    posicao: PosicaoBaleia | null;
    accountValue: number;
    accountValueRepresentativo: boolean;
    modoConta: string | null;
    protecoes: readonly ProtecaoBaleia[];
  };
  /** Preço atual (mid); 0 se desconhecido. */
  precoAtual: number;
  /** Metadados do ativo (`meta(dex)`); `null` se o ativo não foi encontrado. */
  ativo: { szDecimals: number; maxLeverage: number } | null;
  /** Lados das outras carteiras da mesma entidade com posição neste ativo. */
  entidade: { nome: string | null; ladosOutrasCarteiras: readonly LadoPosicao[] };
  /** `null` = não avaliar a frescura. */
  frescura: {
    instanteSnapshotMs: number;
    agoraMs: number;
    intervaloRecolhaSegundos: number;
    /** A última leitura desta carteira falhou. */
    leituraFalhou?: boolean;
  } | null;
  opcoes?: { limiarEntradaTardiaPct?: number; ordemMinimaUsd?: number };
}

const positivo = (x: number) => Number.isFinite(x) && x > 0;
const sinal = (lado: LadoPosicao) => (lado === 'long' ? 1 : -1);
const fmt = (x: number, casas = 2) => x.toFixed(casas);

/** Arredonda o tamanho **para baixo** ao `szDecimals` (0 se inválido). */
export function arredondarTamanho(tamanho: number, szDecimals: number): number {
  if (!positivo(tamanho)) return 0;
  const f = 10 ** szDecimals;
  const v = Math.floor(tamanho * f * (1 + TOLERANCIA)) / f;
  return Number.isFinite(v) ? Number(v.toFixed(szDecimals)) : 0;
}

/** Casas decimais permitidas para um preço de perp: `min(6 − szDecimals, 5 − dígitos inteiros)`. */
export function casasDecimaisPreco(preco: number, szDecimals: number): number {
  const maximo = Math.max(0, MAX_DECIMAIS_PERP - szDecimals);
  const inteiros = Math.floor(Math.log10(preco)) + 1;
  return Math.max(0, Math.min(maximo, ALGARISMOS_SIGNIFICATIVOS - inteiros));
}

/** Arredonda ao preço válido mais próximo; `null` se não positivo (ou se arredondar a 0). */
export function arredondarPreco(preco: number, szDecimals: number): number | null {
  if (!positivo(preco)) return null;
  const casas = casasDecimaisPreco(preco, szDecimals);
  let v = Number(preco.toFixed(casas));
  // Ex.: 9.99996 → 10.0000 ganha um dígito inteiro; volta a aplicar a regra.
  const casasV = v > 0 ? casasDecimaisPreco(v, szDecimals) : casas;
  if (casasV < casas) v = Number(v.toFixed(casasV));
  return v > 0 ? v : null;
}

/**
 * Preço de liquidação estimado de uma posição isolada aberta a `precoEntrada` (fórmula oficial,
 * sem escalões de margem). Margem de manutenção = metade da inicial à alavancagem máxima do
 * ativo, ou seja `l = 1 ÷ (2 × maxLeverage)`. `null` se não houver liquidação (≤ 0).
 */
export function estimarLiquidacaoIsolada(p: {
  lado: LadoPosicao;
  precoEntrada: number;
  tamanho: number;
  margem: number;
  maxLeverageAtivo: number;
}): number | null {
  if (![p.precoEntrada, p.tamanho, p.margem, p.maxLeverageAtivo].every(positivo)) return null;
  const s = sinal(p.lado);
  const l = 1 / (2 * p.maxLeverageAtivo);
  const disponivel = p.margem - p.tamanho * p.precoEntrada * l;
  const liq = p.precoEntrada - (s * disponivel) / p.tamanho / (1 - l * s);
  return positivo(liq) ? liq : null;
}

interface NivelEscolhido extends NivelProtecaoDto {
  /** Fração com sinal relativa à entrada da baleia. */
  fracao: number;
}

/**
 * Converte os SL/TP da baleia em distância relativa à entrada dela e reaplica-os ao preço atual.
 * Só serve um nível do lado certo da entrada (SL abaixo num long, etc.); de vários, o mais próximo
 * da entrada (o primeiro a disparar). `rejeitados` indica se houve níveis não reaplicáveis.
 */
function escolherNivel(
  protecoes: readonly ProtecaoBaleia[],
  tipo: 'SL' | 'TP',
  lado: LadoPosicao,
  entryPx: number,
  preco: number,
  szDecimals: number,
): { nivel: NivelEscolhido | null; rejeitados: boolean } {
  // SL de um long fica abaixo da entrada (fração < 0); TP acima; o inverso num short.
  const sentido = (tipo === 'SL' ? -1 : 1) * sinal(lado);
  let nivel: NivelEscolhido | null = null;
  let rejeitados = false;
  for (const p of protecoes) {
    if (p.tipo !== tipo) continue;
    const fracao = (p.triggerPx - entryPx) / entryPx;
    const reaplicado = arredondarPreco(preco * (1 + fracao), szDecimals);
    const valido =
      positivo(p.triggerPx) &&
      fracao * sentido > 0 &&
      reaplicado !== null &&
      (reaplicado - preco) * sentido > 0;
    if (!valido) {
      rejeitados = true;
      continue;
    }
    if (nivel === null || Math.abs(fracao) < Math.abs(nivel.fracao)) {
      nivel = { precoBaleia: p.triggerPx, distanciaPct: fracao * 100, preco: reaplicado, fracao };
    }
  }
  return { nivel, rejeitados };
}

/** R:R = recompensa ÷ risco; `null` se o risco não for positivo. */
function razao(recompensa: number, risco: number): number | null {
  return positivo(risco) && Number.isFinite(recompensa) ? recompensa / risco : null;
}

export function calcularSugestao(e: EntradaSugestao): SugestaoProporcionalDto {
  const ordemMinimaUsd = e.opcoes?.ordemMinimaUsd ?? ORDEM_MINIMA_USD;
  const limiarPct = e.opcoes?.limiarEntradaTardiaPct ?? LIMIAR_ENTRADA_TARDIA_PCT;
  const avisos: AvisoSugestaoDto[] = [];
  const avisar = (codigo: CodigoAvisoSugestao, nivel: NivelAviso, mensagem: string) =>
    avisos.push({ codigo, nivel, mensagem });

  let resultado: SugestaoProporcionalDto = {
    viavel: false,
    motivo: null,
    lado: null,
    fator: null,
    baleia: null,
    posicao: null,
    entradaTardia: null,
    rr: null,
    ordemMinimaUsd,
    avisos,
    avisoLegal: AVISO_LEGAL,
  };
  const inviavel = (codigo: MotivoInviabilidade, mensagem: string): SugestaoProporcionalDto => ({
    ...resultado,
    viavel: false,
    motivo: { codigo, mensagem },
  });

  // Avisos independentes do cálculo.
  const f = e.frescura;
  if (f) {
    const idadeMs = f.agoraMs - f.instanteSnapshotMs;
    const limiteMs = FATOR_DESATUALIZACAO * f.intervaloRecolhaSegundos * 1000;
    if (f.leituraFalhou || !(idadeMs <= limiteMs)) {
      avisar(
        'DADOS_DESATUALIZADOS',
        'atencao',
        'Os dados desta carteira podem estar desatualizados (snapshot antigo ou leitura falhada).',
      );
    }
  }
  if (!e.baleia.accountValueRepresentativo) {
    avisar(
      'ACCOUNT_VALUE_NAO_REPRESENTATIVO',
      'critico',
      'Conta unificada / margem de portfólio: o accountValue deste DEX pode não ser o saldo real da baleia, pelo que o fator proporcional pode estar errado. Use com cautela.',
    );
  }

  const { capitalUsd, alavancagemMaxima, riscoPorOperacaoPct } = e.definicoes;
  if (!positivo(capitalUsd)) {
    return inviavel('CAPITAL_INVALIDO', 'Configure o capital disponível em Definições.');
  }
  if (!positivo(alavancagemMaxima) || !positivo(riscoPorOperacaoPct) || riscoPorOperacaoPct > 100) {
    return inviavel(
      'DEFINICOES_INVALIDAS',
      'A alavancagem máxima e o risco por operação têm de ser positivos (risco ≤ 100 %).',
    );
  }

  const pos = e.baleia.posicao;
  if (!pos) {
    avisar('SEM_POSICAO', 'info', 'A baleia não tem posição aberta neste ativo.');
    return inviavel('SEM_POSICAO', 'A baleia não tem posição aberta neste ativo.');
  }
  const lado = pos.lado;
  resultado = { ...resultado, lado };

  if (e.entidade.ladosOutrasCarteiras.some((l) => l !== lado)) {
    avisar(
      'PROVAVEL_HEDGE',
      'critico',
      `Outra carteira da entidade "${e.entidade.nome ?? '?'}" tem posição no lado oposto: é provável que seja um hedge e não uma aposta direcional.`,
    );
  }
  avisar(
    'SO_UMA_PERNA',
    'info',
    'A posição visível pode ser só uma perna de uma estratégia (ex.: cobertura noutra plataforma).',
  );

  const { accountValue } = e.baleia;
  if (!positivo(accountValue)) {
    return inviavel(
      'ACCOUNT_VALUE_INVALIDO',
      'O accountValue da baleia é zero ou inválido: não é possível calcular a proporção.',
    );
  }
  if (!positivo(e.precoAtual)) {
    return inviavel('PRECO_INVALIDO', 'Sem preço de mercado válido para o ativo.');
  }
  if (
    !positivo(pos.entryPx) ||
    !positivo(pos.alavancagem) ||
    !positivo(pos.tamanho) ||
    !Number.isFinite(pos.notional) ||
    !Number.isFinite(pos.marginUsed) ||
    pos.marginUsed < 0
  ) {
    return inviavel('DADOS_POSICAO_INVALIDOS', 'Os dados da posição da baleia são inválidos.');
  }
  const meta = e.ativo;
  if (
    !meta ||
    !Number.isInteger(meta.szDecimals) ||
    meta.szDecimals < 0 ||
    meta.szDecimals > MAX_DECIMAIS_PERP ||
    !positivo(meta.maxLeverage)
  ) {
    return inviavel(
      'METADADOS_INVALIDOS',
      'Metadados do ativo (szDecimals/alavancagem) indisponíveis.',
    );
  }
  // O mid pode ter meio tick a mais (ex.: 65454,5 no BTC): usa-se o preço válido mais próximo.
  const preco = arredondarPreco(e.precoAtual, meta.szDecimals);
  if (preco === null) {
    return inviavel('PRECO_INVALIDO', 'Sem preço de mercado válido para o ativo.');
  }
  const fator = capitalUsd / accountValue;
  const fracaoMargem = pos.marginUsed / accountValue;
  if (!Number.isFinite(fator) || !Number.isFinite(fracaoMargem)) {
    return inviavel('ACCOUNT_VALUE_INVALIDO', 'O accountValue da baleia é demasiado pequeno.');
  }
  const liqBaleia = pos.liquidationPx;
  resultado = {
    ...resultado,
    fator,
    baleia: {
      accountValue,
      accountValueRepresentativo: e.baleia.accountValueRepresentativo,
      modoConta: e.baleia.modoConta,
      percentagemMargemPct: fracaoMargem * 100,
      alavancagem: pos.alavancagem,
      tipoMargem: pos.tipoMargem,
      entryPx: pos.entryPx,
      tamanho: pos.tamanho,
      notional: Math.abs(pos.notional),
      liquidationPx: liqBaleia !== null && positivo(liqBaleia) ? liqBaleia : null,
    },
  };
  if (pos.tipoMargem === 'cross') {
    avisar(
      'MARGEM_CRUZADA_BALEIA',
      'info',
      'A baleia usa margem cruzada; a sugestão assume margem isolada.',
    );
  }

  // Alavancagem: a da baleia, limitada pela do utilizador e pela máxima do ativo.
  const alavancagem = Math.min(pos.alavancagem, alavancagemMaxima, meta.maxLeverage);
  const alavancagemLimitada = alavancagem < pos.alavancagem;
  if (alavancagemLimitada) {
    const origem = alavancagemMaxima <= meta.maxLeverage ? 'das suas definições' : 'do ativo';
    avisar(
      'ALAVANCAGEM_LIMITADA',
      'atencao',
      `Alavancagem da baleia (${pos.alavancagem}x) limitada a ${alavancagem}x (máximo ${origem}).`,
    );
  }
  // Percentagem de margem: replicada, mas nunca acima de 100 % do capital.
  if (fracaoMargem > 1) {
    avisar(
      'MARGEM_LIMITADA_AO_CAPITAL',
      'atencao',
      'A margem da baleia excede o accountValue; a margem sugerida foi limitada a 100 % do capital.',
    );
  }
  const margemAlvo = capitalUsd * Math.min(fracaoMargem, 1);
  const sz = meta.szDecimals;
  let tamanho = arredondarTamanho((margemAlvo * alavancagem) / preco, sz);

  const sl = escolherNivel(e.baleia.protecoes, 'SL', lado, pos.entryPx, preco, sz);
  const tp = escolherNivel(e.baleia.protecoes, 'TP', lado, pos.entryPx, preco, sz);
  if (sl.rejeitados) {
    avisar(
      'SL_NAO_REAPLICAVEL',
      'atencao',
      'Há um SL da baleia do lado do lucro (ou inválido) que não faz sentido numa entrada nova; foi ignorado.',
    );
  }
  if (tp.rejeitados) {
    avisar(
      'TP_NAO_REAPLICAVEL',
      'atencao',
      'Há um TP da baleia do lado da perda (ou inválido); foi ignorado.',
    );
  }

  // Limite pelo risco máximo (só com SL; sem SL não se inventa um).
  const riscoMaximoUsd = (capitalUsd * riscoPorOperacaoPct) / 100;
  let limitadoPeloRisco = false;
  const perdaUnitaria = sl.nivel ? Math.abs(preco - sl.nivel.preco) : null;
  if (perdaUnitaria !== null && tamanho * perdaUnitaria > riscoMaximoUsd * (1 + TOLERANCIA)) {
    tamanho = arredondarTamanho(riscoMaximoUsd / perdaUnitaria, sz);
    limitadoPeloRisco = true;
    avisar(
      'TAMANHO_LIMITADO_PELO_RISCO',
      'atencao',
      `Tamanho reduzido para que a perda até ao SL não ultrapasse ${fmt(riscoMaximoUsd)} USD (${riscoPorOperacaoPct} % do capital).`,
    );
  }

  const notionalUsd = tamanho * preco;
  const margemUsd = notionalUsd / alavancagem;
  const liquidacaoEstimada = estimarLiquidacaoIsolada({
    lado,
    precoEntrada: preco,
    tamanho,
    margem: margemUsd,
    maxLeverageAtivo: meta.maxLeverage,
  });
  const perdaAteStopUsd = perdaUnitaria !== null ? tamanho * perdaUnitaria : null;
  let perdaAteLiquidacaoUsd: number | null = null;
  if (!sl.nivel) {
    // Sem liquidação estimada (ex.: long a 1x), a perda máxima é a margem alocada.
    perdaAteLiquidacaoUsd =
      liquidacaoEstimada !== null ? tamanho * Math.abs(preco - liquidacaoEstimada) : margemUsd;
    avisar(
      'SEM_STOP_LOSS',
      'critico',
      'A baleia não tem SL visível na exchange (pode geri-lo fora dela). Não foi inventado nenhum: a perda possível vai até à liquidação.',
    );
    if (perdaAteLiquidacaoUsd > riscoMaximoUsd * (1 + TOLERANCIA)) {
      avisar(
        'RISCO_ACIMA_DO_MAXIMO',
        'critico',
        `Sem SL, a perda até à liquidação (${fmt(perdaAteLiquidacaoUsd)} USD) excede o risco máximo (${fmt(riscoMaximoUsd)} USD).`,
      );
    }
  }
  if (!tp.nivel) {
    avisar('SEM_TAKE_PROFIT', 'atencao', 'A baleia não tem TP visível na exchange.');
  }
  avisar(
    'LIQUIDACAO_ESTIMADA',
    'info',
    'O preço de liquidação é uma estimativa (margem isolada, sem escalões de margem nem comissões).',
  );

  // Entrada tardia: o preço já andou a favor da baleia mais do que o limiar.
  const variacaoFavoravelPct = (sinal(lado) * (preco - pos.entryPx) * 100) / pos.entryPx;
  const tardia = variacaoFavoravelPct > limiarPct;
  if (tardia) {
    avisar(
      'ENTRADA_TARDIA',
      'atencao',
      `Entrada tardia: o preço já andou ${fmt(variacaoFavoravelPct)} % a favor da baleia desde a entrada dela.`,
    );
  } else if (variacaoFavoravelPct < -limiarPct) {
    avisar(
      'PRECO_CONTRA_BALEIA',
      'info',
      `O preço está ${fmt(-variacaoFavoravelPct)} % contra a baleia desde a entrada dela.`,
    );
  }

  const s = sinal(lado);
  const rr =
    sl.nivel && tp.nivel
      ? {
          sugerido: razao(s * (tp.nivel.preco - preco), s * (preco - sl.nivel.preco)),
          baleia: razao(Math.abs(tp.nivel.fracao), Math.abs(sl.nivel.fracao)),
          aosNiveisDaBaleia: razao(
            s * (tp.nivel.precoBaleia - preco),
            s * (preco - sl.nivel.precoBaleia),
          ),
        }
      : null;

  resultado = {
    ...resultado,
    posicao: {
      precoEntrada: preco,
      alavancagem,
      alavancagemLimitada,
      margemUsd,
      notionalUsd,
      tamanho,
      szDecimals: sz,
      stopLoss: sl.nivel ? semFracao(sl.nivel) : null,
      takeProfit: tp.nivel ? semFracao(tp.nivel) : null,
      liquidacaoEstimada,
      riscoMaximoUsd,
      perdaAteStopUsd,
      perdaAteLiquidacaoUsd,
      limitadoPeloRisco,
    },
    entradaTardia: { variacaoFavoravelPct, limiarPct, tardia },
    rr,
  };

  // Ordem mínima: nunca se arredonda para cima.
  if (notionalUsd < ordemMinimaUsd * (1 - TOLERANCIA)) {
    return inviavel(
      'ABAIXO_ORDEM_MINIMA',
      `O valor da ordem (${fmt(notionalUsd)} USD) fica abaixo do mínimo da Hyperliquid (${ordemMinimaUsd} USD). Não se arredonda para cima.`,
    );
  }
  return { ...resultado, viavel: true };
}

function semFracao(n: NivelEscolhido): NivelProtecaoDto {
  return { precoBaleia: n.precoBaleia, distanciaPct: n.distanciaPct, preco: n.preco };
}
