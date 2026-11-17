// Pré-carregado no processo da API (`node --import`) pelos scripts de arranque local.
// No Windows não há SIGINT/SIGTERM entre processos: o `stop` cria um ficheiro-sinal e este
// módulo, ao detetá-lo, emite SIGINT no próprio processo, acionando o encerramento limpo da API.
import { existsSync, rmSync } from 'node:fs';

const ficheiro = process.env.HYPERRADAR_FICHEIRO_PARAGEM;

if (ficheiro) {
  const vigia = setInterval(() => {
    if (!existsSync(ficheiro)) return;
    clearInterval(vigia);
    rmSync(ficheiro, { force: true });
    process.emit('SIGINT');
  }, 500);
  // Não impede o processo de terminar.
  vigia.unref();
}
