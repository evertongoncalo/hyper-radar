import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { pino, type Logger } from 'pino';
import type { ServicoAnalise } from './analise';
import type { Db } from './db/client';
import { relogioSistema, type Relogio } from './hyperliquid';
import { rotasAnalise } from './rotas/analise';
import { rotasAtivos } from './rotas/ativos';
import { rotasCarteiras } from './rotas/carteiras';
import { rotasDefinicoes } from './rotas/definicoes';
import { tratarErro } from './rotas/erros';
import { instalarFrontend } from './rotas/estatico';
import { rotasEventos } from './rotas/eventos';
import { rotasExportacao } from './rotas/exportacao';
import { rotasSaude } from './rotas/saude';
import { instalarSeguranca, type OpcoesSeguranca } from './rotas/seguranca';
import { rotasStream } from './rotas/stream';
import { rotasSugestao } from './rotas/sugestao';
import type { DependenciasRotas, FonteMercadoHyperliquid } from './rotas/tipos';

declare module 'fastify' {
  interface FastifyInstance {
    /** Serviço de análise usado pelas rotas e pelo SSE. */
    analise: ServicoAnalise;
  }
}

/** Limite global do corpo dos pedidos (a importação tem um limite próprio). */
export const LIMITE_CORPO_BYTES = 1024 * 1024;

export interface OpcoesApp {
  db: Db;
  analise: ServicoAnalise;
  /** Cliente Hyperliquid (validação de tickers e preço de mercado). */
  cliente: FonteMercadoHyperliquid;
  /** Instância pino a usar; se omitida, a aplicação não regista logs (útil em testes). */
  logger?: Logger;
  /** Relógio do heartbeat SSE e das datas geradas pela API (omissão: sistema). */
  relogio?: Relogio;
  seguranca?: OpcoesSeguranca;
  /** Pasta do build do frontend (`apps/web/dist`); `null`/inexistente = só API. */
  pastaWeb?: string | null;
  /** Omissão 2500 ms. */
  timeoutPrecoMs?: number;
  /** Omissão 25 s. */
  heartbeatSseMs?: number;
}

/** Constrói a aplicação Fastify sem a pôr a escutar. */
export function buildApp(opcoes: OpcoesApp) {
  const app = Fastify({
    // Tipado como logger base: os plugins de rotas usam o `FastifyInstance` por omissão.
    loggerInstance: (opcoes.logger ?? pino({ enabled: false })) as FastifyBaseLogger,
    bodyLimit: LIMITE_CORPO_BYTES,
    // Erros do próprio router (ex.: URL mal codificada) também no formato uniforme.
    frameworkErrors: (erro, pedido, resposta) => tratarErro(erro, pedido, resposta),
  });
  const deps: DependenciasRotas = {
    db: opcoes.db,
    analise: opcoes.analise,
    cliente: opcoes.cliente,
    relogio: opcoes.relogio ?? relogioSistema,
    timeoutPrecoMs: opcoes.timeoutPrecoMs ?? 2_500,
    heartbeatSseMs: opcoes.heartbeatSseMs ?? 25_000,
  };

  app.decorate('analise', opcoes.analise);
  // Só JSON: sem o parser de text/plain (corpo típico de formulários CSRF "simples").
  app.removeContentTypeParser('text/plain');
  app.setErrorHandler(tratarErro);
  instalarSeguranca(app, opcoes.seguranca);
  instalarFrontend(app, opcoes.pastaWeb ?? null);

  // Ligações SSE abertas: fechadas antes de o servidor parar, para o shutdown não ficar pendurado.
  const ligacoesSse = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of ligacoesSse) res.end();
  });

  void app.register(rotasSaude(deps));
  void app.register(
    async (api) => {
      await api.register(rotasAtivos(deps));
      await api.register(rotasCarteiras(deps));
      await api.register(rotasAnalise(deps));
      await api.register(rotasEventos(deps));
      await api.register(rotasDefinicoes(deps));
      await api.register(rotasExportacao(deps));
      await api.register(rotasSugestao(deps));
      await api.register(rotasStream(deps, ligacoesSse));
    },
    { prefix: '/api' },
  );

  return app;
}

export type App = ReturnType<typeof buildApp>;
