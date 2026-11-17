import type { RespostaSaudeServidor } from '@hyper-radar/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { DependenciasRotas } from './tipos';

/** `GET /health` (na raiz): estado da BD e nº de ativos em análise; 503 se a BD não responder. */
export function rotasSaude(deps: Pick<DependenciasRotas, 'db' | 'analise'>): FastifyPluginAsync {
  return async (app) => {
    app.get('/health', async (pedido, resposta): Promise<RespostaSaudeServidor> => {
      let bdOk = true;
      try {
        await deps.db.execute(sql`select 1`);
      } catch (erro) {
        bdOk = false;
        pedido.log.warn({ err: erro }, 'Base de dados indisponível');
      }
      resposta.status(bdOk ? 200 : 503);
      return {
        status: bdOk ? 'ok' : 'degradado',
        bd: bdOk ? 'ok' : 'indisponivel',
        ativosEmAnalise: deps.analise.ativosEmAnalise().length,
      };
    });
  };
}
