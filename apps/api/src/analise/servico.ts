import type { EstadoCarteiraNoAtivo } from '@hyper-radar/shared';
import { pino, type Logger } from 'pino';
import type { Db } from '../db/client';
import { relogioSistema, type Relogio } from '../hyperliquid/relogio';
import {
  calcularAgregados,
  calcularVariacao,
  CONFIG_OMISSAO,
  criarEstadoInicial,
  processarSnapshot,
  snapshotDeEstado,
  type AgregadoAtivo,
  type ConfigMotor,
  type EstadoAgregador,
  type SnapshotCarteira,
  type VariacaoAgregado,
} from '../motor';
import {
  abrirRun,
  alterarEstadoAtivo,
  apagarAtivo,
  apagarSnapshotsAnterioresA,
  ErroNaoEncontrado,
  fecharRun,
  gravarEventos,
  gravarSnapshot,
  listarAtivosParaRetomar,
  listarCarteirasDoAtivo,
  obterAtivoPorId,
  obterDefinicoes,
  obterRunAtivo,
  ultimosSnapshotsPorCarteira,
  type Ativo,
  type Carteira,
  type EstadoAtivo,
  type Evento,
} from '../repositorios';
import { BarramentoAnalise } from './barramento';
import { deSnapshotGravado, paraNovoSnapshot } from './conversao';
import {
  ErroAnaliseJaEmCurso,
  ErroAnaliseNaoEmCurso,
  ErroAtivoSemCarteiras,
  ErroServicoEncerrado,
} from './erros';

/** Interface mínima do cliente Hyperliquid de que o serviço precisa (substituível em testes). */
export interface FonteEstadoCarteira {
  obterEstadoCarteiraNoAtivo(user: string, ticker: string): Promise<EstadoCarteiraNoAtivo>;
}

export const INTERVALO_MINIMO_S = 15;
export const INTERVALO_OMISSAO_S = 60;
export const RETENCAO_OMISSAO_DIAS = 30;
export const MOTIVO_ARRANQUE = 'arranque do servidor';
const HORA = 3_600_000;
const DIA = 24 * HORA;

export interface OpcoesServicoAnalise {
  db: Db;
  cliente: FonteEstadoCarteira;
  relogio?: Relogio;
  logger?: Logger;
  config?: ConfigMotor;
  barramento?: BarramentoAnalise;
  /** Dias de retenção dos snapshots (omissão 30). */
  diasRetencao?: number;
}

/** Saúde da recolha de um ativo em análise (indicador "dados desatualizados" da UI). */
export interface SaudeAnalise {
  assetId: number;
  ticker: string;
  runId: number;
  cicloEmCurso: boolean;
  /** Fim do último ciclo com sucesso (≥ 1 carteira lida e gravada). */
  ultimoCicloSucesso: Date | null;
  ultimoErro: { mensagem: string; instante: Date } | null;
  /** Carteiras cuja última leitura falhou (ids). */
  carteirasDesatualizadas: number[];
}

export interface AgregadosAtivo {
  atual: AgregadoAtivo;
  variacao1h: VariacaoAgregado | null;
  variacao24h: VariacaoAgregado | null;
}

/** Estado em memória de um ativo em análise (um por run). */
interface Execucao {
  assetId: number;
  ticker: string;
  runId: number;
  ativa: boolean;
  estadoMotor: EstadoAgregador;
  /** Último snapshot gravado de cada carteira neste run (base do diff). */
  anteriores: Map<number, SnapshotCarteira>;
  cancelarTemporizador: (() => void) | null;
  cicloEmCurso: Promise<void> | null;
  ultimoCicloSucesso: Date | null;
  ultimoErro: { mensagem: string; instante: Date } | null;
  desatualizadas: Set<number>;
}

const mensagemDe = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro));

/**
 * Orquestra a análise por ativo (secção 2): máquina de estados, ciclos de polling sem
 * sobreposição, persistência de snapshots/eventos e publicação no barramento.
 */
export class ServicoAnalise {
  readonly barramento: BarramentoAnalise;
  private readonly db: Db;
  private readonly cliente: FonteEstadoCarteira;
  private readonly relogio: Relogio;
  private readonly logger: Logger;
  private readonly config: ConfigMotor;
  private readonly diasRetencao: number;
  private readonly execucoes = new Map<number, Execucao>();
  private readonly filas = new Map<number, Promise<unknown>>();
  private intervaloConhecidoS = INTERVALO_OMISSAO_S;
  private cancelarRetencao: (() => void) | null = null;
  private encerrado = false;

  constructor(opcoes: OpcoesServicoAnalise) {
    this.db = opcoes.db;
    this.cliente = opcoes.cliente;
    this.relogio = opcoes.relogio ?? relogioSistema;
    this.logger = opcoes.logger ?? pino({ enabled: false });
    this.config = opcoes.config ?? CONFIG_OMISSAO;
    this.barramento = opcoes.barramento ?? new BarramentoAnalise(this.logger);
    this.diasRetencao = opcoes.diasRetencao ?? RETENCAO_OMISSAO_DIAS;
  }

  // ------------------------------------------------------------------ transições

  /** `idle|stopped → running`: abre um run e faz a linha de base (sem eventos). */
  iniciar(assetId: number): Promise<Ativo> {
    return this.exclusivo(assetId, async () => {
      this.garantirAberto();
      const ativo = await this.obterAtivo(assetId);
      if (
        this.execucoes.has(assetId) ||
        ativo.estado === 'running' ||
        ativo.estado === 'restarting'
      )
        throw new ErroAnaliseJaEmCurso(ativo.ticker);
      const carteiras = await listarCarteirasDoAtivo(this.db, assetId);
      if (carteiras.length === 0) throw new ErroAtivoSemCarteiras(ativo.ticker);
      return this.arrancarRun(ativo, null);
    });
  }

  /** `running → stopped`: cancela o temporizador, espera o ciclo em curso e fecha o run. */
  parar(assetId: number): Promise<Ativo> {
    return this.exclusivo(assetId, async () => {
      const ativo = await this.obterAtivo(assetId);
      const ex = this.execucoes.get(assetId);
      if (!ex && ativo.estado !== 'running' && ativo.estado !== 'restarting')
        throw new ErroAnaliseNaoEmCurso(ativo.ticker);
      if (ex) await this.desativar(ex);
      // Sem ciclos neste processo (ex.: antes da retoma), fecha o run que estiver aberto.
      const runId = ex?.runId ?? (await obterRunAtivo(this.db, assetId))?.id ?? null;
      return this.pararNaBd(ativo, runId);
    });
  }

  /**
   * Apaga o ativo dentro da serialização por ativo: pára os ciclos, espera o ciclo em curso,
   * fecha o run e apaga o ativo (numa transação). Qualquer transição posterior para este id
   * (ex.: `iniciar`) encontra-o inexistente e falha com `ErroNaoEncontrado`.
   */
  removerAtivo(assetId: number): Promise<void> {
    return this.exclusivo(assetId, async () => {
      const ativo = await this.obterAtivo(assetId);
      const ex = this.execucoes.get(assetId);
      if (ex) await this.desativar(ex);
      const runId = ex?.runId ?? (await obterRunAtivo(this.db, assetId))?.id ?? null;
      const apagado = await this.db.transaction(async (tx) => {
        if (runId !== null) await fecharRun(tx, runId);
        return apagarAtivo(tx, assetId);
      });
      this.execucoes.delete(assetId);
      if (!apagado) throw new ErroNaoEncontrado('Ativo', assetId);
      this.logger.info({ assetId, runId }, 'Ativo apagado');
      if (ex || ativo.estado === 'running' || ativo.estado === 'restarting') {
        this.publicarEstado({ ...ativo, estado: 'stopped' }, ativo.estado, null);
      }
    });
  }

  /**
   * Após adicionar/remover carteiras: `running → restarting → running` com novo run, estado do
   * agregador descartado e nova linha de base. Sem carteiras, pára. Sem análise, não faz nada.
   */
  reiniciar(assetId: number, motivo: string): Promise<Ativo | null> {
    return this.exclusivo(assetId, async () => {
      const ex = this.execucoes.get(assetId);
      if (!ex || this.encerrado) return null;
      const ativo = await alterarEstadoAtivo(this.db, assetId, 'restarting');
      this.publicarEstado(ativo, 'running', ex.runId);
      await this.desativar(ex);
      const carteiras = await listarCarteirasDoAtivo(this.db, assetId);
      if (carteiras.length === 0) {
        this.logger.info({ assetId }, 'Ativo sem carteiras após alteração; análise parada');
        return this.pararNaBd(ativo, ex.runId);
      }
      return this.arrancarRun(ativo, motivo);
    });
  }

  /**
   * Arranque do servidor: retoma os ativos que estavam em `running`/`restarting` com novo run
   * e linha de base, e arma a retenção diária de snapshots. Falhas por ativo são registadas.
   */
  async retomarAtivos(): Promise<Ativo[]> {
    this.garantirAberto();
    this.agendarRetencao(0);
    const ativos = await listarAtivosParaRetomar(this.db);
    const resultados = await Promise.allSettled(
      ativos.map((a) =>
        this.exclusivo(a.id, async () => {
          if (this.execucoes.has(a.id)) return null;
          const ativo = await this.obterAtivo(a.id);
          const carteiras = await listarCarteirasDoAtivo(this.db, a.id);
          if (carteiras.length === 0) {
            const run = await obterRunAtivo(this.db, a.id);
            return this.pararNaBd(ativo, run?.id ?? null);
          }
          return this.arrancarRun(ativo, MOTIVO_ARRANQUE);
        }),
      ),
    );
    const retomados: Ativo[] = [];
    resultados.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        if (r.value?.estado === 'running') retomados.push(r.value);
      } else {
        this.logger.error({ err: r.reason, assetId: ativos[i]!.id }, 'Falha ao retomar a análise');
      }
    });
    this.logger.info({ retomados: retomados.length }, 'Análises retomadas no arranque');
    return retomados;
  }

  /**
   * Encerramento do servidor: pára todos os ciclos e fecha os runs **sem** alterar o estado dos
   * ativos na BD (para retomarem no próximo arranque).
   */
  async encerrar(): Promise<void> {
    this.encerrado = true;
    this.cancelarRetencao?.();
    this.cancelarRetencao = null;
    const lista = [...this.execucoes.values()];
    await Promise.all(
      lista.map(async (ex) => {
        await this.desativar(ex);
        try {
          await fecharRun(this.db, ex.runId);
        } catch (erro) {
          this.logger.error(
            { err: erro, runId: ex.runId },
            'Falha ao fechar o run no encerramento',
          );
        }
      }),
    );
    this.execucoes.clear();
    await Promise.allSettled([...this.filas.values()]);
  }

  // ------------------------------------------------------------------ consultas

  /** Saúde da recolha do ativo; `null` se não estiver em análise. */
  obterSaude(assetId: number): SaudeAnalise | null {
    const ex = this.execucoes.get(assetId);
    if (!ex) return null;
    return {
      assetId,
      ticker: ex.ticker,
      runId: ex.runId,
      cicloEmCurso: ex.cicloEmCurso !== null,
      ultimoCicloSucesso: ex.ultimoCicloSucesso,
      ultimoErro: ex.ultimoErro,
      carteirasDesatualizadas: [...ex.desatualizadas].sort((a, b) => a - b),
    };
  }

  /** Ids dos ativos com ciclos ativos neste processo. */
  ativosEmAnalise(): number[] {
    return [...this.execucoes.keys()].sort((a, b) => a - b);
  }

  /**
   * Agregados do run atual (último snapshot de cada carteira do ativo) e variação face a 1 h e
   * 24 h. Sem run em curso, o agregado atual fica vazio.
   */
  async obterAgregados(assetId: number): Promise<AgregadosAtivo> {
    const ativo = await this.obterAtivo(assetId);
    const carteiras = await listarCarteirasDoAtivo(this.db, assetId);
    const porId = new Map(carteiras.map((c) => [c.id, c]));
    const entidades: Record<string, string> = {};
    for (const c of carteiras) if (c.entidade) entidades[c.endereco] = c.entidade;

    const runId = this.execucoes.get(assetId)?.runId ?? (await obterRunAtivo(this.db, assetId))?.id;
    const agora = this.relogio.agora();
    const converter = (lista: Awaited<ReturnType<typeof ultimosSnapshotsPorCarteira>>) =>
      lista.flatMap((s) => {
        const c = porId.get(s.walletId);
        return c ? [deSnapshotGravado(s, c.endereco, ativo.ticker)] : [];
      });

    const atuais =
      runId === undefined
        ? []
        : converter(await ultimosSnapshotsPorCarteira(this.db, assetId, { runId }));
    const atual = calcularAgregados(ativo.ticker, atuais, { entidades });

    // Estado há `periodo`: último snapshot de cada carteira até esse instante, desde que não
    // seja mais antigo do que outro `periodo` (senão não representa aquele momento).
    const passado = async (periodo: number) => {
      const lista = converter(
        await ultimosSnapshotsPorCarteira(this.db, assetId, { ate: new Date(agora - periodo) }),
      ).filter((s) => s.instante >= agora - 2 * periodo);
      return lista.length === 0 ? null : calcularAgregados(ativo.ticker, lista, { entidades });
    };
    const [h1, h24] = await Promise.all([passado(HORA), passado(DIA)]);
    return {
      atual,
      variacao1h: calcularVariacao(atual, h1),
      variacao24h: calcularVariacao(atual, h24),
    };
  }

  // ------------------------------------------------------------------ retenção

  /** Apaga snapshots com mais de `diasRetencao` dias (eventos e relatórios não são tocados). */
  async aplicarRetencao(): Promise<number> {
    const limite = new Date(this.relogio.agora() - this.diasRetencao * DIA);
    const apagados = await apagarSnapshotsAnterioresA(this.db, limite);
    this.logger.info({ apagados, limite }, 'Retenção de snapshots aplicada');
    return apagados;
  }

  private agendarRetencao(ms: number): void {
    this.cancelarRetencao?.();
    this.cancelarRetencao = this.relogio.agendar(() => {
      this.cancelarRetencao = null;
      if (this.encerrado) return;
      void this.aplicarRetencao()
        .catch((erro: unknown) => this.logger.error({ err: erro }, 'Falha na retenção'))
        .finally(() => {
          if (!this.encerrado) this.agendarRetencao(DIA);
        });
    }, ms);
  }

  // ------------------------------------------------------------------ ciclos

  /** Abre um run (fechando o anterior), passa a `running` e corre a linha de base. */
  private async arrancarRun(ativo: Ativo, motivo: string | null): Promise<Ativo> {
    const { run, atualizado } = await this.db.transaction(async (tx) => {
      const run = await abrirRun(tx, ativo.id, motivo);
      const atualizado = await alterarEstadoAtivo(tx, ativo.id, 'running');
      return { run, atualizado };
    });
    // `encerrar()` correu durante esta transição (ex.: reiniciar a meio): não arrancar ciclos
    // órfãos. O run fecha-se e o estado fica `running`, para retomar no próximo arranque.
    if (this.encerrado) {
      await fecharRun(this.db, run.id);
      return atualizado;
    }
    const ex: Execucao = {
      assetId: ativo.id,
      ticker: ativo.ticker,
      runId: run.id,
      ativa: true,
      estadoMotor: criarEstadoInicial(),
      anteriores: new Map(),
      cancelarTemporizador: null,
      cicloEmCurso: null,
      ultimoCicloSucesso: null,
      ultimoErro: null,
      desatualizadas: new Set(),
    };
    this.execucoes.set(ativo.id, ex);
    this.logger.info({ assetId: ativo.id, runId: run.id, motivo }, 'Análise iniciada');
    this.publicarEstado(atualizado, ativo.estado, run.id);
    await this.correrCiclo(ex);
    return atualizado;
  }

  private async pararNaBd(ativo: Ativo, runId: number | null): Promise<Ativo> {
    const atualizado = await this.db.transaction(async (tx) => {
      if (runId !== null) await fecharRun(tx, runId);
      return alterarEstadoAtivo(tx, ativo.id, 'stopped');
    });
    this.execucoes.delete(ativo.id);
    this.logger.info({ assetId: ativo.id, runId }, 'Análise parada');
    this.publicarEstado(atualizado, ativo.estado, null);
    return atualizado;
  }

  /** Impede novos ciclos e espera o ciclo em curso (se houver) terminar. */
  private async desativar(ex: Execucao): Promise<void> {
    ex.ativa = false;
    ex.cancelarTemporizador?.();
    ex.cancelarTemporizador = null;
    await ex.cicloEmCurso;
  }

  /**
   * Corre um ciclo e, no fim, agenda o seguinte com o intervalo relido das definições. Nunca
   * rejeita. Como o próximo ciclo só é agendado depois de este terminar, nunca há dois ciclos
   * do mesmo ativo em simultâneo.
   */
  private correrCiclo(ex: Execucao): Promise<void> {
    const promessa = (async () => {
      await this.executarCiclo(ex);
      if (!ex.ativa) return;
      const ms = (await this.intervaloSegundos()) * 1000;
      if (!ex.ativa) return;
      ex.cancelarTemporizador = this.relogio.agendar(() => {
        ex.cancelarTemporizador = null;
        if (ex.ativa) void this.correrCiclo(ex);
      }, ms);
    })();
    ex.cicloEmCurso = promessa;
    void promessa.finally(() => {
      if (ex.cicloEmCurso === promessa) ex.cicloEmCurso = null;
    });
    return promessa;
  }

  private async intervaloSegundos(): Promise<number> {
    try {
      const { intervaloRecolhaSegundos } = await obterDefinicoes(this.db);
      this.intervaloConhecidoS = Math.max(INTERVALO_MINIMO_S, intervaloRecolhaSegundos);
    } catch (erro) {
      this.logger.warn({ err: erro }, 'Falha ao ler o intervalo; a usar o último conhecido');
    }
    return this.intervaloConhecidoS;
  }

  private async executarCiclo(ex: Execucao): Promise<void> {
    const inicio = this.relogio.agora();
    let ok = 0;
    let falhadas = 0;
    let publicados = 0;
    let erroGeral: string | null = null;
    try {
      const carteiras = await listarCarteirasDoAtivo(this.db, ex.assetId);
      const leituras = await Promise.allSettled(
        carteiras.map((c) => this.cliente.obterEstadoCarteiraNoAtivo(c.endereco, ex.ticker)),
      );
      let primeiroErro: string | null = null;
      for (const [i, leitura] of leituras.entries()) {
        const carteira = carteiras[i]!;
        if (leitura.status === 'rejected') {
          // Falha de leitura ≠ posição fechada: sem snapshot nem eventos; base do diff intacta.
          falhadas += 1;
          ex.desatualizadas.add(carteira.id);
          primeiroErro ??= mensagemDe(leitura.reason);
          this.logger.warn(
            { err: leitura.reason, assetId: ex.assetId, walletId: carteira.id },
            'Falha ao ler a carteira; fica desatualizada neste ciclo',
          );
          continue;
        }
        const inseridos = await this.processarCarteira(ex, carteira, leitura.value, inicio);
        ex.desatualizadas.delete(carteira.id);
        ok += 1;
        for (const e of inseridos) {
          this.barramento.emitir('evento', {
            ...e,
            ticker: ex.ticker,
            endereco: carteira.endereco,
            alias: carteira.alias,
          });
        }
        publicados += inseridos.length;
      }
      if (ok === 0 && carteiras.length > 0) erroGeral = primeiroErro;
      else if (primeiroErro) ex.ultimoErro = { mensagem: primeiroErro, instante: new Date(inicio) };
    } catch (erro) {
      erroGeral = mensagemDe(erro);
      this.logger.error({ err: erro, assetId: ex.assetId }, 'Ciclo de análise falhou');
    }

    const fim = this.relogio.agora();
    if (erroGeral !== null) ex.ultimoErro = { mensagem: erroGeral, instante: new Date(fim) };
    else ex.ultimoCicloSucesso = new Date(fim);
    this.barramento.emitir('ciclo', {
      assetId: ex.assetId,
      ticker: ex.ticker,
      runId: ex.runId,
      instante: new Date(fim),
      duracaoMs: fim - inicio,
      carteirasOk: ok,
      carteirasFalhadas: falhadas,
      eventos: publicados,
      falhou: erroGeral !== null,
      erro: erroGeral,
    });
  }

  /**
   * Converte, corre o motor e grava snapshot + eventos numa transação. O estado em memória só
   * avança depois do commit (uma falha da BD não perde eventos: o ciclo seguinte repete o diff).
   * Devolve apenas os eventos efetivamente inseridos.
   */
  private async processarCarteira(
    ex: Execucao,
    carteira: Carteira,
    estado: EstadoCarteiraNoAtivo,
    instante: number,
  ): Promise<Evento[]> {
    const atual = snapshotDeEstado(estado, instante);
    const anterior = ex.anteriores.get(carteira.id) ?? null;
    const { estado: novoEstado, eventos } = processarSnapshot(
      ex.estadoMotor,
      anterior,
      atual,
      this.config,
    );
    const inseridos = await this.db.transaction(async (tx) => {
      await gravarSnapshot(tx, paraNovoSnapshot(atual, ex.runId, carteira.id));
      return gravarEventos(
        tx,
        eventos.map((e) => ({
          tipo: e.tipo,
          walletId: carteira.id,
          assetId: ex.assetId,
          runId: ex.runId,
          payload: e.payload as unknown as Record<string, unknown>,
          dedupeKey: e.chaveDedupe,
          criadoEm: new Date(e.instante),
        })),
      );
    });
    ex.estadoMotor = novoEstado;
    ex.anteriores.set(carteira.id, atual);
    return inseridos;
  }

  // ------------------------------------------------------------------ auxiliares

  private publicarEstado(ativo: Ativo, anterior: EstadoAtivo, runId: number | null): void {
    this.barramento.emitir('estado-ativo', {
      assetId: ativo.id,
      ticker: ativo.ticker,
      anterior,
      estado: ativo.estado,
      runId,
      instante: new Date(this.relogio.agora()),
    });
  }

  private async obterAtivo(assetId: number): Promise<Ativo> {
    const ativo = await obterAtivoPorId(this.db, assetId);
    if (!ativo) throw new ErroNaoEncontrado('Ativo', assetId);
    return ativo;
  }

  private garantirAberto(): void {
    if (this.encerrado) throw new ErroServicoEncerrado();
  }

  /** Serializa as transições de um mesmo ativo (iniciar/parar/reiniciar/retomar/remover). */
  private exclusivo<T>(assetId: number, operacao: () => Promise<T>): Promise<T> {
    const anterior = this.filas.get(assetId) ?? Promise.resolve();
    const atual = anterior.then(operacao);
    const cauda = atual.then(
      () => undefined,
      () => undefined,
    );
    this.filas.set(assetId, cauda);
    void cauda.then(() => {
      if (this.filas.get(assetId) === cauda) this.filas.delete(assetId);
    });
    return atual;
  }
}
