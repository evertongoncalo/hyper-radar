import type { EstadoCarteiraNoAtivo } from '@hyper-radar/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { analysisRuns, events } from '../db/schema';
import {
  abrirRun,
  alterarEstadoAtivo,
  associarCarteira,
  criarAtivo,
  criarOuObterCarteira,
  ErroNaoEncontrado,
  obterAtivoPorId,
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
import { ServicoAnalise, type FonteEstadoCarteira } from './servico';

/*
 * Concorrência do serviço: transições em rajada e intercaladas com ciclos em curso. Invariantes:
 * nunca dois ciclos do mesmo ativo em simultâneo, nunca dois runs abertos, estado final igual ao
 * da última chamada e nenhum temporizador órfão depois de `encerrar()`.
 */

async function aguardar(condicao: () => boolean | Promise<boolean>, rotulo = 'condição') {
  const limite = Date.now() + 5_000;
  while (!(await condicao())) {
    if (Date.now() > limite) throw new Error(`Tempo esgotado à espera de: ${rotulo}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Mede quantas leituras (≈ ciclos, com 1 carteira) estão em curso em simultâneo. */
class ClienteMedido implements FonteEstadoCarteira {
  emCurso = 0;
  maximo = 0;
  constructor(readonly base: ClienteFalso) {}

  async obterEstadoCarteiraNoAtivo(user: string, ticker: string): Promise<EstadoCarteiraNoAtivo> {
    this.emCurso += 1;
    this.maximo = Math.max(this.maximo, this.emCurso);
    try {
      await new Promise((r) => setTimeout(r, 1));
      return await this.base.obterEstadoCarteiraNoAtivo(user, ticker);
    } finally {
      this.emCurso -= 1;
    }
  }
}

let n = 0;

describe.skipIf(!disponivel)('ServicoAnalise: concorrência', { timeout: 30_000 }, () => {
  const ambiente = criarAmbiente();
  const { db } = ambiente;
  const servicos: ServicoAnalise[] = [];

  beforeAll(() => ambiente.preparar());
  afterEach(async () => {
    await Promise.all(servicos.splice(0).map((s) => s.encerrar()));
  });
  afterAll(() => ambiente.limpar());

  async function montar() {
    n += 1;
    const relogio = new RelogioFalso(T0);
    const base = new ClienteFalso();
    const cliente = new ClienteMedido(base);
    const barramento = new BarramentoAnalise();
    const recebido = gravador(barramento);
    const servico = new ServicoAnalise({
      db,
      cliente,
      relogio,
      barramento,
      logger: pino({ enabled: false }),
    });
    servicos.push(servico);
    const ativo = await criarAtivo(db, `CC${n}`);
    const carteira = await criarOuObterCarteira(db, { endereco: enderecoFicticio(0xc000 + n) });
    await associarCarteira(db, ativo.id, carteira.id);
    base.definir(carteira.endereco, estadoCarteira({ tamanho: 10 }));

    const runsAbertos = async () => {
      const [l] = await db
        .select({ n: count() })
        .from(analysisRuns)
        .where(and(eq(analysisRuns.assetId, ativo.id), isNull(analysisRuns.endedAt)));
      return l!.n;
    };
    const estadoBd = async () => (await obterAtivoPorId(db, ativo.id))!.estado;
    const semCiclo = () =>
      aguardar(() => servico.obterSaude(ativo.id)?.cicloEmCurso !== true, 'fim do ciclo');
    /** Avança um intervalo e espera que o ciclo deste ativo termine e o seguinte seja agendado. */
    const ciclo = async () => {
      const antes = recebido.ciclo.filter((c) => c.assetId === ativo.id).length;
      relogio.avancar(MINUTO);
      await aguardar(
        () => recebido.ciclo.filter((c) => c.assetId === ativo.id).length > antes,
        'ciclo publicado',
      );
      await semCiclo();
    };

    /** Invariantes finais, para o estado esperado. */
    async function verificar(esperado: 'running' | 'stopped') {
      await semCiclo();
      expect(cliente.maximo).toBeLessThanOrEqual(1);
      expect(await estadoBd()).toBe(esperado);
      expect(await runsAbertos()).toBe(esperado === 'running' ? 1 : 0);
      expect(servico.ativosEmAnalise()).toEqual(esperado === 'running' ? [ativo.id] : []);
      // Um único temporizador de ciclo armado (ou nenhum), além do da retenção (não armado aqui).
      expect(relogio.pendentes()).toBe(esperado === 'running' ? 1 : 0);
    }

    return {
      relogio,
      base,
      cliente,
      servico,
      ativo,
      carteira,
      recebido,
      runsAbertos,
      estadoBd,
      semCiclo,
      ciclo,
      verificar,
    };
  }

  it('rajada iniciar/parar/reiniciar sem await: serializada e coerente com a última chamada', async () => {
    const { servico, ativo, verificar } = await montar();
    const id = ativo.id;
    const resultados = await Promise.allSettled([
      servico.iniciar(id),
      servico.parar(id),
      servico.iniciar(id),
      servico.reiniciar(id, 'r1'),
      servico.reiniciar(id, 'r2'),
      servico.parar(id),
      servico.iniciar(id),
    ]);
    expect(resultados.map((r) => r.status)).toEqual(Array(7).fill('fulfilled'));
    await verificar('running');
  });

  it('transições intercaladas com um ciclo pendurado: nunca dois ciclos nem dois runs', async () => {
    const { servico, ativo, base, carteira, relogio, verificar, runsAbertos } = await montar();
    const lenta = adiada<EstadoCarteiraNoAtivo>();
    base.definir(
      carteira.endereco,
      estadoCarteira({ tamanho: 10 }),
      lenta.promessa,
      estadoCarteira({ tamanho: 10 }),
    );
    await servico.iniciar(ativo.id);
    relogio.avancar(MINUTO); // 2.º ciclo fica pendurado na leitura
    await aguardar(() => servico.obterSaude(ativo.id)?.cicloEmCurso === true, 'ciclo em curso');

    const ops = [
      servico.reiniciar(ativo.id, 'carteira adicionada'),
      servico.parar(ativo.id),
      servico.iniciar(ativo.id),
      servico.reiniciar(ativo.id, 'outra vez'),
    ];
    // Enquanto o ciclo está pendurado, nada avança nem abre runs novos.
    relogio.avancar(10 * MINUTO);
    await new Promise((r) => setTimeout(r, 30));
    expect(await runsAbertos()).toBe(1);
    expect(relogio.pendentes()).toBe(0);

    lenta.resolver(estadoCarteira({ tamanho: 10 }));
    const resultados = await Promise.allSettled(ops);
    expect(resultados.map((r) => r.status)).toEqual(Array(4).fill('fulfilled'));
    await verificar('running');
  });

  it('sequência pseudo-aleatória de transições e ciclos respeita o modelo sequencial', async () => {
    let semente = 0x2545f491;
    const aleatorio = () => {
      semente = (Math.imul(semente, 1_103_515_245) + 12_345) >>> 0;
      return semente / 4_294_967_296;
    };
    const { servico, ativo, relogio, verificar } = await montar();
    let modelo: 'idle' | 'running' | 'stopped' = 'idle';
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      const x = aleatorio();
      if (x < 0.3) {
        ops.push(servico.iniciar(ativo.id).catch(() => undefined));
        modelo = 'running';
      } else if (x < 0.55) {
        ops.push(servico.parar(ativo.id).catch(() => undefined));
        if (modelo === 'running') modelo = 'stopped';
      } else if (x < 0.8) {
        ops.push(servico.reiniciar(ativo.id, `r${i}`));
      } else {
        relogio.avancar(MINUTO);
      }
      if (aleatorio() < 0.3) await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.all(ops);
    expect(modelo).not.toBe('idle');
    await verificar(modelo === 'running' ? 'running' : 'stopped');
  });

  it('encerrar durante um reinício não deixa run aberto nem temporizador órfão', async () => {
    const { servico, ativo, relogio, recebido, runsAbertos } = await montar();
    await servico.iniciar(ativo.id);
    let encerramento: Promise<void> | null = null;
    servico.barramento.on('estado-ativo', (e) => {
      if (e.estado === 'restarting' && !encerramento) encerramento = servico.encerrar();
    });
    await servico.reiniciar(ativo.id, 'carteira adicionada').catch(() => undefined);
    await encerramento;
    await new Promise((r) => setTimeout(r, 30));

    expect(recebido['estado-ativo'].some((e) => e.estado === 'restarting')).toBe(true);
    expect(servico.ativosEmAnalise()).toEqual([]);
    expect(relogio.pendentes()).toBe(0);
    expect(await runsAbertos()).toBe(0);
    // O ativo fica marcado para retomar no próximo arranque.
    expect((await obterAtivoPorId(db, ativo.id))!.estado).not.toBe('stopped');
  });

  it('encerrar com ciclo pendurado e transições em fila: tudo termina, sem temporizadores', async () => {
    const { servico, ativo, base, carteira, relogio, runsAbertos } = await montar();
    const lenta = adiada<EstadoCarteiraNoAtivo>();
    base.definir(carteira.endereco, estadoCarteira({ tamanho: 10 }), lenta.promessa);
    await servico.iniciar(ativo.id);
    relogio.avancar(MINUTO);
    await aguardar(() => servico.obterSaude(ativo.id)?.cicloEmCurso === true, 'ciclo em curso');
    const parar = servico.parar(ativo.id).catch(() => undefined);
    const fim = servico.encerrar();
    lenta.resolver(estadoCarteira({ tamanho: 10 }));
    await Promise.all([fim, parar]);
    relogio.avancar(60 * MINUTO);
    await new Promise((r) => setTimeout(r, 30));
    expect(relogio.pendentes()).toBe(0);
    expect(await runsAbertos()).toBe(0);
    expect(servico.ativosEmAnalise()).toEqual([]);
  });

  describe('removerAtivo', () => {
    /** Ativo apagado sem rasto: sem runs, sem ciclos, sem temporizadores, nada a correr depois. */
    async function verificarRemovido(m: Awaited<ReturnType<typeof montar>>) {
      const { servico, ativo, relogio, cliente, base } = m;
      expect(await obterAtivoPorId(db, ativo.id)).toBeNull();
      const [runs] = await db
        .select({ n: count() })
        .from(analysisRuns)
        .where(eq(analysisRuns.assetId, ativo.id));
      expect(runs!.n).toBe(0);
      expect(servico.ativosEmAnalise()).not.toContain(ativo.id);
      expect(servico.obterSaude(ativo.id)).toBeNull();
      expect(relogio.pendentes()).toBe(0);
      const chamadas = base.chamadas.length;
      relogio.avancar(60 * MINUTO);
      await new Promise((r) => setTimeout(r, 30));
      expect(base.chamadas.length).toBe(chamadas);
      expect(cliente.maximo).toBeLessThanOrEqual(1);
    }

    it('rajada iniciar/removerAtivo/iniciar sem await: apaga e o iniciar posterior falha (404)', async () => {
      const m = await montar();
      const { servico, ativo, recebido } = m;
      const id = ativo.id;
      const resultados = await Promise.allSettled([
        servico.iniciar(id),
        servico.removerAtivo(id),
        servico.iniciar(id),
        servico.reiniciar(id, 'carteira adicionada'),
        servico.parar(id),
        servico.removerAtivo(id),
      ]);
      expect(resultados.map((r) => r.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'rejected',
        'fulfilled',
        'rejected',
        'rejected',
      ]);
      for (const i of [2, 4, 5]) {
        expect((resultados[i] as PromiseRejectedResult).reason).toBeInstanceOf(ErroNaoEncontrado);
      }
      expect((resultados[3] as PromiseFulfilledResult<unknown>).value).toBeNull();
      // O último estado publicado para o ativo é `stopped` (a UI deixa de o mostrar em análise).
      expect(recebido['estado-ativo'].filter((e) => e.assetId === id).at(-1)).toMatchObject({
        estado: 'stopped',
        runId: null,
      });
      await verificarRemovido(m);
    });

    it('com um ciclo pendurado: espera-o, só então apaga; iniciar em fila → 404', async () => {
      const m = await montar();
      const { servico, ativo, base, carteira, relogio } = m;
      const lenta = adiada<EstadoCarteiraNoAtivo>();
      base.definir(carteira.endereco, estadoCarteira({ tamanho: 10 }), lenta.promessa);
      await servico.iniciar(ativo.id);
      relogio.avancar(MINUTO);
      await aguardar(() => servico.obterSaude(ativo.id)?.cicloEmCurso === true, 'ciclo em curso');

      const remover = servico.removerAtivo(ativo.id);
      const iniciar = servico.iniciar(ativo.id);
      await new Promise((r) => setTimeout(r, 30));
      // Enquanto o ciclo não termina, o ativo continua a existir.
      expect(await obterAtivoPorId(db, ativo.id)).not.toBeNull();

      lenta.resolver(estadoCarteira({ tamanho: 10 }));
      await remover;
      await expect(iniciar).rejects.toBeInstanceOf(ErroNaoEncontrado);
      await verificarRemovido(m);
    });

    it('ativo parado apaga-se sem publicar estado; inexistente → ErroNaoEncontrado', async () => {
      const m = await montar();
      const { servico, ativo, recebido } = m;
      await servico.removerAtivo(ativo.id);
      expect(recebido['estado-ativo']).toEqual([]);
      await expect(servico.removerAtivo(ativo.id)).rejects.toBeInstanceOf(ErroNaoEncontrado);
      await verificarRemovido(m);
    });
  });

  it('carteira com 3 leituras falhadas que volta maior: sem CLOSED, INCREASED face ao último válido', async () => {
    const { servico, ativo, base, carteira, recebido, ciclo } = await montar();
    base.definir(
      carteira.endereco,
      estadoCarteira({ tamanho: 100 }),
      new Error('rede 1'),
      new Error('rede 2'),
      new Error('rede 3'),
      estadoCarteira({ tamanho: 150 }),
    );
    await servico.iniciar(ativo.id);
    for (let i = 0; i < 6; i++) await ciclo();
    expect(recebido.ciclo.slice(1, 4).every((c) => c.falhou)).toBe(true);
    expect(recebido.evento.map((e) => e.tipo)).toEqual(['INCREASED']);
    expect(recebido.evento[0]!.payload).toMatchObject({ tamanhoAnterior: 100, tamanhoNovo: 150 });
    expect(servico.obterSaude(ativo.id)!.carteirasDesatualizadas).toEqual([]);
  });

  it('arranque com ativo running e posição alterada entretanto: nova linha de base, sem eventos', async () => {
    // Os ativos deixados `running` por outros testes deste schema também são retomados aqui.
    const { servico, ativo, base, carteira, recebido, ciclo } = await montar();
    await abrirRun(db, ativo.id);
    await alterarEstadoAtivo(db, ativo.id, 'running');
    base.definir(carteira.endereco, estadoCarteira({ tamanho: 150, lado: 'short' }));
    await servico.retomarAtivos();
    expect(servico.ativosEmAnalise()).toContain(ativo.id);
    for (let i = 0; i < 3; i++) await ciclo();
    expect(recebido.evento.filter((e) => e.assetId === ativo.id)).toEqual([]);
    const [l] = await db.select({ n: count() }).from(events).where(eq(events.assetId, ativo.id));
    expect(l!.n).toBe(0);
  });
});
