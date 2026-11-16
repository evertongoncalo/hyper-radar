import { count, eq, isNull } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { analysisRuns, events, snapshots } from '../db/schema';
import { ErroCircuitoAberto, ErroRede } from '../hyperliquid';
import {
  abrirRun,
  alterarEstadoAtivo,
  associarCarteira,
  atualizarDefinicoes,
  criarAtivo,
  criarOuObterCarteira,
  desassociarCarteira,
  ErroNaoEncontrado,
  fecharRun,
  gravarEventos,
  gravarSnapshot,
  obterAtivoPorId,
  obterRunAtivo,
} from '../repositorios';
import { criarAmbiente, disponivel, enderecoFicticio } from '../repositorios/__testes__/ambiente';
import {
  adiada,
  ClienteFalso,
  estadoCarteira,
  gravador,
  MINUTO,
  RelogioFalso,
  T0,
} from './__testes__/auxiliares';
import { BarramentoAnalise } from './barramento';
import {
  ErroAnaliseJaEmCurso,
  ErroAnaliseNaoEmCurso,
  ErroAtivoSemCarteiras,
  ErroServicoEncerrado,
} from './erros';
import { MOTIVO_ARRANQUE, ServicoAnalise } from './servico';

const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

/** Espera (em tempo real) que a condição se verifique; falha ao fim de 5 s. */
async function aguardar(condicao: () => boolean | Promise<boolean>, rotulo = 'condição') {
  const limite = Date.now() + 5_000;
  while (!(await condicao())) {
    if (Date.now() > limite) throw new Error(`Tempo esgotado à espera de: ${rotulo}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let n = 0;

function montar(db: ReturnType<typeof criarAmbiente>['db']) {
  const relogio = new RelogioFalso(T0);
  const cliente = new ClienteFalso();
  const barramento = new BarramentoAnalise();
  const recebido = gravador(barramento);
  const servico = new ServicoAnalise({
    db,
    cliente,
    relogio,
    barramento,
    logger: pino({ enabled: false }),
  });

  /** Cria um ativo com `k` carteiras (endereços fictícios únicos). */
  async function ativoCom(k: number) {
    n += 1;
    const ativo = await criarAtivo(db, `SA${n}`);
    const carteiras = [];
    for (let i = 0; i < k; i++) {
      const c = await criarOuObterCarteira(db, {
        endereco: enderecoFicticio(0x5000 + n * 10 + i),
        alias: `baleia-${i}`,
        entidade: i === 0 ? 'Entidade X' : null,
      });
      await associarCarteira(db, ativo.id, c.id);
      carteiras.push(c);
    }
    return { ativo, carteiras };
  }

  /** Avança até ao próximo ciclo agendado e espera que termine (incluindo o agendamento). */
  async function ciclo(assetId: number, ms = MINUTO) {
    relogio.avancar(ms);
    await aguardar(() => servico.obterSaude(assetId)?.cicloEmCurso !== true, 'fim do ciclo');
  }

  const contar = async (tabela: typeof snapshots | typeof events, assetId: number) => {
    const [l] = await db.select({ n: count() }).from(tabela).where(eq(tabela.assetId, assetId));
    return l!.n;
  };

  return { relogio, cliente, barramento, recebido, servico, ativoCom, ciclo, contar };
}

describe.skipIf(!disponivel)(
  'ServicoAnalise (relógio e cliente falsos, Postgres real)',
  { timeout: 20_000 },
  () => {
    const ambiente = criarAmbiente();
    const { db } = ambiente;
    let atual: ReturnType<typeof montar> | undefined;
    const novo = () => (atual = montar(db));

    beforeAll(() => ambiente.preparar());
    afterEach(async () => {
      await atual?.servico.encerrar();
      atual = undefined;
    });
    afterAll(() => ambiente.limpar());

    it('iniciar: idle → running, abre run e faz linha de base sem eventos', async () => {
      const { servico, cliente, ativoCom, recebido, relogio, contar } = novo();
      const { ativo, carteiras } = await ativoCom(2);
      cliente.definir(carteiras[0]!.endereco, estadoCarteira({ tamanho: 100 }));
      cliente.definir(carteiras[1]!.endereco, estadoCarteira({ tamanho: 50, lado: 'short' }));

      const r = await servico.iniciar(ativo.id);

      expect(r.estado).toBe('running');
      const run = await obterRunAtivo(db, ativo.id);
      expect(run).not.toBeNull();
      expect(await contar(snapshots, ativo.id)).toBe(2);
      expect(await contar(events, ativo.id)).toBe(0);
      expect(recebido.evento).toHaveLength(0);
      expect(recebido['estado-ativo']).toMatchObject([
        { assetId: ativo.id, anterior: 'idle', estado: 'running', runId: run!.id },
      ]);
      expect(recebido.ciclo).toMatchObject([
        { carteirasOk: 2, carteirasFalhadas: 0, eventos: 0, falhou: false, erro: null },
      ]);
      expect(relogio.pendentes(MINUTO)).toBe(1);
      expect(servico.ativosEmAnalise()).toEqual([ativo.id]);
      expect(servico.obterSaude(ativo.id)).toMatchObject({
        runId: run!.id,
        ultimoCicloSucesso: new Date(T0),
        ultimoErro: null,
        carteirasDesatualizadas: [],
      });
      expect(cliente.chamadas.every((c) => c.ticker === ativo.ticker)).toBe(true);
    });

    it('iniciar recusa ativo sem carteiras, já em curso ou inexistente', async () => {
      const { servico, cliente, ativoCom } = novo();
      const vazio = await ativoCom(0);
      await expect(servico.iniciar(vazio.ativo.id)).rejects.toBeInstanceOf(ErroAtivoSemCarteiras);
      expect((await obterAtivoPorId(db, vazio.ativo.id))!.estado).toBe('idle');

      const { ativo, carteiras } = await ativoCom(1);
      cliente.definir(carteiras[0]!.endereco, estadoCarteira());
      await servico.iniciar(ativo.id);
      await expect(servico.iniciar(ativo.id)).rejects.toBeInstanceOf(ErroAnaliseJaEmCurso);
      await expect(servico.iniciar(999_999)).rejects.toBeInstanceOf(ErroNaoEncontrado);
    });

    it('parar: running → stopped, fecha o run e cancela o temporizador; volta a iniciar', async () => {
      const { servico, cliente, ativoCom, relogio, recebido } = novo();
      const { ativo, carteiras } = await ativoCom(1);
      cliente.definir(carteiras[0]!.endereco, estadoCarteira({ tamanho: 10 }));
      await servico.iniciar(ativo.id);
      const run = await obterRunAtivo(db, ativo.id);

      const parado = await servico.parar(ativo.id);
      expect(parado.estado).toBe('stopped');
      expect(await obterRunAtivo(db, ativo.id)).toBeNull();
      const [fechado] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, run!.id));
      expect(fechado!.endedAt).not.toBeNull();
      expect(relogio.pendentes()).toBe(0);
      expect(servico.obterSaude(ativo.id)).toBeNull();
      expect(recebido['estado-ativo'].at(-1)).toMatchObject({
        anterior: 'running',
        estado: 'stopped',
        runId: null,
      });
      await expect(servico.parar(ativo.id)).rejects.toBeInstanceOf(ErroAnaliseNaoEmCurso);

      // stopped → running com run novo.
      await servico.iniciar(ativo.id);
      const novoRun = await obterRunAtivo(db, ativo.id);
      expect(novoRun!.id).not.toBe(run!.id);
    });

    it('parar espera o ciclo em curso terminar antes de fechar o run', async () => {
      const { servico, cliente, ativoCom, relogio, contar } = novo();
      const { ativo, carteiras } = await ativoCom(1);
      const lenta = adiada<ReturnType<typeof estadoCarteira>>();
      cliente.definir(carteiras[0]!.endereco, estadoCarteira({ tamanho: 10 }), lenta.promessa);
      await servico.iniciar(ativo.id);

      relogio.avancar(MINUTO);
      expect(servico.obterSaude(ativo.id)!.cicloEmCurso).toBe(true);
      let terminou = false;
      const parar = servico.parar(ativo.id).then(() => (terminou = true));
      await new Promise((r) => setTimeout(r, 30));
      expect(terminou).toBe(false);

      lenta.resolver(estadoCarteira({ tamanho: 10 }));
      await parar;
      expect(await contar(snapshots, ativo.id)).toBe(2);
      expect(relogio.pendentes()).toBe(0);
    });

    it('ciclos sem sobreposição; o próximo é agendado a partir do fim do anterior', async () => {
      const { servico, cliente, ativoCom, relogio, ciclo } = novo();
      const { ativo, carteiras } = await ativoCom(1);
      const lenta = adiada<ReturnType<typeof estadoCarteira>>();
      cliente.definir(
        carteiras[0]!.endereco,
        estadoCarteira({ tamanho: 10 }),
        lenta.promessa,
        estadoCarteira({ tamanho: 10 }),
      );
      await servico.iniciar(ativo.id);
      expect(cliente.chamadas).toHaveLength(1);

      relogio.avancar(MINUTO); // arranca o 2.º ciclo, que fica pendurado
      await aguardar(() => cliente.chamadas.length === 2, '2.ª leitura');
      relogio.avancar(10 * MINUTO); // nenhum temporizador: nada de ciclos sobrepostos
      await new Promise((r) => setTimeout(r, 30));
      expect(cliente.chamadas).toHaveLength(2);
      expect(relogio.pendentes()).toBe(0);

      const fimLento = relogio.agora();
      lenta.resolver(estadoCarteira({ tamanho: 10 }));
      await aguardar(() => relogio.pendentes() === 1, 'agendamento após ciclo lento');
      relogio.avancar(MINUTO - 1);
      expect(cliente.chamadas).toHaveLength(2);
      await ciclo(ativo.id, 1);
      expect(cliente.chamadas).toHaveLength(3);
      expect(relogio.agora()).toBe(fimLento + MINUTO);
    });

    it('o intervalo é relido das definições a cada ciclo', async () => {
      const { servico, cliente, ativoCom, relogio, ciclo } = novo();
      const { ativo, carteiras } = await ativoCom(1);
      cliente.definir(carteiras[0]!.endereco, estadoCarteira());
      try {
        await servico.iniciar(ativo.id);
        expect(relogio.pedidos.at(-1)).toBe(60_000);
        await atualizarDefinicoes(db, { intervaloRecolhaSegundos: 15 });
        await ciclo(ativo.id);
        expect(relogio.pedidos.at(-1)).toBe(15_000);
        await atualizarDefinicoes(db, { intervaloRecolhaSegundos: 120 });
        await ciclo(ativo.id, 15_000);
        expect(relogio.pedidos.at(-1)).toBe(120_000);
      } finally {
        await atualizarDefinicoes(db, { intervaloRecolhaSegundos: 60 });
      }
    });

    it('falha parcial: a carteira falhada não gera CLOSED nem snapshot e fica desatualizada', async () => {
      const { servico, cliente, ativoCom, ciclo, recebido, contar } = novo();
      const { ativo, carteiras } = await ativoCom(2);
      const [a, b] = carteiras as [(typeof carteiras)[0], (typeof carteiras)[0]];
      cliente.definir(a.endereco, estadoCarteira({ tamanho: 100 }));
      cliente.definir(
        b.endereco,
        estadoCarteira({ tamanho: 100 }),
        new ErroRede(new Error('ECONNRESET')),
        () => Promise.reject(new Error('rede outra vez')),
        // Rejeição que não é `Error` (ex.: biblioteca de terceiros): a mensagem é o texto.
        () => Promise.reject('falha crua' as unknown as Error),
        estadoCarteira({ tamanho: 100 }),
      );
      await servico.iniciar(ativo.id);

      await ciclo(ativo.id);
      expect(recebido.ciclo.at(-1)).toMatchObject({
        carteirasOk: 1,
        carteirasFalhadas: 1,
        falhou: false,
        eventos: 0,
      });
      expect(await contar(snapshots, ativo.id)).toBe(3);
      const saude = servico.obterSaude(ativo.id)!;
      expect(saude.carteirasDesatualizadas).toEqual([b.id]);
      expect(saude.ultimoErro?.mensagem).toMatch(/rede/i);
      expect(saude.ultimoCicloSucesso).toEqual(new Date(T0 + MINUTO));

      await ciclo(ativo.id);
      await ciclo(ativo.id);
      expect(servico.obterSaude(ativo.id)!.ultimoErro?.mensagem).toBe('falha crua');
      await ciclo(ativo.id);
      expect(servico.obterSaude(ativo.id)!.carteirasDesatualizadas).toEqual([]);
      expect(await contar(events, ativo.id)).toBe(0);
      expect(recebido.evento).toHaveLength(0);
    });

    it('circuito aberto: o ciclo falha, mantém running e recupera no seguinte', async () => {
      const { servico, cliente, ativoCom, ciclo, recebido, relogio } = novo();
      const { ativo, carteiras } = await ativoCom(2);
      for (const c of carteiras) {
        cliente.definir(
          c.endereco,
          estadoCarteira({ tamanho: 10 }),
          new ErroCircuitoAberto(30_000),
          estadoCarteira({ tamanho: 10 }),
        );
      }
      await servico.iniciar(ativo.id);
      await ciclo(ativo.id);

      expect(recebido.ciclo.at(-1)).toMatchObject({
        carteirasOk: 0,
        carteirasFalhadas: 2,
        falhou: true,
        erro: expect.stringMatching(/suspensos/),
      });
      expect((await obterAtivoPorId(db, ativo.id))!.estado).toBe('running');
      const saude = servico.obterSaude(ativo.id)!;
      expect(saude.ultimoCicloSucesso).toEqual(new Date(T0));
      expect(saude.carteirasDesatualizadas).toHaveLength(2);
      expect(relogio.pendentes(MINUTO)).toBe(1);

      await ciclo(ativo.id);
      expect(recebido.ciclo.at(-1)).toMatchObject({ falhou: false, carteirasOk: 2 });
      expect(recebido.evento).toHaveLength(0);
    });

    it('erro geral (BD) faz o ciclo falhar sem derrubar o serviço', async () => {
      const { servico, cliente, ativoCom, ciclo, recebido } = novo();
      const { ativo, carteiras } = await ativoCom(1);
      cliente.definir(carteiras[0]!.endereco, estadoCarteira({ tamanho: 10 }));
      await servico.iniciar(ativo.id);
      // Fecha o run por fora: gravarSnapshot passa a recusar.
      await fecharRun(db, servico.obterSaude(ativo.id)!.runId);
      await ciclo(ativo.id);
      expect(recebido.ciclo.at(-1)).toMatchObject({
        falhou: true,
        erro: expect.stringMatching(/terminou/),
      });
      expect(servico.ativosEmAnalise()).toEqual([ativo.id]);
    });

    it('reiniciar: novo run, linha de base nova e sem falsos OPENED', async () => {
      const { servico, cliente, ativoCom, ciclo, recebido, contar } = novo();
      const { ativo, carteiras } = await ativoCom(1);
      cliente.definir(carteiras[0]!.endereco, estadoCarteira({ tamanho: 100 }));
      await servico.iniciar(ativo.id);
      const runAntigo = servico.obterSaude(ativo.id)!.runId;

      // Nova carteira que já tem posição aberta.
      const nova = await criarOuObterCarteira(db, { endereco: enderecoFicticio(0x9001) });
      await associarCarteira(db, ativo.id, nova.id);
      cliente.definir(nova.endereco, estadoCarteira({ tamanho: 80, lado: 'short' }));

      const r = await servico.reiniciar(ativo.id, 'carteira adicionada');
      expect(r!.estado).toBe('running');
      const run = await obterRunAtivo(db, ativo.id);
      expect(run!.id).not.toBe(runAntigo);
      expect(run!.motivoReinicio).toBe('carteira adicionada');
      expect(recebido['estado-ativo'].slice(-2)).toMatchObject([
        { anterior: 'running', estado: 'restarting', runId: runAntigo },
        { anterior: 'restarting', estado: 'running', runId: run!.id },
      ]);

      await ciclo(ativo.id);
      await ciclo(ativo.id);
      expect(await contar(events, ativo.id)).toBe(0);
      expect(recebido.evento).toHaveLength(0);
    });

    it('reiniciar sem análise não faz nada; sem carteiras pára', async () => {
      const { servico, cliente, ativoCom, relogio } = novo();
      const { ativo, carteiras } = await ativoCom(1);
      expect(await servico.reiniciar(ativo.id, 'x')).toBeNull();
      expect((await obterAtivoPorId(db, ativo.id))!.estado).toBe('idle');

      cliente.definir(carteiras[0]!.endereco, estadoCarteira());
      await servico.iniciar(ativo.id);
      await desassociarCarteira(db, ativo.id, carteiras[0]!.id);
      const r = await servico.reiniciar(ativo.id, 'carteira removida');
      expect(r!.estado).toBe('stopped');
      expect(await obterRunAtivo(db, ativo.id)).toBeNull();
      expect(relogio.pendentes()).toBe(0);
    });

    it('parar um ativo marcado running na BD sem ciclos neste processo', async () => {
      const { servico, ativoCom } = novo();
      const { ativo } = await ativoCom(1);
      await abrirRun(db, ativo.id);
      await alterarEstadoAtivo(db, ativo.id, 'running');
      const r = await servico.parar(ativo.id);
      expect(r.estado).toBe('stopped');
      expect(await obterRunAtivo(db, ativo.id)).toBeNull();
      // Também sem run aberto.
      await alterarEstadoAtivo(db, ativo.id, 'restarting');
      expect((await servico.parar(ativo.id)).estado).toBe('stopped');
      // Omissões (relógio do sistema, logger silencioso) na construção.
      expect(
        new ServicoAnalise({ db, cliente: new ClienteFalso() }).obterSaude(ativo.id),
      ).toBeNull();
    });

    it('obterAgregados: run atual, entidades e variação face a 1 h / 24 h', async () => {
      const { servico, cliente, ativoCom, relogio } = novo();
      const { ativo, carteiras } = await ativoCom(2);
      const [a, b] = carteiras as [(typeof carteiras)[0], (typeof carteiras)[0]];

      // Sem run: agregado vazio, sem variações.
      const vazio = await servico.obterAgregados(ativo.id);
      expect(vazio.atual.totalCarteiras).toBe(0);
      expect(vazio.variacao1h).toBeNull();

      cliente.definir(a.endereco, estadoCarteira({ tamanho: 100 }));
      cliente.definir(b.endereco, estadoCarteira({ tamanho: 50, lado: 'short' }));
      await servico.iniciar(ativo.id);
      const runId = servico.obterSaude(ativo.id)!.runId;
      const agora = relogio.agora();
      const passado = (ms: number, tamanho: number) =>
        gravarSnapshot(db, {
          runId,
          walletId: a.id,
          accountValue: 1,
          marketPx: 100,
          instante: new Date(agora - ms),
          posicao: {
            lado: 'long',
            tamanho,
            entryPx: 100,
            alavancagem: 5,
            tipoMargem: 'cross',
            liquidationPx: null,
            unrealizedPnl: 0,
            marginUsed: 1,
            notional: tamanho * 100,
          },
          ordens: [],
        });
      await passado(HORA + MINUTO, 60);
      await passado(DIA + MINUTO, 20);

      const r = await servico.obterAgregados(ativo.id);
      expect(r.atual).toMatchObject({ totalCarteiras: 2, netUsd: 10_000 - 5_000 });
      expect(r.atual.entidades.map((e) => e.entidade).sort()).toEqual(
        ['Entidade X', b.endereco].sort(),
      );
      expect(r.variacao1h).toMatchObject({ longUsd: { absoluta: 10_000 - 6_000 } });
      expect(r.variacao24h).toMatchObject({ longUsd: { absoluta: 10_000 - 2_000 } });
      // Carteira removida: os seus snapshots deixam de contar.
      await desassociarCarteira(db, ativo.id, b.id);
      expect((await servico.obterAgregados(ativo.id)).atual.totalCarteiras).toBe(1);
      await expect(servico.obterAgregados(999_999)).rejects.toBeInstanceOf(ErroNaoEncontrado);
    });

    it('aplicarRetencao apaga snapshots antigos e não toca em eventos', async () => {
      const { ativoCom } = novo();
      const relogio = new RelogioFalso(T0);
      const servico = new ServicoAnalise({
        db,
        cliente: new ClienteFalso(),
        relogio,
        diasRetencao: 7,
      });
      const { ativo, carteiras } = await ativoCom(1);
      const run = await abrirRun(db, ativo.id);
      const gravar = (instante: number) =>
        gravarSnapshot(db, {
          runId: run.id,
          walletId: carteiras[0]!.id,
          accountValue: 1,
          marketPx: 1,
          instante: new Date(instante),
          posicao: null,
          ordens: [],
        });
      await gravar(T0 - 8 * DIA);
      await gravar(T0 - 6 * DIA);
      await gravarEventos(db, [
        {
          tipo: 'OPENED',
          walletId: carteiras[0]!.id,
          assetId: ativo.id,
          dedupeKey: `retencao-${ativo.id}`,
          criadoEm: new Date(T0 - 30 * DIA),
        },
      ]);

      expect(await servico.aplicarRetencao()).toBeGreaterThanOrEqual(1);
      const restantes = await db.select().from(snapshots).where(eq(snapshots.assetId, ativo.id));
      expect(restantes.map((s) => s.takenAt)).toEqual([new Date(T0 - 6 * DIA)]);
      const [ev] = await db.select({ n: count() }).from(events).where(eq(events.assetId, ativo.id));
      expect(ev!.n).toBe(1);
      await fecharRun(db, run.id);
    });
  },
);

describe.skipIf(!disponivel)(
  'ServicoAnalise: retoma no arranque e encerramento',
  { timeout: 20_000 },
  () => {
    // Schema próprio: a retoma considera todos os ativos `running`/`restarting` da BD.
    const ambiente = criarAmbiente();
    const { db } = ambiente;

    beforeAll(() => ambiente.preparar());
    afterAll(() => ambiente.limpar());

    it('retoma ativos running/restarting com novo run; encerrar não altera o estado', async () => {
      const carteira = await criarOuObterCarteira(db, { endereco: enderecoFicticio(0x7001) });
      const a1 = await criarAtivo(db, 'RET1');
      const a2 = await criarAtivo(db, 'RET2');
      const semCarteiras = await criarAtivo(db, 'RET3');
      const parado = await criarAtivo(db, 'RET4');
      for (const a of [a1, a2, parado]) await associarCarteira(db, a.id, carteira.id);
      const orfao = await abrirRun(db, a1.id);
      await alterarEstadoAtivo(db, a1.id, 'running');
      await alterarEstadoAtivo(db, a2.id, 'restarting');
      await abrirRun(db, semCarteiras.id);
      await alterarEstadoAtivo(db, semCarteiras.id, 'running');
      const semNada = await criarAtivo(db, 'RET5');
      await alterarEstadoAtivo(db, semNada.id, 'restarting');
      await alterarEstadoAtivo(db, parado.id, 'stopped');

      const relogio = new RelogioFalso(T0);
      const cliente = new ClienteFalso().definir(carteira.endereco, estadoCarteira({ tamanho: 5 }));
      const barramento = new BarramentoAnalise();
      const recebido = gravador(barramento);
      const servico = new ServicoAnalise({ db, cliente, relogio, barramento });

      const retomados = await servico.retomarAtivos();
      expect(retomados.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
      expect(servico.ativosEmAnalise()).toEqual([a1.id, a2.id].sort((x, y) => x - y));
      for (const a of [a1, a2]) {
        const run = await obterRunAtivo(db, a.id);
        expect(run!.motivoReinicio).toBe(MOTIVO_ARRANQUE);
        expect((await obterAtivoPorId(db, a.id))!.estado).toBe('running');
      }
      const [velho] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, orfao.id));
      expect(velho!.endedAt).not.toBeNull();
      expect((await obterAtivoPorId(db, semCarteiras.id))!.estado).toBe('stopped');
      expect(await obterRunAtivo(db, semCarteiras.id)).toBeNull();
      expect((await obterAtivoPorId(db, parado.id))!.estado).toBe('stopped');
      expect((await obterAtivoPorId(db, semNada.id))!.estado).toBe('stopped');
      expect(recebido.evento).toHaveLength(0);
      expect(recebido['estado-ativo']).toContainEqual(
        expect.objectContaining({ assetId: a2.id, anterior: 'restarting', estado: 'running' }),
      );

      // Retenção diária armada: corre já e volta a agendar-se para daqui a 24 h.
      relogio.avancar(0);
      await aguardar(() => relogio.pendentes(DIA) === 1, 'retenção reagendada');
      expect(await servico.retomarAtivos().catch(() => 'erro')).toEqual([]);

      await servico.encerrar();
      expect(relogio.pendentes()).toBe(0);
      expect(servico.ativosEmAnalise()).toEqual([]);
      const abertos = await db.select().from(analysisRuns).where(isNull(analysisRuns.endedAt));
      expect(abertos).toEqual([]);
      for (const a of [a1, a2]) expect((await obterAtivoPorId(db, a.id))!.estado).toBe('running');
      await expect(servico.iniciar(parado.id)).rejects.toBeInstanceOf(ErroServicoEncerrado);
      await expect(servico.retomarAtivos()).rejects.toBeInstanceOf(ErroServicoEncerrado);
      expect(await servico.reiniciar(a1.id, 'x')).toBeNull();

      // Novo processo: retoma de novo os mesmos ativos.
      const outro = new ServicoAnalise({ db, cliente, relogio: new RelogioFalso(T0) });
      expect((await outro.retomarAtivos()).map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
      await outro.encerrar();
      const [runs] = await db
        .select({ n: count() })
        .from(analysisRuns)
        .where(eq(analysisRuns.assetId, a1.id));
      expect(runs!.n).toBe(3);
    });
  },
);

describe.skipIf(!disponivel)(
  'ServicoAnalise: falhas de infraestrutura',
  { timeout: 20_000 },
  () => {
    const ambiente = criarAmbiente();
    const { db } = ambiente;

    beforeAll(() => ambiente.preparar());
    afterAll(() => ambiente.limpar());

    it('regista e contorna falhas da BD no intervalo, retoma, retenção e encerramento', async () => {
      // Proxy que faz falhar os métodos indicados da instância Drizzle (não as transações).
      const falhar = new Set<string>();
      const dbFalivel = new Proxy(db, {
        get(alvo, prop, recetor) {
          if (typeof prop === 'string' && falhar.has(prop)) {
            return () => {
              throw new Error(`BD indisponível (${prop})`);
            };
          }
          return Reflect.get(alvo, prop, recetor) as unknown;
        },
      });
      const logger = pino({ enabled: false });
      const aviso = vi.spyOn(logger, 'warn');
      const erro = vi.spyOn(logger, 'error');
      const relogio = new RelogioFalso(T0);
      const cliente = new ClienteFalso();
      const servico = new ServicoAnalise({ db: dbFalivel, cliente, relogio, logger });

      const carteira = await criarOuObterCarteira(db, { endereco: enderecoFicticio(0x8001) });
      cliente.definir(carteira.endereco, estadoCarteira({ tamanho: 3 }));
      const ok = await criarAtivo(db, 'FAL1');
      const mau = await criarAtivo(db, 'FAL2');
      for (const a of [ok, mau]) {
        await associarCarteira(db, a.id, carteira.id);
        await alterarEstadoAtivo(db, a.id, 'running');
      }

      // Retoma: o 1.º ativo arranca; depois a abertura de runs falha para o 2.º.
      await servico.iniciar(ok.id).catch(() => undefined); // já running → recusado
      falhar.add('transaction');
      const retomados = await servico.retomarAtivos();
      expect(retomados).toEqual([]);
      expect(erro).toHaveBeenCalledWith(expect.anything(), 'Falha ao retomar a análise');
      falhar.clear();
      await alterarEstadoAtivo(db, ok.id, 'stopped');
      await servico.iniciar(ok.id);

      // Intervalo: leitura das definições falha → usa o último conhecido.
      falhar.add('insert');
      relogio.avancar(MINUTO);
      await aguardar(() => relogio.pendentes(MINUTO) === 1, 'agendamento com intervalo de recurso');
      expect(aviso).toHaveBeenCalledWith(
        expect.anything(),
        'Falha ao ler o intervalo; a usar o último conhecido',
      );
      falhar.clear();

      // Retenção: a falha é registada e volta a agendar-se.
      falhar.add('delete');
      await aguardar(() => relogio.pendentes(DIA) === 1, 'retenção inicial concluída');
      relogio.avancar(DIA);
      await aguardar(() => relogio.pendentes(DIA) === 1, 'retenção reagendada após falha');
      expect(erro).toHaveBeenCalledWith(expect.anything(), 'Falha na retenção');
      falhar.clear();

      // Encerramento: falha ao fechar o run é registada, sem rejeitar.
      await aguardar(() => servico.obterSaude(ok.id)?.cicloEmCurso === false, 'ciclo parado');
      falhar.add('update');
      await expect(servico.encerrar()).resolves.toBeUndefined();
      expect(erro).toHaveBeenCalledWith(expect.anything(), 'Falha ao fechar o run no encerramento');
      falhar.clear();
    });
  },
);
