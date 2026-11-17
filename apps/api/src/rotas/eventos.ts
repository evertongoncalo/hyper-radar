import {
  listarEventosQuerySchema,
  paramsIdEventoSchema,
  paramsIdSchema,
  type ContagemNaoLidos,
  type EventoLidoResposta,
  type EventosLidosResposta,
  type PaginaEventosDto,
} from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import {
  contarEventosNaoLidosPorAtivo,
  listarEventos,
  marcarEventoLido,
  marcarEventosDoAtivoLidos,
} from '../repositorios';
import { obterAtivoOu404 } from './ativos';
import { analisar, naoEncontrado } from './erros';
import { paraEventoDto } from './mapeadores';
import type { DependenciasRotas } from './tipos';
import { semIndefinidos } from './util';

/** Feed/histórico de eventos (filtros + cursor) e marcação como lidos. */
export function rotasEventos(deps: DependenciasRotas): FastifyPluginAsync {
  return async (app) => {
    app.get('/eventos', async (pedido): Promise<PaginaEventosDto> => {
      const q = analisar(listarEventosQuerySchema, pedido.query, 'query');
      const pagina = await listarEventos(
        deps.db,
        semIndefinidos({
          assetId: q.ativo,
          walletId: q.carteira,
          tipos: q.tipos,
          apenasNaoLidos: q.naoLidos,
          desde: q.desde === undefined ? undefined : new Date(q.desde),
          ate: q.ate === undefined ? undefined : new Date(q.ate),
          cursor: q.cursor,
          limite: q.limite,
        }),
      );
      return { itens: pagina.itens.map(paraEventoDto), proximoCursor: pagina.proximoCursor };
    });

    app.get('/eventos/nao-lidos/contagem', async (): Promise<ContagemNaoLidos> => {
      const porAtivo = [...(await contarEventosNaoLidosPorAtivo(deps.db))]
        .map(([assetId, naoLidos]) => ({ assetId, naoLidos }))
        .sort((a, b) => a.assetId - b.assetId);
      return { total: porAtivo.reduce((s, a) => s + a.naoLidos, 0), porAtivo };
    });

    app.post('/eventos/:id/lido', async (pedido): Promise<EventoLidoResposta> => {
      const { id } = analisar(paramsIdEventoSchema, pedido.params, 'params');
      if (!(await marcarEventoLido(deps.db, id))) throw naoEncontrado('Evento', id);
      return { id, lido: true };
    });

    app.post('/ativos/:id/eventos/lidos', async (pedido): Promise<EventosLidosResposta> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      await obterAtivoOu404(deps, id);
      return { marcados: await marcarEventosDoAtivoLidos(deps.db, id) };
    });
  };
}
