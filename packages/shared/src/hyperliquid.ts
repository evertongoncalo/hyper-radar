import { z } from 'zod';

/*
 * Schemas das respostas do endpoint `POST /info` da Hyperliquid (validados contra respostas reais)
 * e tipos normalizados partilhados entre a API e a web.
 *
 * Precisão: os decimais que a API devolve como string são convertidos para `number` (double);
 * têm no máximo ~16 algarismos significativos, o que chega para análise (nunca se assinam ordens).
 */

/** Decimal enviado como string pela API (ex.: `"65454.5"`), convertido para `number` finito. */
export const decimalHlSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i, { message: 'Valor decimal inválido.' })
  .transform(Number)
  .refine(Number.isFinite, { message: 'Valor decimal fora do intervalo.' });

const inteiro = z.number().int();

/** `perpDexs`: o primeiro elemento é `null` (DEX nativo); os restantes são DEXs HIP-3. */
export const perpDexsRespostaSchema = z.array(
  z
    .object({
      name: z.string().min(1),
      fullName: z.string(),
      deployer: z.string(),
      oracleUpdater: z.string().nullable().optional(),
      feeRecipient: z.string().nullable().optional(),
    })
    .nullable(),
);

const ativoUniversoSchema = z.object({
  name: z.string().min(1),
  szDecimals: inteiro.nonnegative(),
  maxLeverage: z.number().positive(),
  onlyIsolated: z.boolean().optional(),
  isDelisted: z.boolean().optional(),
  marginMode: z.string().optional(),
});

export const metaRespostaSchema = z.object({
  universe: z.array(ativoUniversoSchema),
  collateralToken: inteiro.optional(),
});

const contextoAtivoSchema = z.object({
  markPx: decimalHlSchema,
  midPx: decimalHlSchema.nullable(),
  oraclePx: decimalHlSchema,
  funding: decimalHlSchema,
  premium: decimalHlSchema.nullable(),
  openInterest: decimalHlSchema,
  prevDayPx: decimalHlSchema,
  dayNtlVlm: decimalHlSchema,
  dayBaseVlm: decimalHlSchema.optional(),
});

/** `metaAndAssetCtxs`: `[meta, contextos]`, com os contextos pela mesma ordem de `universe`. */
export const metaAndAssetCtxsRespostaSchema = z.tuple([
  metaRespostaSchema,
  z.array(contextoAtivoSchema),
]);

/** `allMids`: mapa `coin → preço médio`. */
export const allMidsRespostaSchema = z.record(z.string(), decimalHlSchema);

const resumoMargemSchema = z.object({
  accountValue: decimalHlSchema,
  totalNtlPos: decimalHlSchema,
  totalRawUsd: decimalHlSchema,
  totalMarginUsed: decimalHlSchema,
});

export const clearinghouseStateRespostaSchema = z.object({
  marginSummary: resumoMargemSchema,
  crossMarginSummary: resumoMargemSchema,
  crossMaintenanceMarginUsed: decimalHlSchema,
  withdrawable: decimalHlSchema,
  assetPositions: z.array(
    z.object({
      type: z.string(),
      position: z.object({
        coin: z.string().min(1),
        szi: decimalHlSchema,
        leverage: z.object({
          type: z.enum(['cross', 'isolated']),
          value: z.number().positive(),
        }),
        entryPx: decimalHlSchema,
        positionValue: decimalHlSchema,
        unrealizedPnl: decimalHlSchema,
        returnOnEquity: decimalHlSchema,
        liquidationPx: decimalHlSchema.nullable(),
        marginUsed: decimalHlSchema,
        maxLeverage: z.number().positive(),
      }),
    }),
  ),
  time: inteiro,
});

const ladoBrutoSchema = z.enum(['A', 'B']);

export const frontendOpenOrdersRespostaSchema = z.array(
  z.object({
    coin: z.string().min(1),
    side: ladoBrutoSchema,
    limitPx: decimalHlSchema,
    sz: decimalHlSchema,
    origSz: decimalHlSchema,
    oid: inteiro,
    timestamp: inteiro,
    isTrigger: z.boolean(),
    triggerPx: decimalHlSchema,
    triggerCondition: z.string(),
    isPositionTpsl: z.boolean(),
    reduceOnly: z.boolean(),
    orderType: z.string(),
  }),
);

export const userFillsRespostaSchema = z.array(
  z.object({
    coin: z.string().min(1),
    px: decimalHlSchema,
    sz: decimalHlSchema,
    side: ladoBrutoSchema,
    time: inteiro,
    startPosition: decimalHlSchema,
    dir: z.string(),
    closedPnl: decimalHlSchema,
    oid: inteiro,
    tid: inteiro,
    crossed: z.boolean(),
    fee: decimalHlSchema,
    feeToken: z.string(),
    liquidation: z.object({ markPx: decimalHlSchema, method: z.string() }).optional(),
  }),
);

/** `userAbstraction`: modo da conta (`unifiedAccount`, `portfolioMargin`, `default`, …). */
export const userAbstractionRespostaSchema = z.string().min(1);

// ---------------------------------------------------------------------------------------------
// Tipos normalizados
// ---------------------------------------------------------------------------------------------

/** DEX HIP-3; `indice` é a posição na resposta de `perpDexs` (0 = nativo, não listado). */
export interface DexPerp {
  indice: number;
  name: string;
  fullName: string;
  deployer: string;
}

export interface AtivoPerp {
  coin: string;
  /** `null` para os perps nativos. */
  dex: string | null;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  isDelisted: boolean;
}

export interface MetaDex {
  dex: string | null;
  ativos: AtivoPerp[];
  /** Índice do token de colateral do DEX (0 = USDC), se a API o indicar. */
  collateralToken: number | null;
}

export interface MercadoAtivo extends AtivoPerp {
  markPx: number;
  midPx: number | null;
  oraclePx: number;
  funding: number;
  premium: number | null;
  openInterest: number;
  prevDayPx: number;
  dayNtlVlm: number;
}

export type LadoPosicao = 'long' | 'short';
export type LadoOrdem = 'compra' | 'venda';
export type TipoMargem = 'cross' | 'isolated';

export interface Posicao {
  coin: string;
  dex: string | null;
  /** Derivado do sinal de `szi`. */
  lado: LadoPosicao;
  /** Tamanho absoluto, em unidades do ativo. */
  tamanho: number;
  szi: number;
  entryPx: number;
  leverage: { tipo: TipoMargem; valor: number };
  /** Pode ser `null` (ex.: posição sem risco de liquidação). */
  liquidationPx: number | null;
  marginUsed: number;
  unrealizedPnl: number;
  positionValue: number;
  returnOnEquity: number;
  maxLeverage: number;
}

export interface EstadoConta {
  dex: string | null;
  /** `marginSummary.accountValue` do DEX consultado. */
  accountValue: number;
  totalMarginUsed: number;
  totalNtlPos: number;
  withdrawable: number;
  crossMaintenanceMarginUsed: number;
  posicoes: Posicao[];
  /** Instante da leitura no servidor (ms). */
  time: number;
}

export type TipoProtecao = 'stop_loss' | 'take_profit';

export interface OrdemAberta {
  oid: number;
  coin: string;
  dex: string | null;
  lado: LadoOrdem;
  /** Tamanho em aberto; `0` com `isPositionTpsl` significa "toda a posição". */
  tamanho: number;
  tamanhoOriginal: number;
  limitPx: number;
  isTrigger: boolean;
  /** `null` quando a ordem não é de trigger. */
  triggerPx: number | null;
  triggerCondition: string;
  orderType: string;
  reduceOnly: boolean;
  isPositionTpsl: boolean;
  /** Classificação SL/TP derivada de `orderType`; `null` se não for ordem de proteção. */
  protecao: TipoProtecao | null;
  timestamp: number;
}

export interface Fill {
  coin: string;
  dex: string | null;
  px: number;
  sz: number;
  lado: LadoOrdem;
  time: number;
  startPosition: number;
  /** Ex.: `Open Long`, `Close Short`, `Long > Short`. */
  dir: string;
  closedPnl: number;
  fee: number;
  feeToken: string;
  oid: number;
  tid: number;
  crossed: boolean;
  liquidacao: boolean;
}

export interface EstadoCarteiraNoAtivo {
  user: string;
  coin: string;
  dex: string | null;
  posicao: Posicao | null;
  /** Ordens de trigger (SL/TP) colocadas na exchange para este ativo. */
  ordensProtecao: OrdemAberta[];
  accountValue: number;
  /** Modo da conta (`userAbstraction`). */
  modoConta: string;
  /**
   * `false` em conta unificada / margem de portfólio: aí o saldo real está no estado spot e o
   * `accountValue` por DEX não é representativo (documentação oficial).
   */
  accountValueRepresentativo: boolean;
  mercado: { markPx: number; midPx: number | null; oraclePx: number };
  time: number;
}

// ---------------------------------------------------------------------------------------------
// Tickers
// ---------------------------------------------------------------------------------------------

export interface TickerSeparado {
  /** Nome do DEX HIP-3, ou `null` para perps nativos. */
  dex: string | null;
  /** Nome do ativo tal como a API o devolve (HIP-3 mantém o prefixo, ex.: `xyz:NVDA`). */
  coin: string;
}

/** Separa `xyz:NVDA` em `{ dex: 'xyz', coin: 'xyz:NVDA' }` e `BTC` em `{ dex: null, coin: 'BTC' }`. */
export function separarTicker(ticker: string): TickerSeparado {
  const limpo = ticker.trim();
  const partes = limpo.split(':');
  if (partes.length === 1 && limpo !== '') return { dex: null, coin: limpo };
  const [dex, ativo] = partes;
  if (partes.length !== 2 || !dex || !ativo) {
    throw new Error(`Ticker inválido: "${ticker}". Use "ATIVO" ou "dex:ATIVO".`);
  }
  return { dex, coin: limpo };
}
