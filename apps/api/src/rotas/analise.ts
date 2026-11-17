import { paramsIdSchema, type AgregadosAtivoResposta, type AtivoResumo } from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import { resumoDoAtivo } from './ativos';
import { analisar } from './erros';
import { paraAgregadosDto } from './mapeadores';
import type { DependenciasRotas } from './tipos';

/** Iniciar/parar a análise de um ativo e consultar os agregados. */
export function rotasAnalise(deps: DependenciasRotas): FastifyPluginAsync {
  return async (app) => {
    app.post('/ativos/:id/analise/iniciar', async (pedido): Promise<AtivoResumo> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      // Inclui a linha de base (primeiro ciclo, sem eventos).
      return resumoDoAtivo(deps, await deps.analise.iniciar(id));
    });

    app.post('/ativos/:id/analise/parar', async (pedido): Promise<AtivoResumo> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      return resumoDoAtivo(deps, await deps.analise.parar(id));
    });

    app.get('/ativos/:id/agregados', async (pedido): Promise<AgregadosAtivoResposta> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      return paraAgregadosDto(await deps.analise.obterAgregados(id));
    });
  };
}
