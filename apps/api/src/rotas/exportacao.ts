import {
  importacaoPedidoSchema,
  VERSAO_EXPORTACAO,
  type Exportacao,
  type ImportacaoResposta,
} from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import {
  associarCarteira,
  atualizarDefinicoes,
  criarAtivo,
  criarOuObterCarteira,
  listarAtivos,
  listarCarteirasComAtivos,
  obterAtivoPorTicker,
  obterCarteiraPorEndereco,
  obterDefinicoes,
  type AlteracaoDefinicoes,
  type DadosCarteira,
  type Definicoes,
} from '../repositorios';
import { analisar } from './erros';
import type { DependenciasRotas } from './tipos';
import { reiniciarSeAtiva } from './util';

/** A importação pode trazer muitas carteiras: limite próprio, acima do global. */
const LIMITE_CORPO_IMPORTACAO = 5 * 1024 * 1024;

const CAMPOS_DEFINICOES = [
  'capitalUsd',
  'alavancagemMaxima',
  'riscoPorOperacaoPct',
  'intervaloRecolhaSegundos',
  'limiteDiarioChamadasIa',
  'limiteDiarioTokensIa',
] as const satisfies readonly (keyof Definicoes)[];

const camposDefinicoes = (d: Definicoes) =>
  Object.fromEntries(CAMPOS_DEFINICOES.map((k) => [k, d[k]])) as Required<AlteracaoDefinicoes>;

/** Backup em JSON (secção 12): ativos, carteiras, associações e definições; sem snapshots/eventos. */
export function rotasExportacao(deps: DependenciasRotas): FastifyPluginAsync {
  return async (app) => {
    app.get('/exportacao', async (_pedido, resposta): Promise<Exportacao> => {
      const [ativos, carteiras, definicoes] = await Promise.all([
        listarAtivos(deps.db),
        listarCarteirasComAtivos(deps.db),
        obterDefinicoes(deps.db),
      ]);
      const agora = new Date(deps.relogio.agora());
      resposta.header(
        'content-disposition',
        `attachment; filename="hyperradar-${agora.toISOString().slice(0, 10)}.json"`,
      );
      return {
        versao: VERSAO_EXPORTACAO,
        exportadoEm: agora.toISOString(),
        carteiras: carteiras.map((c) => ({
          endereco: c.endereco,
          alias: c.alias,
          entidade: c.entidade,
        })),
        ativos: ativos.map((a) => ({
          ticker: a.ticker,
          carteiras: carteiras
            .filter((c) => c.ativos.some((x) => x.id === a.id))
            .map((c) => c.endereco),
        })),
        definicoes: camposDefinicoes(definicoes),
      };
    });

    /**
     * Importação idempotente e aditiva: cria o que falta, nunca apaga. Alias/entidade só são
     * escritos quando o ficheiro os traz (um `null` não limpa o valor atual).
     */
    app.post(
      '/importacao',
      { bodyLimit: LIMITE_CORPO_IMPORTACAO },
      async (pedido): Promise<ImportacaoResposta> => {
        const dados = analisar(importacaoPedidoSchema, pedido.body, 'body');
        const r = await deps.db.transaction(async (tx) => {
          let carteirasCriadas = 0;
          let carteirasAtualizadas = 0;
          let ativosCriados = 0;
          let associacoesCriadas = 0;
          const afetados = new Set<number>();
          const idPorEndereco = new Map<string, number>();

          for (const c of dados.carteiras) {
            const existente = await obterCarteiraPorEndereco(tx, c.endereco);
            const novo: DadosCarteira = { endereco: c.endereco };
            if (c.alias !== null) novo.alias = c.alias;
            if (c.entidade !== null) novo.entidade = c.entidade;
            const gravada = await criarOuObterCarteira(tx, novo);
            if (!existente) carteirasCriadas += 1;
            else if (existente.alias !== gravada.alias || existente.entidade !== gravada.entidade)
              carteirasAtualizadas += 1;
            idPorEndereco.set(gravada.endereco, gravada.id);
          }

          for (const a of dados.ativos) {
            let ativo = await obterAtivoPorTicker(tx, a.ticker);
            if (!ativo) {
              // Sem validação na Hyperliquid: o ficheiro vem de uma exportação desta aplicação.
              ativo = await criarAtivo(tx, a.ticker);
              ativosCriados += 1;
            }
            for (const endereco of a.carteiras) {
              if (await associarCarteira(tx, ativo.id, idPorEndereco.get(endereco)!)) {
                associacoesCriadas += 1;
                afetados.add(ativo.id);
              }
            }
          }

          let definicoesAtualizadas = false;
          if (dados.definicoes) {
            const atuais = camposDefinicoes(await obterDefinicoes(tx));
            const diferentes = CAMPOS_DEFINICOES.some((k) => atuais[k] !== dados.definicoes![k]);
            if (diferentes) {
              await atualizarDefinicoes(tx, dados.definicoes);
              definicoesAtualizadas = true;
            }
          }
          return {
            carteirasCriadas,
            carteirasAtualizadas,
            ativosCriados,
            associacoesCriadas,
            definicoesAtualizadas,
            afetados,
          };
        });

        // Depois do commit: ativos em análise com carteiras novas recomeçam (nova linha de base).
        const analisesReiniciadas: number[] = [];
        for (const assetId of r.afetados) {
          if (await reiniciarSeAtiva(deps.analise, assetId, 'importação de carteiras')) {
            analisesReiniciadas.push(assetId);
          }
        }
        return {
          ativosCriados: r.ativosCriados,
          carteirasCriadas: r.carteirasCriadas,
          carteirasAtualizadas: r.carteirasAtualizadas,
          associacoesCriadas: r.associacoesCriadas,
          definicoesAtualizadas: r.definicoesAtualizadas,
          analisesReiniciadas,
        };
      },
    );
  };
}
