import { alterarDefinicoesPedidoSchema, type DefinicoesDto } from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import { atualizarDefinicoes, obterDefinicoes } from '../repositorios';
import { analisar } from './erros';
import { paraDefinicoesDto } from './mapeadores';
import type { DependenciasRotas } from './tipos';
import { semIndefinidos } from './util';

/** Definições do utilizador (o novo intervalo aplica-se a partir do próximo ciclo). */
export function rotasDefinicoes(deps: DependenciasRotas): FastifyPluginAsync {
  return async (app) => {
    app.get('/definicoes', async (): Promise<DefinicoesDto> =>
      paraDefinicoesDto(await obterDefinicoes(deps.db)),
    );

    app.patch('/definicoes', async (pedido): Promise<DefinicoesDto> => {
      const alteracao = analisar(alterarDefinicoesPedidoSchema, pedido.body, 'body');
      return paraDefinicoesDto(await atualizarDefinicoes(deps.db, semIndefinidos(alteracao)));
    });
  };
}
