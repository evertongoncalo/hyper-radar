import {
  allMidsRespostaSchema,
  clearinghouseStateRespostaSchema,
  enderecoCarteiraSchema,
  frontendOpenOrdersRespostaSchema,
  metaAndAssetCtxsRespostaSchema,
  metaRespostaSchema,
  perpDexsRespostaSchema,
  separarTicker,
  userAbstractionRespostaSchema,
  userFillsRespostaSchema,
  type DexPerp,
  type EstadoCarteiraNoAtivo,
  type EstadoConta,
  type Fill,
  type MercadoAtivo,
  type MetaDex,
  type OrdemAberta,
} from '@hyper-radar/shared';
import { z } from 'zod';
import { CacheCurta } from './cache';
import { Circuito, type EstadoCircuito } from './circuito';
import {
  ErroHyperliquid,
  ErroLimiteTaxa,
  ErroParametroInvalido,
  ErroRede,
  ErroRespostaInvalida,
} from './erros';
import { FilaPedidos } from './fila';
import {
  extrairOrdensProtecao,
  normalizarClearinghouseState,
  normalizarFills,
  normalizarMeta,
  normalizarMetaAndAssetCtxs,
  normalizarOrdens,
  normalizarPerpDexs,
} from './normalizar';
import { esperar, relogioSistema, type Relogio } from './relogio';
import { enviarInfo, URL_BASE_OFICIAL, type CorpoInfo, type OpcoesTransporte } from './transporte';

export type TipoPedidoInfo =
  | 'perpDexs'
  | 'meta'
  | 'metaAndAssetCtxs'
  | 'allMids'
  | 'clearinghouseState'
  | 'frontendOpenOrders'
  | 'userFills'
  | 'userFillsByTime'
  | 'userAbstraction';

/** Limite oficial por IP: peso agregado de 1200 por minuto. */
export const LIMITE_PESO_OFICIAL_POR_MINUTO = 1200;

/** Pesos oficiais: 2 para `allMids`/`clearinghouseState`, 20 para os restantes pedidos `info`. */
export const PESOS_INFO: Record<TipoPedidoInfo, number> = {
  perpDexs: 20,
  meta: 20,
  metaAndAssetCtxs: 20,
  allMids: 2,
  clearinghouseState: 2,
  frontendOpenOrders: 20,
  userFills: 20,
  userFillsByTime: 20,
  userAbstraction: 20,
};

/** Pedidos com peso extra de 1 por cada 20 itens devolvidos. */
const TIPOS_COM_PESO_POR_ITEM = new Set<TipoPedidoInfo>(['userFills', 'userFillsByTime']);

export const TTL_CACHE_OMISSAO_MS: Record<TipoPedidoInfo, number> = {
  perpDexs: 300_000,
  meta: 300_000,
  metaAndAssetCtxs: 5_000,
  allMids: 2_000,
  clearinghouseState: 2_000,
  frontendOpenOrders: 2_000,
  userFills: 5_000,
  userFillsByTime: 5_000,
  userAbstraction: 600_000,
};

const MODOS_SALDO_NO_SPOT = new Set(['unifiedAccount', 'portfolioMargin']);

export interface OpcoesCliente {
  /** Omissão: `https://api.hyperliquid.xyz`. */
  urlBase?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  relogio?: Relogio;
  /** Gerador em [0, 1) para o jitter do backoff. */
  aleatorio?: () => number;
  concorrencia?: number;
  pesoMaximoPorMinuto?: number;
  /** Fração do limite efetivamente usada (omissão 0,8). */
  margemSeguranca?: number;
  /** Total de tentativas por pedido (inclui a primeira). */
  maxTentativas?: number;
  atrasoBaseMs?: number;
  atrasoMaximoMs?: number;
  limiarFalhasCircuito?: number;
  intervaloMeioAbertoMs?: number;
  ttlCacheMs?: Partial<Record<TipoPedidoInfo, number>>;
}

/** Cliente só de leitura do endpoint `/info` da Hyperliquid. */
export class ClienteHyperliquid {
  private readonly transporte: OpcoesTransporte;
  private readonly relogio: Relogio;
  private readonly aleatorio: () => number;
  private readonly fila: FilaPedidos;
  private readonly circuito: Circuito;
  private readonly cache: CacheCurta;
  private readonly ttl: Record<TipoPedidoInfo, number>;
  private readonly maxTentativas: number;
  private readonly atrasoBaseMs: number;
  private readonly atrasoMaximoMs: number;

  constructor(opcoes: OpcoesCliente = {}) {
    this.relogio = opcoes.relogio ?? relogioSistema;
    this.aleatorio = opcoes.aleatorio ?? Math.random;
    this.transporte = {
      urlBase: opcoes.urlBase ?? URL_BASE_OFICIAL,
      timeoutMs: opcoes.timeoutMs ?? 10_000,
      fetch: opcoes.fetch ?? globalThis.fetch.bind(globalThis),
      relogio: this.relogio,
    };
    const limite = opcoes.pesoMaximoPorMinuto ?? LIMITE_PESO_OFICIAL_POR_MINUTO;
    this.fila = new FilaPedidos({
      concorrencia: opcoes.concorrencia ?? 4,
      orcamentoPeso: Math.max(1, Math.floor(limite * (opcoes.margemSeguranca ?? 0.8))),
      janelaMs: 60_000,
      relogio: this.relogio,
    });
    this.circuito = new Circuito({
      limiarFalhas: opcoes.limiarFalhasCircuito ?? 5,
      intervaloMeioAbertoMs: opcoes.intervaloMeioAbertoMs ?? 30_000,
      relogio: this.relogio,
    });
    this.cache = new CacheCurta(this.relogio);
    this.ttl = { ...TTL_CACHE_OMISSAO_MS, ...opcoes.ttlCacheMs };
    this.maxTentativas = Math.max(1, opcoes.maxTentativas ?? 4);
    this.atrasoBaseMs = opcoes.atrasoBaseMs ?? 500;
    this.atrasoMaximoMs = opcoes.atrasoMaximoMs ?? 10_000;
  }

  get estadoCircuito(): EstadoCircuito {
    return this.circuito.estado;
  }

  /** Peso consumido no último minuto (diagnóstico). */
  get pesoUsado(): number {
    return this.fila.pesoUsado();
  }

  limparCache(): void {
    this.cache.limpar();
  }

  // ------------------------------------------------------------------ mercado

  async perpDexs(): Promise<DexPerp[]> {
    return normalizarPerpDexs(await this.pedir({ type: 'perpDexs' }, perpDexsRespostaSchema));
  }

  async meta(dex?: string | null): Promise<MetaDex> {
    const d = validarDex(dex);
    return normalizarMeta(await this.pedir(comDex({ type: 'meta' }, d), metaRespostaSchema), d);
  }

  async metaAndAssetCtxs(dex?: string | null): Promise<MercadoAtivo[]> {
    const d = validarDex(dex);
    const bruto = await this.pedir(
      comDex({ type: 'metaAndAssetCtxs' }, d),
      metaAndAssetCtxsRespostaSchema,
    );
    return normalizarMetaAndAssetCtxs(bruto, d);
  }

  /** Preços médios por `coin`; com `dex`, as chaves vêm prefixadas (ex.: `xyz:NVDA`). */
  async allMids(dex?: string | null): Promise<Record<string, number>> {
    return this.pedir(comDex({ type: 'allMids' }, validarDex(dex)), allMidsRespostaSchema);
  }

  // ------------------------------------------------------------------ utilizador

  async clearinghouseState(user: string, dex?: string | null): Promise<EstadoConta> {
    const d = validarDex(dex);
    const bruto = await this.pedir(
      comDex({ type: 'clearinghouseState', user: validarUser(user) }, d),
      clearinghouseStateRespostaSchema,
    );
    return normalizarClearinghouseState(bruto, d);
  }

  async frontendOpenOrders(user: string, dex?: string | null): Promise<OrdemAberta[]> {
    const bruto = await this.pedir(
      comDex({ type: 'frontendOpenOrders', user: validarUser(user) }, validarDex(dex)),
      frontendOpenOrdersRespostaSchema,
    );
    return normalizarOrdens(bruto);
  }

  /** Até 2000 fills mais recentes, de todos os DEXs (não aceita `dex`). */
  async userFills(user: string): Promise<Fill[]> {
    const bruto = await this.pedir(
      { type: 'userFills', user: validarUser(user) },
      userFillsRespostaSchema,
    );
    return normalizarFills(bruto);
  }

  /** Fills num intervalo (ms, inclusivo); máx. 2000 por resposta, só os 10000 mais recentes. */
  async userFillsByTime(user: string, startTime: number, endTime?: number): Promise<Fill[]> {
    const tempo = z.number().int().nonnegative();
    if (
      !tempo.safeParse(startTime).success ||
      (endTime !== undefined && (!tempo.safeParse(endTime).success || endTime < startTime))
    ) {
      throw new ErroParametroInvalido('Intervalo de tempo inválido para userFillsByTime.');
    }
    const corpo: CorpoInfo = { type: 'userFillsByTime', user: validarUser(user), startTime };
    if (endTime !== undefined) corpo.endTime = endTime;
    return normalizarFills(await this.pedir(corpo, userFillsRespostaSchema));
  }

  /** Modo da conta: `unifiedAccount`, `portfolioMargin`, `dexAbstraction`, `default`, `disabled`. */
  async modoConta(user: string): Promise<string> {
    return this.pedir(
      { type: 'userAbstraction', user: validarUser(user) },
      userAbstractionRespostaSchema,
    );
  }

  /** Posição, SL/TP, valor da conta e preço de mercado de uma carteira num ativo (nativo ou HIP-3). */
  async obterEstadoCarteiraNoAtivo(user: string, ticker: string): Promise<EstadoCarteiraNoAtivo> {
    const endereco = validarUser(user);
    let separado: ReturnType<typeof separarTicker>;
    try {
      separado = separarTicker(ticker);
    } catch (erro) {
      throw new ErroParametroInvalido((erro as Error).message);
    }
    const { dex, coin } = separado;
    const [estado, ordens, mercados, modo] = await Promise.all([
      this.clearinghouseState(endereco, dex),
      this.frontendOpenOrders(endereco, dex),
      this.metaAndAssetCtxs(dex),
      this.modoConta(endereco),
    ]);
    const mercado = mercados.find((m) => m.coin === coin);
    if (!mercado) {
      throw new ErroParametroInvalido(
        `O ativo "${coin}" não existe no DEX ${dex ?? 'nativo'} da Hyperliquid.`,
      );
    }
    return {
      user: endereco,
      coin,
      dex,
      posicao: estado.posicoes.find((p) => p.coin === coin) ?? null,
      ordensProtecao: extrairOrdensProtecao(ordens, coin),
      accountValue: estado.accountValue,
      modoConta: modo,
      accountValueRepresentativo: !MODOS_SALDO_NO_SPOT.has(modo),
      mercado: { markPx: mercado.markPx, midPx: mercado.midPx, oraclePx: mercado.oraclePx },
      time: estado.time,
    };
  }

  // ------------------------------------------------------------------ infraestrutura

  private pedir<S extends z.ZodType>(corpo: CorpoInfo, schema: S): Promise<z.output<S>> {
    const tipo = corpo.type as TipoPedidoInfo;
    return this.cache.obter(JSON.stringify(corpo), this.ttl[tipo], async () => {
      const bruto = await this.comTentativas(tipo, corpo);
      const resultado = schema.safeParse(bruto);
      if (!resultado.success) {
        throw new ErroRespostaInvalida(
          `"${tipo}" não tem o formato esperado.\n${z.prettifyError(resultado.error)}`,
          { cause: resultado.error },
        );
      }
      return resultado.data;
    });
  }

  private async comTentativas(tipo: TipoPedidoInfo, corpo: CorpoInfo): Promise<unknown> {
    for (let tentativa = 1; ; tentativa++) {
      this.circuito.autorizar();
      try {
        const dados = await this.fila.executar(PESOS_INFO[tipo], () =>
          enviarInfo(this.transporte, corpo),
        );
        this.circuito.registarSucesso();
        if (TIPOS_COM_PESO_POR_ITEM.has(tipo) && Array.isArray(dados)) {
          this.fila.acrescentarPeso(Math.floor(dados.length / 20));
        }
        return dados;
      } catch (causa) {
        const erro = causa instanceof ErroHyperliquid ? causa : new ErroRede(causa);
        // Erros não repetíveis (4xx, JSON inválido) provam que o servidor está a responder.
        if (erro.repetivel) this.circuito.registarFalha();
        else this.circuito.registarSucesso();
        if (!erro.repetivel || tentativa >= this.maxTentativas) throw erro;
        await esperar(this.relogio, this.calcularAtraso(tentativa, erro));
      }
    }
  }

  /** Backoff exponencial com jitter (50–100 % do atraso); respeita `Retry-After` em 429. */
  private calcularAtraso(tentativa: number, erro: ErroHyperliquid): number {
    const exponencial = Math.min(this.atrasoMaximoMs, this.atrasoBaseMs * 2 ** (tentativa - 1));
    const comJitter = exponencial * (0.5 + 0.5 * this.aleatorio());
    const sugerido = erro instanceof ErroLimiteTaxa ? (erro.esperaSugeridaMs ?? 0) : 0;
    return Math.round(Math.max(comJitter, Math.min(sugerido, this.atrasoMaximoMs)));
  }
}

function validarUser(user: string): string {
  const resultado = enderecoCarteiraSchema.safeParse(user);
  if (!resultado.success) {
    throw new ErroParametroInvalido(resultado.error.issues[0]?.message ?? 'Endereço inválido.');
  }
  return resultado.data;
}

/** `null`/vazio = DEX nativo (o parâmetro não é enviado). */
function validarDex(dex: string | null | undefined): string | null {
  if (dex === undefined || dex === null || dex === '') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(dex)) {
    throw new ErroParametroInvalido(`Nome de DEX inválido: "${dex}".`);
  }
  return dex;
}

function comDex(corpo: CorpoInfo, dex: string | null): CorpoInfo {
  return dex === null ? corpo : { ...corpo, dex };
}
