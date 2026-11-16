import Fastify from 'fastify';
import { pino, type Logger } from 'pino';

export interface OpcoesApp {
  /** Instância pino a usar; se omitida, a aplicação não regista logs (útil em testes). */
  logger?: Logger;
}

/** Constrói a aplicação Fastify sem a pôr a escutar. */
export function buildApp(opcoes: OpcoesApp = {}) {
  const app = Fastify({ loggerInstance: opcoes.logger ?? pino({ enabled: false }) });

  app.get('/health', () => ({ status: 'ok' as const }));

  return app;
}

export type App = ReturnType<typeof buildApp>;
