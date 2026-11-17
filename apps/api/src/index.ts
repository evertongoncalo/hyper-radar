import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { ServicoAnalise } from './analise';
import { buildApp } from './app';
import { carregarConfig } from './config';
import { criarDb } from './db/client';
import { ClienteHyperliquid, URL_BASE_OFICIAL } from './hyperliquid';
import { ClienteOpenAi, ServicoIa } from './ia';
import { URL_OPENAI_OMISSAO } from './ia/cliente-openai';

// O servidor escuta apenas em 127.0.0.1: a aplicação é local e não deve ficar exposta na rede.
const HOST = '127.0.0.1';
// Build do frontend (apps/web/dist): o mesmo caminho relativo a partir de src/ (tsx) e dist/.
const PASTA_WEB = fileURLToPath(new URL('../../web/dist', import.meta.url));

const config = carregarConfig();
const logger = pino({ level: config.LOG_LEVEL });
const { db, fechar } = criarDb(config.DATABASE_URL);
const cliente = new ClienteHyperliquid({ urlBase: config.HYPERLIQUID_API_URL });
if (
  config.HYPERLIQUID_API_URL !== URL_BASE_OFICIAL ||
  config.OPENAI_BASE_URL !== URL_OPENAI_OMISSAO
) {
  logger.warn('URLs base não oficiais configuradas (HYPERLIQUID_API_URL/OPENAI_BASE_URL).');
}
const analise = new ServicoAnalise({
  db,
  cliente,
  logger: logger.child({ modulo: 'analise' }),
  diasRetencao: config.SNAPSHOT_RETENTION_DAYS,
});
// Análise IA: só por pedido manual (rota POST); sem chave fica indisponível (503).
const ia = new ServicoIa({
  db,
  analise,
  mercado: cliente,
  gerador: new ClienteOpenAi({ chave: config.OPENAI_API_KEY, urlBase: config.OPENAI_BASE_URL }),
  modelo: config.OPENAI_MODEL,
  logger: logger.child({ modulo: 'ia' }),
});
if (!ia.configurada) logger.info('OPENAI_API_KEY não definida: a Análise IA fica indisponível.');
const app = buildApp({
  db,
  analise,
  cliente,
  ia,
  logger,
  seguranca: { porta: config.PORT, origensPermitidas: config.ALLOWED_ORIGINS },
  pastaWeb: PASTA_WEB,
});

try {
  await app.listen({ host: HOST, port: config.PORT });
} catch (erro) {
  app.log.error(erro, 'Falha ao arrancar o servidor');
  await fechar();
  process.exit(1);
}

// Retoma as análises que estavam ativas quando o servidor foi abaixo (falhas só são registadas).
try {
  await analise.retomarAtivos();
} catch (erro) {
  app.log.error(erro, 'Falha ao retomar as análises');
}

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sinal, () => {
    app.log.info(`Sinal ${sinal} recebido; a encerrar.`);
    void (async () => {
      try {
        await app.close();
        // Pára os ciclos sem alterar o estado dos ativos (retomam no próximo arranque).
        await analise.encerrar();
        await fechar();
        process.exit(0);
      } catch (erro) {
        app.log.error(erro, 'Falha no encerramento');
        process.exit(1);
      }
    })();
  });
}
