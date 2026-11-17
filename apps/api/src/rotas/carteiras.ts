import {
  adicionarCarteiraPedidoSchema,
  alterarCarteiraPedidoSchema,
  paramsCarteiraDoAtivoSchema,
  paramsIdSchema,
  type AdicionarCarteiraResposta,
  type CarteiraComAtivosDto,
  type CarteiraDto,
} from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import {
  alterarCarteira,
  apagarCarteira,
  associarCarteira,
  criarOuObterCarteira,
  desassociarCarteira,
  listarCarteirasComAtivos,
  listarIdsAtivosDaCarteira,
  obterCarteiraPorId,
} from '../repositorios';
import { obterAtivoOu404 } from './ativos';
import { analisar, ErroApi, naoEncontrado } from './erros';
import { paraCarteiraDto } from './mapeadores';
import type { DependenciasRotas } from './tipos';
import { reiniciarSeAtiva, semIndefinidos } from './util';

/** Carteiras de um ativo (associar/desassociar) e gestão global de carteiras. */
export function rotasCarteiras(deps: DependenciasRotas): FastifyPluginAsync {
  return async (app) => {
    app.post(
      '/ativos/:id/carteiras',
      async (pedido, resposta): Promise<AdicionarCarteiraResposta> => {
        const { id } = analisar(paramsIdSchema, pedido.params, 'params');
        const dados = analisar(adicionarCarteiraPedidoSchema, pedido.body, 'body');
        const ativo = await obterAtivoOu404(deps, id);

        // Numa transação: se já estiver associada, nem o alias/entidade são alterados.
        const carteira = await deps.db.transaction(async (tx) => {
          const c = await criarOuObterCarteira(tx, {
            endereco: dados.endereco,
            ...semIndefinidos({ alias: dados.alias, entidade: dados.entidade }),
          });
          if (!(await associarCarteira(tx, id, c.id))) {
            throw new ErroApi(
              409,
              'CARTEIRA_JA_ASSOCIADA',
              `A carteira ${c.endereco} já está associada a "${ativo.ticker}".`,
            );
          }
          return c;
        });

        const analiseReiniciada = await reiniciarSeAtiva(
          deps.analise,
          id,
          `carteira adicionada (${carteira.endereco})`,
        );
        resposta.status(201);
        return { carteira: paraCarteiraDto(carteira), analiseReiniciada };
      },
    );

    app.delete('/ativos/:id/carteiras/:carteiraId', async (pedido, resposta) => {
      const { id, carteiraId } = analisar(paramsCarteiraDoAtivoSchema, pedido.params, 'params');
      const ativo = await obterAtivoOu404(deps, id);
      if (!(await desassociarCarteira(deps.db, id, carteiraId))) {
        throw new ErroApi(
          404,
          'NAO_ENCONTRADO',
          `A carteira ${carteiraId} não está associada a "${ativo.ticker}".`,
        );
      }
      await reiniciarSeAtiva(deps.analise, id, `carteira removida (${carteiraId})`);
      return resposta.status(204).send();
    });

    app.get('/carteiras', async (): Promise<CarteiraComAtivosDto[]> => {
      const lista = await listarCarteirasComAtivos(deps.db);
      return lista.map((c) => ({ ...paraCarteiraDto(c), ativos: c.ativos }));
    });

    app.patch('/carteiras/:id', async (pedido): Promise<CarteiraDto> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      const dados = analisar(alterarCarteiraPedidoSchema, pedido.body, 'body');
      return paraCarteiraDto(await alterarCarteira(deps.db, id, semIndefinidos(dados)));
    });

    app.delete('/carteiras/:id', async (pedido, resposta) => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      if (!(await obterCarteiraPorId(deps.db, id))) throw naoEncontrado('Carteira', id);
      const ativos = await listarIdsAtivosDaCarteira(deps.db, id);
      await apagarCarteira(deps.db, id);
      // Cada ativo afetado em análise recomeça com nova linha de base (sem a carteira).
      for (const assetId of ativos) {
        await reiniciarSeAtiva(deps.analise, assetId, `carteira apagada (${id})`);
      }
      return resposta.status(204).send();
    });
  };
}
