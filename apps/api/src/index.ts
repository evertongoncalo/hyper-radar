import { pino } from 'pino';
import { buildApp } from './app';
import { carregarConfig } from './config';

// O servidor escuta apenas em 127.0.0.1: a aplicação é local e não deve ficar exposta na rede.
const HOST = '127.0.0.1';

const config = carregarConfig();
const logger = pino({ level: config.LOG_LEVEL });
const app = buildApp({ logger });

try {
  await app.listen({ host: HOST, port: config.PORT });
} catch (erro) {
  app.log.error(erro, 'Falha ao arrancar o servidor');
  process.exit(1);
}

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sinal, () => {
    app.log.info(`Sinal ${sinal} recebido; a encerrar.`);
    void app.close().then(() => process.exit(0));
  });
}
