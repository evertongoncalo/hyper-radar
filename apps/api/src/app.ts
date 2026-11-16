import Fastify from 'fastify';
import { pino, type Logger } from 'pino';
import type { ServicoAnalise } from './analise';

declare module 'fastify' {
  interface FastifyInstance {
    /** Serviço de análise (rotas e SSE da Fase 3); `null` quando a app é construída sem BD. */
    analise: ServicoAnalise | null;
  }
}

export interface OpcoesApp {
  /** Instância pino a usar; se omitida, a aplicação não regista logs (útil em testes). */
  logger?: Logger;
  /** Serviço de análise; omitido nos testes que não precisam de BD. */
  analise?: ServicoAnalise;
}

/** Constrói a aplicação Fastify sem a pôr a escutar. */
export function buildApp(opcoes: OpcoesApp = {}) {
  const app = Fastify({ loggerInstance: opcoes.logger ?? pino({ enabled: false }) });

  app.decorate('analise', opcoes.analise ?? null);

  app.get('/health', () => ({ status: 'ok' as const }));

  return app;
}

export type App = ReturnType<typeof buildApp>;
