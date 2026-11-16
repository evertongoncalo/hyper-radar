/**
 * Regrava as fixtures do cliente Hyperliquid a partir da API real (só leitura).
 * NÃO corre em testes nem em CI. Os endereços reais nunca são gravados: são substituídos por
 * endereços fictícios e os hashes de transações são removidos.
 *
 * Uso (na pasta apps/api):
 *   npx tsx scripts/gravar-fixtures.ts --com-posicao 0x… --hip3 0x… [--dex xyz] [--coin xyz:NVDA]
 *   --com-posicao: carteira com posição nativa e ordens trigger (SL/TP)
 *   --hip3:        carteira com posição no ativo HIP-3 indicado
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const URL_INFO = 'https://api.hyperliquid.xyz/info';
const PASTA = new URL('../src/hyperliquid/__fixtures__/', import.meta.url);
const INTERVALO_MS = 700;

const ENDERECO_COM_POSICAO = '0x' + '1'.repeat(40);
const ENDERECO_HIP3 = '0x' + '2'.repeat(40);
// Endereço fictício sem atividade (carteira sem posições).
const ENDERECO_VAZIO = '0x' + '3'.repeat(40);

const { values } = parseArgs({
  options: {
    'com-posicao': { type: 'string' },
    hip3: { type: 'string' },
    dex: { type: 'string', default: 'xyz' },
    coin: { type: 'string', default: 'xyz:NVDA' },
  },
});
const reais = { comPosicao: values['com-posicao'], hip3: values.hip3 };
if (!reais.comPosicao || !reais.hip3) {
  console.error('Indique --com-posicao e --hip3 (endereços 0x…).');
  process.exit(1);
}
const dex = values.dex;
const coinHip3 = values.coin;

// --------------------------------------------------------------------------- anonimização

const substitutos = new Map<string, string>([
  [reais.comPosicao.toLowerCase(), ENDERECO_COM_POSICAO],
  [reais.hip3.toLowerCase(), ENDERECO_HIP3],
  [ENDERECO_VAZIO, ENDERECO_VAZIO],
]);
function anonimizarEndereco(endereco: string): string {
  const chave = endereco.toLowerCase();
  let ficticio = substitutos.get(chave);
  if (!ficticio) {
    ficticio = '0x' + 'f'.repeat(36) + String(substitutos.size).padStart(4, '0');
    substitutos.set(chave, ficticio);
  }
  return ficticio;
}
function anonimizar(valor: unknown): unknown {
  if (typeof valor === 'string') {
    return /^0x[0-9a-fA-F]{40}$/.test(valor) ? anonimizarEndereco(valor) : valor;
  }
  if (Array.isArray(valor)) return valor.map(anonimizar);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor)
        .filter(([chave]) => chave !== 'hash')
        .map(([chave, v]) => [chave, anonimizar(v)]),
    );
  }
  return valor;
}

// --------------------------------------------------------------------------- pedidos

async function info(corpo: Record<string, unknown>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, INTERVALO_MS));
  const resposta = await fetch(URL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status} em ${JSON.stringify(corpo)}`);
  return resposta.json();
}

function gravar(nome: string, dados: unknown): void {
  writeFileSync(new URL(`${nome}.json`, PASTA), JSON.stringify(anonimizar(dados), null, 2) + '\n');
  console.log(`gravado ${nome}.json`);
}

type Universo = { universe: { name: string }[]; marginTables?: unknown };

/** Reduz `meta`/`metaAndAssetCtxs` aos ativos indicados, mantendo o alinhamento dos contextos. */
function reduzirMeta(meta: Universo, coins: (nome: string, i: number) => boolean): number[] {
  return meta.universe.flatMap((a, i) => (coins(a.name, i) ? [i] : []));
}
function aplicarIndices<T extends Universo>(meta: T, indices: number[]): T {
  const copia: Universo = { ...meta, universe: indices.map((i) => meta.universe[i]!) };
  delete copia.marginTables;
  return copia as T;
}
function reduzirMapa(mapa: Record<string, unknown>, chaves: string[]): Record<string, unknown> {
  return Object.fromEntries(chaves.filter((c) => c in mapa).map((c) => [c, mapa[c]]));
}

mkdirSync(PASTA, { recursive: true });

const perpDexs = (await info({ type: 'perpDexs' })) as (Record<string, unknown> | null)[];
gravar(
  'perpDexs',
  perpDexs
    .slice(0, 3)
    .map((d) =>
      d === null
        ? null
        : Object.fromEntries(
            Object.entries(d).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 2) : v]),
          ),
    ),
);

const nativos = ['BTC', 'ETH'];
const hip3 = [`${dex}:XYZ100`, `${dex}:TSLA`, coinHip3];

const macNativo = (await info({ type: 'metaAndAssetCtxs' })) as [Universo, { midPx: unknown }[]];
const indNativo = reduzirMeta(
  macNativo[0],
  (n, i) => nativos.includes(n) || i === macNativo[1].findIndex((c) => c.midPx === null),
);
gravar('meta-nativo', aplicarIndices(macNativo[0], indNativo));
gravar('metaAndAssetCtxs-nativo', [
  aplicarIndices(macNativo[0], indNativo),
  indNativo.map((i) => macNativo[1][i]),
]);

const macHip3 = (await info({ type: 'metaAndAssetCtxs', dex })) as [Universo, unknown[]];
const indHip3 = reduzirMeta(macHip3[0], (n) => hip3.includes(n));
gravar(`meta-${dex}`, aplicarIndices(macHip3[0], indHip3));
gravar(`metaAndAssetCtxs-${dex}`, [
  aplicarIndices(macHip3[0], indHip3),
  indHip3.map((i) => macHip3[1][i]),
]);

const midsNativo = (await info({ type: 'allMids' })) as Record<string, unknown>;
const primeiroSpot = Object.keys(midsNativo).find((k) => k.startsWith('@')) ?? '';
gravar('allMids-nativo', reduzirMapa(midsNativo, [...nativos, primeiroSpot]));
gravar(`allMids-${dex}`, reduzirMapa((await info({ type: 'allMids', dex })) as never, hip3));

gravar(
  'clearinghouseState-com-posicao',
  await info({ type: 'clearinghouseState', user: reais.comPosicao }),
);
const estadoHip3 = (await info({ type: 'clearinghouseState', user: reais.hip3, dex })) as {
  assetPositions: { position: { coin: string } }[];
};
estadoHip3.assetPositions = estadoHip3.assetPositions
  .filter((p) => hip3.includes(p.position.coin))
  .slice(0, 3);
gravar(`clearinghouseState-${dex}`, estadoHip3);
gravar(
  'clearinghouseState-sem-posicoes',
  await info({ type: 'clearinghouseState', user: ENDERECO_VAZIO }),
);

const ordens = (await info({ type: 'frontendOpenOrders', user: reais.comPosicao })) as {
  isTrigger: boolean;
}[];
gravar('frontendOpenOrders-com-triggers', [
  ...ordens.filter((o) => o.isTrigger).slice(0, 4),
  ...ordens.filter((o) => !o.isTrigger).slice(0, 1),
]);
const ordensHip3 = (await info({ type: 'frontendOpenOrders', user: reais.hip3, dex })) as unknown[];
gravar(`frontendOpenOrders-${dex}`, ordensHip3.slice(0, 3));
gravar(
  'frontendOpenOrders-vazio',
  await info({ type: 'frontendOpenOrders', user: ENDERECO_VAZIO }),
);

const fills = (await info({ type: 'userFills', user: reais.hip3 })) as { liquidation?: unknown }[];
const fillLiquidacao = fills.find((f) => f.liquidation);
gravar('userFills', [...fills.slice(0, 3), ...(fillLiquidacao ? [fillLiquidacao] : [])]);
const fillsPorTempo = (await info({
  type: 'userFillsByTime',
  user: reais.comPosicao,
  startTime: Date.now() - 86_400_000,
})) as unknown[];
gravar('userFillsByTime', fillsPorTempo.slice(0, 3));
gravar('userAbstraction', await info({ type: 'userAbstraction', user: reais.comPosicao }));
