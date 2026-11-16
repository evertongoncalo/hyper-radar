import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events, snapshots } from '../db/schema';
import { criarEstadoInicial, processarSnapshot, type SnapshotCarteira } from '../motor';
import {
  associarCarteira,
  criarAtivo,
  criarOuObterCarteira,
  gravarEventos,
  obterRunAtivo,
  snapshotMaisProximo,
} from '../repositorios';
import { criarAmbiente, disponivel, enderecoFicticio } from '../repositorios/__testes__/ambiente';
import {
  ClienteFalso,
  estadoCarteira,
  gravador,
  MINUTO,
  RelogioFalso,
  T0,
  type OpcoesEstado,
} from './__testes__/auxiliares';
import { BarramentoAnalise } from './barramento';
import { deSnapshotGravado } from './conversao';
import { ServicoAnalise } from './servico';

const TICKER = 'xyz:NVDA';

// Muitas idas à BD por ciclo: margem folgada para correr em paralelo com cobertura.
describe.skipIf(!disponivel)(
  'análise ponta a ponta (Postgres real, cliente falso)',
  { timeout: 30_000 },
  () => {
    const ambiente = criarAmbiente();
    const { db } = ambiente;
    const relogio = new RelogioFalso(T0);
    const cliente = new ClienteFalso();
    const barramento = new BarramentoAnalise();
    const recebido = gravador(barramento);
    const servico = new ServicoAnalise({ db, cliente, relogio, barramento });

    beforeAll(() => ambiente.preparar());
    afterAll(async () => {
      await servico.encerrar();
      await ambiente.limpar();
    });

    const nvda = (o: OpcoesEstado = {}) => estadoCarteira({ coin: TICKER, preco: 100, ...o });

    async function ciclo(assetId: number) {
      relogio.avancar(MINUTO);
      const limite = Date.now() + 5_000;
      while (servico.obterSaude(assetId)?.cicloEmCurso) {
        if (Date.now() > limite) throw new Error('ciclo não terminou');
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    it('baleia abre, aumenta aos poucos, move o SL e fecha; reinício e dedupe', async () => {
      const ativo = await criarAtivo(db, TICKER);
      expect(ativo.dex).toBe('xyz');
      const baleia = await criarOuObterCarteira(db, {
        endereco: enderecoFicticio(0xa1),
        alias: 'Baleia A',
      });
      const quieta = await criarOuObterCarteira(db, { endereco: enderecoFicticio(0xa2) });
      await associarCarteira(db, ativo.id, baleia.id);
      await associarCarteira(db, ativo.id, quieta.id);

      // Sequência programada da baleia, um item por ciclo (o 0 é a linha de base).
      const sequencia: OpcoesEstado[] = [
        {},
        { tamanho: 100, sl: 90 }, // 1: OPENED
        { tamanho: 102, sl: 90 }, // 2–4: aumentos de 2 % (abaixo do limiar individual)
        { tamanho: 104, sl: 90 },
        { tamanho: 106, sl: 90 },
        { tamanho: 106, sl: 90 }, // 5: estabiliza → um único INCREASED (6 %)
        { tamanho: 106, sl: 92 }, // 6: SL movido (debounce)
        { tamanho: 106, sl: 92 }, // 7: estável → SLTP_CHANGED
        {}, // 8: CLOSED
      ];
      cliente.definir(baleia.endereco, ...sequencia.map((o) => nvda(o)));
      cliente.definir(quieta.endereco, nvda());

      await servico.iniciar(ativo.id);
      const run1 = (await obterRunAtivo(db, ativo.id))!;
      for (let i = 1; i < sequencia.length; i++) await ciclo(ativo.id);

      // Snapshots: 9 ciclos × 2 carteiras, todos no run 1.
      const snaps = await db.select().from(snapshots).where(eq(snapshots.assetId, ativo.id));
      expect(snaps).toHaveLength(18);
      expect(new Set(snaps.map((s) => s.runId))).toEqual(new Set([run1.id]));

      // Eventos na BD.
      const naBd = await db
        .select()
        .from(events)
        .where(eq(events.assetId, ativo.id))
        .orderBy(asc(events.id));
      expect(naBd.map((e) => e.type)).toEqual(['OPENED', 'INCREASED', 'SLTP_CHANGED', 'CLOSED']);
      expect(naBd.every((e) => e.walletId === baleia.id && e.runId === run1.id)).toBe(true);
      expect(naBd.map((e) => e.createdAt.getTime())).toEqual(
        [1, 5, 7, 8].map((i) => T0 + i * MINUTO),
      );
      expect(naBd[1]!.payload).toMatchObject({
        tamanhoAnterior: 100,
        tamanhoNovo: 106,
        ciclosConsolidados: 3,
      });
      expect(naBd[2]!.payload).toMatchObject({
        movidas: [{ tipo: 'SL', antes: { triggerPx: 90 }, depois: { triggerPx: 92 } }],
      });

      // Eventos publicados = os inseridos, com contexto para o feed/notificações.
      expect(recebido.evento.map((e) => e.id)).toEqual(naBd.map((e) => e.id));
      expect(recebido.evento[0]).toMatchObject({
        tipo: 'OPENED',
        ticker: TICKER,
        endereco: baleia.endereco,
        alias: 'Baleia A',
        assetId: ativo.id,
      });
      expect(recebido.ciclo.map((c) => c.eventos)).toEqual([0, 1, 0, 0, 0, 1, 0, 1, 1]);

      // Agregados do run atual: ninguém com posição.
      const agregados = await servico.obterAgregados(ativo.id);
      expect(agregados.atual).toMatchObject({ ativo: TICKER, totalCarteiras: 2, netUsd: 0 });

      // Dedupe: reprocessar os snapshots gravados do run 1 dá as mesmas chaves e nada de novo.
      const reprocessados = [];
      for (const carteira of [baleia, quieta]) {
        let estado = criarEstadoInicial();
        let anterior: SnapshotCarteira | null = null;
        for (let i = 0; i < sequencia.length; i++) {
          const g = await snapshotMaisProximo(db, ativo.id, carteira.id, new Date(T0 + i * MINUTO));
          const atual = deSnapshotGravado(g!, carteira.endereco, TICKER);
          const r = processarSnapshot(estado, anterior, atual);
          estado = r.estado;
          anterior = atual;
          reprocessados.push(
            ...r.eventos.map((e) => ({
              tipo: e.tipo,
              walletId: carteira.id,
              assetId: ativo.id,
              runId: run1.id,
              dedupeKey: e.chaveDedupe,
            })),
          );
        }
      }
      expect(reprocessados.map((e) => e.dedupeKey)).toEqual(naBd.map((e) => e.dedupeKey));
      expect(await gravarEventos(db, reprocessados)).toEqual([]);

      // Carteira adicionada a meio, já com posição: reinício com novo run e linha de base.
      const nova = await criarOuObterCarteira(db, { endereco: enderecoFicticio(0xa3) });
      await associarCarteira(db, ativo.id, nova.id);
      cliente.definir(nova.endereco, nvda({ tamanho: 500, lado: 'short' }));
      // A baleia reabre logo no ciclo a seguir à nova linha de base.
      cliente.definir(baleia.endereco, nvda(), nvda({ tamanho: 100 }));
      const antes = recebido.evento.length;

      await servico.reiniciar(ativo.id, 'carteira adicionada');
      const run2 = (await obterRunAtivo(db, ativo.id))!;
      expect(run2.id).not.toBe(run1.id);
      expect(run2.motivoReinicio).toBe('carteira adicionada');
      expect(recebido.evento.length).toBe(antes); // linha de base: sem falsos OPENED

      await ciclo(ativo.id);
      const novos = recebido.evento.slice(antes);
      expect(novos.map((e) => [e.tipo, e.walletId, e.runId])).toEqual([
        ['OPENED', baleia.id, run2.id],
      ]);
      const doRun2 = await db.select().from(snapshots).where(eq(snapshots.runId, run2.id));
      expect(doRun2).toHaveLength(6);

      const agora = await servico.obterAgregados(ativo.id);
      expect(agora.atual).toMatchObject({ totalCarteiras: 3, netUsd: 10_000 - 50_000 });
      expect(agora.variacao1h).toBeNull();
    });
  },
);
