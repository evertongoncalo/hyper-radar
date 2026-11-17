import {
  AVISO_LEGAL,
  listarRelatoriosIaQuerySchema,
  paramsIdSchema,
  pedidoAnaliseIaSchema,
  type EstadoIa,
  type PaginaRelatoriosIa,
  type RelatorioIaDto,
  type RespostaAnaliseIa,
} from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ServicoIa } from '../ia';
import { listarRelatoriosIa, obterRelatorioIa } from '../repositorios';
import { obterAtivoOu404 } from './ativos';
import { analisar, naoEncontrado } from './erros';
import { paraRelatorioIaDto, paraResumoRelatorioIa } from './mapeadores';
import type { DependenciasRotas } from './tipos';

/** Análise IA: só o `POST` chama a OpenAI (pedido manual do utilizador). */
export function rotasIa(deps: DependenciasRotas, ia: ServicoIa): FastifyPluginAsync {
  return async (app) => {
    app.post('/ativos/:id/ia/analise', async (pedido): Promise<RespostaAnaliseIa> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      // Corpo opcional: sem corpo equivale a `{}`.
      const { forcar } = analisar(pedidoAnaliseIaSchema, pedido.body ?? {}, 'body');
      await obterAtivoOu404(deps, id);
      const r = await ia.analisar(id, { forcar: forcar === true });
      return {
        relatorio: paraRelatorioIaDto(r.relatorio),
        daCache: r.daCache,
        custoEstimadoUsd: r.custoEstimadoUsd,
        avisoLegal: AVISO_LEGAL,
      };
    });

    app.get('/ativos/:id/ia/relatorios', async (pedido): Promise<PaginaRelatoriosIa> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      const q = analisar(listarRelatoriosIaQuerySchema, pedido.query, 'query');
      await obterAtivoOu404(deps, id);
      const pagina = await listarRelatoriosIa(deps.db, id, {
        cursor: q.cursor ?? null,
        ...(q.limite === undefined ? {} : { limite: q.limite }),
      });
      return {
        itens: pagina.itens.map(paraResumoRelatorioIa),
        proximoCursor: pagina.proximoCursor,
      };
    });

    app.get('/ia/relatorios/:id', async (pedido): Promise<RelatorioIaDto> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      const relatorio = await obterRelatorioIa(deps.db, id);
      if (!relatorio) throw naoEncontrado('Relatório IA', id);
      return paraRelatorioIaDto(relatorio);
    });

    app.get('/ia/estado', async (): Promise<EstadoIa> => {
      const e = await ia.estado();
      return {
        configurada: e.configurada,
        modelo: e.modelo,
        modeloComPreco: e.modeloComPreco,
        precos: [...ia.precos()],
        hoje: e.hoje,
      };
    });
  };
}
