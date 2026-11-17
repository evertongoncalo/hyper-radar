import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AtivoPerp, DexPerp, MetaDex } from '@hyper-radar/shared';
import { ServicoAnalise } from '../../analise';
import { ClienteFalso, RelogioFalso, T0 } from '../../analise/__testes__/auxiliares';
import { buildApp, type OpcoesApp } from '../../app';
import type { Db } from '../../db/client';
import type { FonteMercadoHyperliquid } from '../tipos';

const perp = (coin: string, extra: Partial<AtivoPerp> = {}): AtivoPerp => ({
  coin,
  dex: coin.includes(':') ? coin.split(':')[0]! : null,
  szDecimals: 3,
  maxLeverage: 20,
  onlyIsolated: false,
  isDelisted: false,
  ...extra,
});

/** Cliente de mercado falso: DEX `xyz` com `xyz:NVDA`; nativos `BTC`, `ETH` e `LUNA` (delisted). */
export class MercadoFalso implements FonteMercadoHyperliquid {
  readonly chamadas: string[] = [];
  dexs: DexPerp[] = [{ indice: 1, name: 'xyz', fullName: 'XYZ', deployer: '0x0' }];
  metas: Record<string, AtivoPerp[]> = {
    nativo: [perp('BTC'), perp('ETH'), perp('LUNA', { isDelisted: true })],
    xyz: [perp('xyz:NVDA'), perp('xyz:TSLA')],
  };
  /** Preços por DEX; um `Error` rejeita; `'pendente'` nunca responde. */
  mids: Record<string, number> | Error | 'pendente' = { BTC: 65_000, ETH: 3_000, 'xyz:NVDA': 180 };
  erroMeta: Error | null = null;

  async perpDexs(): Promise<DexPerp[]> {
    this.chamadas.push('perpDexs');
    return this.dexs;
  }

  async meta(dex?: string | null): Promise<MetaDex> {
    this.chamadas.push(`meta:${dex ?? ''}`);
    if (this.erroMeta) throw this.erroMeta;
    return { dex: dex ?? null, ativos: this.metas[dex ?? 'nativo'] ?? [], collateralToken: 0 };
  }

  allMids(dex?: string | null): Promise<Record<string, number>> {
    this.chamadas.push(`allMids:${dex ?? ''}`);
    if (this.mids === 'pendente') return new Promise(() => {});
    if (this.mids instanceof Error) return Promise.reject(this.mids);
    return Promise.resolve(this.mids);
  }
}

/** App completa com serviço real, cliente Hyperliquid falso e relógio manual. */
export function criarApp(db: Db, extra: Partial<OpcoesApp> = {}) {
  const relogio = new RelogioFalso(T0);
  const cliente = new ClienteFalso();
  const mercado = new MercadoFalso();
  const analise = new ServicoAnalise({ db, cliente, relogio });
  const app = buildApp({
    db,
    analise,
    cliente: mercado,
    relogio,
    timeoutPrecoMs: 50,
    ...extra,
  });
  return { app, analise, cliente, mercado, relogio };
}

/** Base de dados que não deve ser usada (testes sem Postgres). */
export const dbInutilizavel = new Proxy({} as Db, {
  get: () => {
    throw new Error('BD não disponível neste teste');
  },
});

/** Ligação SSE real (node:http, fora do `fetch` bloqueado) com o texto recebido acumulado. */
export interface LigacaoSse {
  resposta: IncomingMessage;
  texto: () => string;
  esperarPor: (padrao: RegExp, ms?: number) => Promise<string>;
  terminou: Promise<void>;
  fechar: () => void;
}

export function ligarSse(
  porta: number,
  caminho = '/api/stream',
  cabecalhos: Record<string, string> = {},
): Promise<LigacaoSse> {
  return new Promise((resolver, rejeitar) => {
    const pedido: ClientRequest = request(
      { host: '127.0.0.1', port: porta, path: caminho, headers: cabecalhos },
      (resposta) => {
        let recebido = '';
        const ouvintes = new Set<() => void>();
        resposta.setEncoding('utf8');
        resposta.on('data', (parte: string) => {
          recebido += parte;
          for (const o of [...ouvintes]) o();
        });
        const terminou = new Promise<void>((r) => {
          resposta.on('end', r);
          resposta.on('close', r);
        });
        resolver({
          resposta,
          texto: () => recebido,
          terminou,
          fechar: () => pedido.destroy(),
          esperarPor: (padrao, ms = 3_000) =>
            new Promise((ok, falha) => {
              const verificar = () => {
                const m = padrao.exec(recebido);
                if (!m) return;
                clearTimeout(t);
                ouvintes.delete(verificar);
                ok(m[0]);
              };
              const t = setTimeout(() => {
                ouvintes.delete(verificar);
                falha(new Error(`SSE sem ${padrao} em ${ms} ms; recebido:\n${recebido}`));
              }, ms);
              ouvintes.add(verificar);
              verificar();
            }),
        });
      },
    );
    pedido.on('error', rejeitar);
    pedido.end();
  });
}

/** Espera até a condição ser verdadeira (sondagem curta). */
export async function esperarAte(condicao: () => boolean, ms = 3_000): Promise<void> {
  const limite = Date.now() + ms;
  while (!condicao()) {
    if (Date.now() > limite) throw new Error('condição não satisfeita a tempo');
    await new Promise((r) => setTimeout(r, 5));
  }
}
