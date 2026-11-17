import type { ServerResponse } from 'node:http';
import { LIMITE_REENVIO_SSE, type NomeEventoSse } from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { EventoDetalhado } from '../repositorios';
import { listarEventosApos } from '../repositorios';
import { paraEventoDto, paraSseCiclo, paraSseEstado } from './mapeadores';
import type { DependenciasRotas } from './tipos';

/** Tempo sugerido ao browser para religar (`retry:`), em ms. */
export const RETRY_SSE_MS = 3_000;
/** Acima disto em buffer (cliente que não lê), a ligação é cortada para não crescer sem limite. */
const LIMITE_BUFFER_BYTES = 1024 * 1024;

/** Id inteiro positivo de `Last-Event-ID` (ou `?desdeId=`); qualquer outro valor é ignorado. */
function lerUltimoId(valor: unknown): number | null {
  const texto = Array.isArray(valor) ? valor[0] : valor;
  if (typeof texto !== 'string' || !/^\d{1,16}$/.test(texto.trim())) return null;
  const n = Number(texto.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * `GET /stream` (SSE sobre `reply.raw`, sem dependências): eventos nomeados `evento`,
 * `estado-ativo` e `ciclo`; `id:` = id do evento persistido; reenvio após `Last-Event-ID`;
 * heartbeat por comentário. `ligacoes` permite fechá-las no encerramento da app.
 */
export function rotasStream(
  deps: DependenciasRotas,
  ligacoes: Set<ServerResponse>,
): FastifyPluginAsync {
  return async (app) => {
    app.get('/stream', async (pedido, resposta) => {
      const query = pedido.query as Record<string, unknown> | undefined;
      const ultimoId = lerUltimoId(pedido.headers['last-event-id']) ?? lerUltimoId(query?.desdeId);
      const log = pedido.log;

      resposta.hijack();
      const res = resposta.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      });
      ligacoes.add(res);

      const escrever = (texto: string) => {
        if (res.destroyed || res.writableEnded) return;
        res.write(texto);
        if (res.writableLength > LIMITE_BUFFER_BYTES) {
          log.warn('Cliente SSE não acompanha; ligação cortada');
          res.destroy();
        }
      };
      const enviar = (nome: NomeEventoSse, dados: unknown, id?: number) =>
        escrever(
          `${id === undefined ? '' : `id: ${id}\n`}event: ${nome}\ndata: ${JSON.stringify(dados)}\n\n`,
        );

      // Durante o reenvio, os eventos ao vivo ficam em espera (sem buracos nem duplicados).
      let emReenvio = ultimoId !== null;
      let ultimoEnviado = ultimoId ?? 0;
      const pendentes: EventoDetalhado[] = [];
      const enviarEvento = (e: EventoDetalhado) => {
        if (e.id <= ultimoEnviado) return;
        ultimoEnviado = e.id;
        enviar('evento', paraEventoDto(e), e.id);
      };

      const cancelar = [
        deps.analise.barramento.on('evento', (e) => {
          if (emReenvio) pendentes.push(e);
          else enviarEvento(e);
        }),
        deps.analise.barramento.on('estado-ativo', (m) => enviar('estado-ativo', paraSseEstado(m))),
        deps.analise.barramento.on('ciclo', (c) => enviar('ciclo', paraSseCiclo(c))),
      ];

      let cancelarHeartbeat: (() => void) | null = null;
      const agendarHeartbeat = () => {
        cancelarHeartbeat = deps.relogio.agendar(() => {
          escrever(': ping\n\n');
          agendarHeartbeat();
        }, deps.heartbeatSseMs);
      };

      let limpo = false;
      const limpar = () => {
        if (limpo) return;
        limpo = true;
        for (const c of cancelar) c();
        cancelarHeartbeat?.();
        ligacoes.delete(res);
      };
      res.on('close', limpar);
      res.on('error', limpar);

      escrever(`retry: ${RETRY_SSE_MS}\n\n`);
      agendarHeartbeat();

      if (ultimoId !== null) {
        try {
          const perdidos = await listarEventosApos(deps.db, ultimoId, LIMITE_REENVIO_SSE);
          for (const e of perdidos) enviarEvento(e);
        } catch (erro) {
          log.error({ err: erro }, 'Falha ao reenviar eventos SSE');
        }
        emReenvio = false;
        for (const e of pendentes.splice(0)) enviarEvento(e);
      }
    });
  };
}
