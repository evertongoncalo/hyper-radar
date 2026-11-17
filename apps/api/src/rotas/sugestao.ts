import {
  AVISO_LEGAL,
  paramsIdSchema,
  sugestaoQuerySchema,
  type AvisoSugestaoDto,
  type LadoPosicao,
  type RespostaSugestao,
  type SugestaoCarteiraDto,
} from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import { calcularSugestao } from '../proporcional/calculo';
import {
  listarCarteirasDoAtivo,
  obterDefinicoes,
  obterRunAtivo,
  ultimosSnapshotsPorCarteira,
  type SnapshotCompleto,
} from '../repositorios';
import { obterAtivoOu404, precoMercado } from './ativos';
import { analisar, ErroApi } from './erros';
import type { DependenciasRotas } from './tipos';

/** Sugestão proporcional por carteira (cálculo local; nunca envia ordens). */
export function rotasSugestao(deps: DependenciasRotas): FastifyPluginAsync {
  return async (app) => {
    app.get('/ativos/:id/sugestao', async (pedido): Promise<RespostaSugestao> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      const { carteira: carteiraId } = analisar(sugestaoQuerySchema, pedido.query, 'query');
      const ativo = await obterAtivoOu404(deps, id);
      const definicoes = await obterDefinicoes(deps.db);
      if (!(definicoes.capitalUsd > 0)) {
        throw new ErroApi(
          422,
          'CAPITAL_NAO_CONFIGURADO',
          'Configure o capital disponível em Definições para obter a sugestão proporcional.',
        );
      }

      const carteiras = await listarCarteirasDoAtivo(deps.db, id);
      if (carteiraId !== undefined && !carteiras.some((c) => c.id === carteiraId)) {
        throw new ErroApi(
          404,
          'NAO_ENCONTRADO',
          `Carteira ${carteiraId} não encontrada neste ativo.`,
        );
      }

      // Último snapshot do run atual; sem run (ou run ainda vazio), o último disponível.
      const saude = deps.analise.obterSaude(id);
      const analiseAtiva = saude !== null;
      const run = await obterRunAtivo(deps.db, id);
      let snapshots: SnapshotCompleto[] = run
        ? await ultimosSnapshotsPorCarteira(deps.db, id, { runId: run.id })
        : [];
      if (snapshots.length === 0) snapshots = await ultimosSnapshotsPorCarteira(deps.db, id);
      const porCarteira = new Map(snapshots.map((s) => [s.walletId, s]));

      const [preco, meta] = await Promise.all([
        precoMercado(deps, ativo, snapshots),
        deps.cliente.meta(ativo.dex),
      ]);
      const metaAtivo = meta.ativos.find((a) => a.coin === ativo.ticker) ?? null;
      const desatualizadas = new Set(saude?.carteirasDesatualizadas ?? []);
      const agoraMs = deps.relogio.agora();

      const avisosRota: AvisoSugestaoDto[] = [];
      if (!analiseAtiva) {
        avisosRota.push({
          codigo: 'ANALISE_INATIVA',
          nivel: 'atencao',
          mensagem: 'A análise deste ativo não está ativa: usa-se o último snapshot disponível.',
        });
      }
      if (preco?.fonte === 'snapshot') {
        avisosRota.push({
          codigo: 'PRECO_DO_SNAPSHOT',
          nivel: 'atencao',
          mensagem: 'Preço ao vivo indisponível: usa-se o último preço gravado num snapshot.',
        });
      }

      const alvo =
        carteiraId === undefined ? carteiras : carteiras.filter((c) => c.id === carteiraId);
      const itens = alvo
        .map((c) => {
          const snap = porCarteira.get(c.id) ?? null;
          // Outras carteiras da mesma entidade com posição neste ativo (deteção de hedge).
          const ladosOutras: LadoPosicao[] =
            c.entidade === null
              ? []
              : carteiras
                  .filter((o) => o.id !== c.id && o.entidade === c.entidade)
                  .map((o) => porCarteira.get(o.id)?.posicao?.lado)
                  .filter((l): l is LadoPosicao => l !== undefined);
          const sugestao = calcularSugestao({
            definicoes,
            baleia: {
              posicao: snap?.posicao
                ? {
                    lado: snap.posicao.lado,
                    tamanho: snap.posicao.tamanho,
                    entryPx: snap.posicao.entryPx,
                    alavancagem: snap.posicao.alavancagem,
                    tipoMargem: snap.posicao.tipoMargem,
                    marginUsed: snap.posicao.marginUsed,
                    notional: snap.posicao.notional,
                    liquidationPx: snap.posicao.liquidationPx,
                  }
                : null,
              accountValue: snap?.accountValue ?? 0,
              accountValueRepresentativo: snap?.accountValueRepresentativo ?? true,
              modoConta: snap?.modoConta ?? null,
              protecoes: snap?.ordens ?? [],
            },
            precoAtual: preco?.valor ?? 0,
            ativo: metaAtivo,
            entidade: { nome: c.entidade, ladosOutrasCarteiras: ladosOutras },
            frescura: snap
              ? {
                  instanteSnapshotMs: snap.instante.getTime(),
                  agoraMs,
                  intervaloRecolhaSegundos: definicoes.intervaloRecolhaSegundos,
                  leituraFalhou: desatualizadas.has(c.id),
                }
              : null,
          });
          sugestao.avisos.unshift(...avisosRota);
          const item: SugestaoCarteiraDto = {
            carteira: { id: c.id, endereco: c.endereco, alias: c.alias, entidade: c.entidade },
            instanteSnapshot: snap ? snap.instante.toISOString() : null,
            runId: snap?.runId ?? null,
            sugestao,
          };
          return {
            item,
            temPosicao: snap?.posicao != null,
            notional: snap?.posicao?.notional ?? 0,
          };
        })
        // Sem `carteira`: só as carteiras com posição.
        .filter((x) => carteiraId !== undefined || x.temPosicao)
        .sort((a, b) => b.notional - a.notional || a.item.carteira.id - b.item.carteira.id);

      return {
        ativoId: ativo.id,
        ticker: ativo.ticker,
        analiseAtiva,
        precoMercado: preco,
        definicoes: {
          capitalUsd: definicoes.capitalUsd,
          alavancagemMaxima: definicoes.alavancagemMaxima,
          riscoPorOperacaoPct: definicoes.riscoPorOperacaoPct,
        },
        sugestoes: itens.map((x) => x.item),
        avisoLegal: AVISO_LEGAL,
      };
    });
  };
}
