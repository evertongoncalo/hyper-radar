import { alterarDefinicoesPedidoSchema, type DefinicoesComIaDto } from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import { atualizarDefinicoes, obterDefinicoes } from '../repositorios';
import { analisar } from './erros';
import { paraDefinicoesComIaDto } from './mapeadores';
import type { DependenciasRotas } from './tipos';
import { semIndefinidos } from './util';

/**
 * Definições do utilizador (o novo intervalo aplica-se a partir do próximo ciclo), com o modelo
 * IA configurado (só de leitura).
 */
export function rotasDefinicoes(deps: DependenciasRotas, modeloIa: string): FastifyPluginAsync {
  return async (app) => {
    app.get('/definicoes', async (): Promise<DefinicoesComIaDto> =>
      paraDefinicoesComIaDto(await obterDefinicoes(deps.db), modeloIa),
    );

    app.patch('/definicoes', async (pedido): Promise<DefinicoesComIaDto> => {
      const alteracao = analisar(alterarDefinicoesPedidoSchema, pedido.body, 'body');
      return paraDefinicoesComIaDto(
        await atualizarDefinicoes(deps.db, semIndefinidos(alteracao)),
        modeloIa,
      );
    });
  };
}
