import { describe, expect, it } from 'vitest';
import {
  CARTEIRA_COM_POSICAO,
  CARTEIRA_HIP3,
  CARTEIRA_VAZIA,
  carregarFixture,
  criarFetchFalso,
  RelogioFalso,
  responderComFixtures,
  type RespostaFalsa,
} from './__testes__/auxiliares';
import { ClienteHyperliquid, type OpcoesCliente } from './cliente';
import { ErroParametroInvalido, ErroRespostaInvalida } from './erros';
import { dexDoCoin } from './normalizar';
import type { CorpoInfo } from './transporte';

function criarCliente(
  responder: (corpo: CorpoInfo, n: number) => RespostaFalsa = responderComFixtures,
  opcoes: OpcoesCliente = {},
) {
  const falso = criarFetchFalso(responder);
  const cliente = new ClienteHyperliquid({
    fetch: falso.fetch,
    relogio: new RelogioFalso(),
    aleatorio: () => 0.5,
    ...opcoes,
  });
  return { cliente, ...falso };
}

describe('ClienteHyperliquid — mercado', () => {
  it('perpDexs devolve só os DEXs HIP-3 com o índice da resposta', async () => {
    const { cliente, chamadas, urls } = criarCliente();
    const dexs = await cliente.perpDexs();
    expect(chamadas).toEqual([{ type: 'perpDexs' }]);
    expect(urls[0]).toBe('https://api.hyperliquid.xyz/info');
    expect(dexs[0]).toMatchObject({ indice: 1, name: 'xyz', fullName: 'XYZ' });
    expect(dexs.every((d) => d.indice > 0)).toBe(true);
  });

  it('meta nativo não envia dex e normaliza szDecimals, maxLeverage e isDelisted', async () => {
    const { cliente, chamadas } = criarCliente();
    const meta = await cliente.meta();
    expect(chamadas[0]).toEqual({ type: 'meta' });
    expect(meta.dex).toBeNull();
    expect(meta.collateralToken).toBe(0);
    expect(meta.ativos[0]).toEqual({
      coin: 'BTC',
      dex: null,
      szDecimals: 5,
      maxLeverage: 40,
      onlyIsolated: false,
      isDelisted: false,
    });
    expect(meta.ativos.some((a) => a.isDelisted)).toBe(true);
  });

  it('meta HIP-3 envia dex e mantém o prefixo no coin', async () => {
    const { cliente, chamadas } = criarCliente();
    const meta = await cliente.meta('xyz');
    expect(chamadas[0]).toEqual({ type: 'meta', dex: 'xyz' });
    expect(meta.ativos.map((a) => a.coin)).toContain('xyz:NVDA');
    expect(meta.ativos.every((a) => a.dex === 'xyz')).toBe(true);
  });

  it('metaAndAssetCtxs converte preços, funding, OI e volume para número', async () => {
    const { cliente } = criarCliente();
    const mercados = await cliente.metaAndAssetCtxs();
    const btc = mercados.find((m) => m.coin === 'BTC')!;
    const bruto = (
      carregarFixture('metaAndAssetCtxs-nativo') as [unknown, Record<string, string>[]]
    )[1][0]!;
    expect(btc.markPx).toBe(Number(bruto.markPx));
    expect(btc.midPx).toBe(Number(bruto.midPx));
    expect(btc.funding).toBe(Number(bruto.funding));
    expect(btc.openInterest).toBe(Number(bruto.openInterest));
    expect(btc.dayNtlVlm).toBe(Number(bruto.dayNtlVlm));
    expect(btc.szDecimals).toBe(5);
    // Ativo sem livro: midPx e premium nulos.
    expect(mercados.some((m) => m.midPx === null && m.premium === null)).toBe(true);
  });

  it('metaAndAssetCtxs HIP-3 envia dex', async () => {
    const { cliente, chamadas } = criarCliente();
    const mercados = await cliente.metaAndAssetCtxs('xyz');
    expect(chamadas[0]).toEqual({ type: 'metaAndAssetCtxs', dex: 'xyz' });
    const nvda = mercados.find((m) => m.coin === 'xyz:NVDA')!;
    expect(nvda).toMatchObject({ dex: 'xyz', maxLeverage: 10, szDecimals: 3 });
    expect(nvda.markPx).toBeGreaterThan(0);
  });

  it('metaAndAssetCtxs com contextos desalinhados lança ErroRespostaInvalida', async () => {
    const [meta] = carregarFixture('metaAndAssetCtxs-nativo') as [unknown, unknown[]];
    const { cliente } = criarCliente(() => ({ corpo: [meta, []] }));
    await expect(cliente.metaAndAssetCtxs()).rejects.toBeInstanceOf(ErroRespostaInvalida);
  });

  it('allMids nativo e HIP-3', async () => {
    const { cliente, chamadas } = criarCliente();
    expect((await cliente.allMids()).BTC).toBe(65239.5);
    expect(await cliente.allMids('xyz')).toHaveProperty('xyz:NVDA', 156.005);
    expect(chamadas).toEqual([{ type: 'allMids' }, { type: 'allMids', dex: 'xyz' }]);
  });

  it('dex vazio ou null equivale ao nativo; dex inválido é rejeitado sem pedido', async () => {
    const { cliente, chamadas } = criarCliente(responderComFixtures, {
      ttlCacheMs: { allMids: 0 },
    });
    await cliente.allMids('');
    await cliente.allMids(null);
    expect(chamadas).toEqual([{ type: 'allMids' }, { type: 'allMids' }]);
    await expect(cliente.allMids('xyz:NVDA')).rejects.toBeInstanceOf(ErroParametroInvalido);
    expect(chamadas).toHaveLength(2);
  });
});

describe('ClienteHyperliquid — utilizador', () => {
  it('clearinghouseState normaliza a posição short nativa', async () => {
    const { cliente, chamadas } = criarCliente();
    const estado = await cliente.clearinghouseState(CARTEIRA_COM_POSICAO);
    expect(chamadas[0]).toEqual({ type: 'clearinghouseState', user: CARTEIRA_COM_POSICAO });
    expect(estado.accountValue).toBe(4193.92246);
    expect(estado.dex).toBeNull();
    expect(estado.posicoes).toEqual([
      {
        coin: 'BTC',
        dex: null,
        lado: 'short',
        tamanho: 2.37464,
        szi: -2.37464,
        entryPx: 65454.5,
        leverage: { tipo: 'cross', valor: 40 },
        liquidationPx: 66166.0541200163,
        marginUsed: 3872.266082,
        unrealizedPnl: 540.467114,
        positionValue: 154890.64328,
        returnOnEquity: 0.1390885294,
        maxLeverage: 40,
      },
    ]);
  });

  it('clearinghouseState HIP-3 envia dex e devolve posição long isolada com prefixo', async () => {
    const { cliente, chamadas } = criarCliente();
    const estado = await cliente.clearinghouseState(CARTEIRA_HIP3, 'xyz');
    expect(chamadas[0]).toEqual({ type: 'clearinghouseState', user: CARTEIRA_HIP3, dex: 'xyz' });
    const [posicao] = estado.posicoes;
    expect(posicao).toMatchObject({
      coin: 'xyz:NVDA',
      dex: 'xyz',
      lado: 'long',
      tamanho: 1456.785,
      leverage: { tipo: 'isolated', valor: 5 },
    });
  });

  it('carteira sem posições devolve lista vazia e accountValue 0', async () => {
    const { cliente } = criarCliente();
    const estado = await cliente.clearinghouseState(CARTEIRA_VAZIA);
    expect(estado.posicoes).toEqual([]);
    expect(estado.accountValue).toBe(0);
  });

  it('aceita liquidationPx nulo e ignora posições com szi 0', async () => {
    const bruto = carregarFixture('clearinghouseState-com-posicao') as {
      assetPositions: { position: Record<string, unknown> }[];
    };
    const original = bruto.assetPositions[0]!;
    bruto.assetPositions = [
      { ...original, position: { ...original.position, liquidationPx: null } },
      { ...original, position: { ...original.position, coin: 'ETH', szi: '0.0' } },
    ];
    const { cliente } = criarCliente(() => ({ corpo: bruto }));
    const estado = await cliente.clearinghouseState(CARTEIRA_COM_POSICAO);
    expect(estado.posicoes).toHaveLength(1);
    expect(estado.posicoes[0]!.liquidationPx).toBeNull();
  });

  it('normaliza o endereço para minúsculas e rejeita endereços inválidos sem pedido', async () => {
    const { cliente, chamadas } = criarCliente();
    await cliente.clearinghouseState('0x' + 'A'.repeat(40));
    expect(chamadas[0]!.user).toBe('0x' + 'a'.repeat(40));
    await expect(cliente.clearinghouseState('0x123')).rejects.toThrow(/Endereço inválido/);
    await expect(cliente.frontendOpenOrders('abc')).rejects.toBeInstanceOf(ErroParametroInvalido);
    expect(chamadas).toHaveLength(1);
  });

  it('frontendOpenOrders extrai SL e TP de posição', async () => {
    const { cliente } = criarCliente();
    const ordens = await cliente.frontendOpenOrders(CARTEIRA_COM_POSICAO);
    expect(ordens).toHaveLength(2);
    expect(ordens[0]).toEqual({
      oid: 607513776445,
      coin: 'BTC',
      dex: null,
      lado: 'compra',
      tamanho: 0,
      tamanhoOriginal: 0,
      limitPx: 72380,
      isTrigger: true,
      triggerPx: 65800,
      triggerCondition: 'Price above 65800',
      orderType: 'Stop Market',
      reduceOnly: true,
      isPositionTpsl: true,
      protecao: 'stop_loss',
      timestamp: 1794869760075,
    });
    expect(ordens[1]).toMatchObject({ protecao: 'take_profit', triggerPx: 57700 });
  });

  it('frontendOpenOrders HIP-3: ordem limite não é trigger (triggerPx nulo)', async () => {
    const { cliente, chamadas } = criarCliente();
    const [ordem] = await cliente.frontendOpenOrders(CARTEIRA_HIP3, 'xyz');
    expect(chamadas[0]).toEqual({ type: 'frontendOpenOrders', user: CARTEIRA_HIP3, dex: 'xyz' });
    expect(ordem).toMatchObject({
      coin: 'xyz:NVDA',
      dex: 'xyz',
      lado: 'venda',
      isTrigger: false,
      triggerPx: null,
      protecao: null,
      reduceOnly: true,
    });
  });

  it('classifica Stop Limit e Take Profit Limit; trigger desconhecido fica sem proteção', async () => {
    const base = (
      carregarFixture('frontendOpenOrders-com-triggers') as Record<string, unknown>[]
    )[0]!;
    const { cliente } = criarCliente(() => ({
      corpo: [
        { ...base, orderType: 'Stop Limit' },
        { ...base, orderType: 'Take Profit Limit' },
        { ...base, orderType: 'Outro' },
      ],
    }));
    const ordens = await cliente.frontendOpenOrders(CARTEIRA_COM_POSICAO);
    expect(ordens.map((o) => o.protecao)).toEqual(['stop_loss', 'take_profit', null]);
  });

  it('userFills normaliza lado, direção e liquidação (sem hash)', async () => {
    const { cliente, chamadas } = criarCliente();
    const fills = await cliente.userFills(CARTEIRA_HIP3);
    expect(chamadas[0]).toEqual({ type: 'userFills', user: CARTEIRA_HIP3 });
    expect(fills[0]).toEqual({
      coin: 'xyz:NVDA',
      dex: 'xyz',
      px: 161.05,
      sz: 6.021,
      lado: 'compra',
      time: 1794840418199,
      startPosition: 975.374,
      dir: 'Open Long',
      closedPnl: 0,
      fee: 0.02909,
      feeToken: 'USDC',
      oid: 607111994668,
      tid: 626493084472256,
      crossed: false,
      liquidacao: false,
    });
    expect(fills.at(-1)!.liquidacao).toBe(true);
  });

  it('userFillsByTime envia startTime e endTime', async () => {
    const { cliente, chamadas } = criarCliente();
    const fills = await cliente.userFillsByTime(CARTEIRA_COM_POSICAO, 1000, 2000);
    await cliente.userFillsByTime(CARTEIRA_COM_POSICAO, 1000);
    expect(chamadas).toEqual([
      { type: 'userFillsByTime', user: CARTEIRA_COM_POSICAO, startTime: 1000, endTime: 2000 },
      { type: 'userFillsByTime', user: CARTEIRA_COM_POSICAO, startTime: 1000 },
    ]);
    expect(fills).toHaveLength(3);
    expect(fills.every((f) => Number.isFinite(f.px) && f.sz > 0)).toBe(true);
  });

  it.each([
    [-1, undefined],
    [1.5, undefined],
    [2000, 1000],
  ])('userFillsByTime rejeita intervalo inválido (%s, %s)', async (inicio, fim) => {
    const { cliente } = criarCliente();
    await expect(cliente.userFillsByTime(CARTEIRA_COM_POSICAO, inicio, fim)).rejects.toThrow(
      'Intervalo de tempo inválido',
    );
  });

  it('modoConta devolve o modo de abstração', async () => {
    const { cliente } = criarCliente();
    expect(await cliente.modoConta(CARTEIRA_COM_POSICAO)).toBe('unifiedAccount');
  });
});

describe('ClienteHyperliquid — respostas malformadas', () => {
  it.each([
    ['tipo errado', { assetPositions: 'x' }],
    [
      'decimal inválido',
      { ...(carregarFixture('clearinghouseState-sem-posicoes') as object), withdrawable: 'abc' },
    ],
    ['null', null],
  ])('clearinghouseState com %s lança ErroRespostaInvalida', async (_caso, corpo) => {
    const { cliente } = criarCliente(() => ({ corpo }));
    const erro = await cliente.clearinghouseState(CARTEIRA_VAZIA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroRespostaInvalida);
    expect((erro as ErroRespostaInvalida).codigo).toBe('RESPOSTA_INVALIDA');
    expect((erro as Error).message).toMatch(/clearinghouseState/);
  });

  it('corpo que não é JSON lança ErroRespostaInvalida', async () => {
    const { cliente } = criarCliente(() => ({ texto: '<html>' }));
    await expect(cliente.perpDexs()).rejects.toThrow(/não é JSON válido/);
  });
});

describe('obterEstadoCarteiraNoAtivo', () => {
  it('ativo nativo: posição, SL/TP, accountValue, preço e modo da conta', async () => {
    const { cliente, chamadas } = criarCliente();
    const estado = await cliente.obterEstadoCarteiraNoAtivo(CARTEIRA_COM_POSICAO, 'BTC');
    expect(chamadas.every((c) => !('dex' in c))).toBe(true);
    expect(estado).toMatchObject({
      user: CARTEIRA_COM_POSICAO,
      coin: 'BTC',
      dex: null,
      accountValue: 4193.92246,
      modoConta: 'unifiedAccount',
      accountValueRepresentativo: false,
      time: 1794870331308,
    });
    expect(estado.posicao?.lado).toBe('short');
    expect(estado.ordensProtecao.map((o) => o.protecao)).toEqual(['stop_loss', 'take_profit']);
    expect(estado.mercado.markPx).toBeGreaterThan(0);
  });

  it('ativo HIP-3: usa o dex do ticker em todos os pedidos por DEX', async () => {
    const { cliente, chamadas } = criarCliente();
    const estado = await cliente.obterEstadoCarteiraNoAtivo(CARTEIRA_HIP3, ' xyz:NVDA ');
    const porDex = chamadas.filter((c) => c.type !== 'userAbstraction');
    expect(porDex.map((c) => c.dex)).toEqual(['xyz', 'xyz', 'xyz']);
    expect(estado.dex).toBe('xyz');
    expect(estado.posicao).toMatchObject({ coin: 'xyz:NVDA', lado: 'long' });
    expect(estado.ordensProtecao).toEqual([]);
    expect(estado.mercado.midPx).not.toBeNull();
  });

  it('carteira sem posição no ativo devolve posição nula', async () => {
    const { cliente } = criarCliente((corpo) =>
      corpo.type === 'userAbstraction' ? { corpo: 'default' } : responderComFixtures(corpo),
    );
    const estado = await cliente.obterEstadoCarteiraNoAtivo(CARTEIRA_VAZIA, 'ETH');
    expect(estado.posicao).toBeNull();
    expect(estado.ordensProtecao).toEqual([]);
    expect(estado.accountValueRepresentativo).toBe(true);
  });

  it('ativo inexistente no DEX lança ErroParametroInvalido', async () => {
    const { cliente } = criarCliente();
    await expect(
      cliente.obterEstadoCarteiraNoAtivo(CARTEIRA_HIP3, 'xyz:NAOEXISTE'),
    ).rejects.toThrow(/não existe no DEX xyz/);
    await expect(cliente.obterEstadoCarteiraNoAtivo(CARTEIRA_HIP3, 'NAOEXISTE')).rejects.toThrow(
      /DEX nativo/,
    );
  });

  it('ticker ou endereço inválidos lançam ErroParametroInvalido sem pedidos', async () => {
    const { cliente, chamadas } = criarCliente();
    await expect(cliente.obterEstadoCarteiraNoAtivo(CARTEIRA_HIP3, 'a:b:c')).rejects.toBeInstanceOf(
      ErroParametroInvalido,
    );
    await expect(cliente.obterEstadoCarteiraNoAtivo('0x1', 'BTC')).rejects.toBeInstanceOf(
      ErroParametroInvalido,
    );
    expect(chamadas).toHaveLength(0);
  });
});

describe('dexDoCoin', () => {
  it.each([
    ['xyz:NVDA', 'xyz'],
    ['BTC', null],
    ['@107', null],
    ['PURR/USDC', null],
  ])('%s → %s', (coin, dex) => {
    expect(dexDoCoin(coin)).toBe(dex);
  });
});
