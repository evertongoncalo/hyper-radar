import type { AddressInfo } from 'node:net';
import { schemasEventosSse } from '@hyper-radar/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T0 } from '../analise/__testes__/auxiliares';
import {
  criarAtivo,
  criarOuObterCarteira,
  gravarEventos,
  type EventoDetalhado,
} from '../repositorios';
import { criarAmbiente, disponivel, enderecoFicticio } from '../repositorios/__testes__/ambiente';
import { criarApp, esperarAte, ligarSse } from './__testes__/auxiliares';

const HEARTBEAT = 25_000;

/** Extrai os blocos SSE `event:`/`data:`/`id:` do texto recebido. */
function blocos(texto: string) {
  return texto
    .split('\n\n')
    .filter((b) => b.includes('event: '))
    .map((b) => {
      const linhas = Object.fromEntries(
        b.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
      );
      return { id: linhas.id, nome: linhas.event!, dados: JSON.parse(linhas.data!) as unknown };
    });
}

describe.skipIf(!disponivel)(
  'SSE /api/stream (servidor real em 127.0.0.1)',
  { timeout: 30_000 },
  () => {
    const ambiente = criarAmbiente();
    const { app, analise, relogio } = criarApp(ambiente.db, { heartbeatSseMs: HEARTBEAT });
    const barramento = analise.barramento;
    let porta = 0;
    let fechada = false;
    const ids: number[] = [];
    let base: Omit<EventoDetalhado, 'id'>;

    beforeAll(async () => {
      await ambiente.preparar();
      const ativo = await criarAtivo(ambiente.db, 'BTC');
      const carteira = await criarOuObterCarteira(ambiente.db, {
        endereco: enderecoFicticio(1),
        alias: 'Baleia',
      });
      const gravados = await gravarEventos(
        ambiente.db,
        [0, 1, 2].map((i) => ({
          tipo: 'OPENED' as const,
          assetId: ativo.id,
          walletId: carteira.id,
          payload: { i },
          dedupeKey: `sse|${i}`,
          criadoEm: new Date(T0 + i),
        })),
      );
      ids.push(...gravados.map((e) => e.id));
      base = {
        tipo: 'CLOSED',
        assetId: ativo.id,
        walletId: carteira.id,
        runId: null,
        payload: {},
        dedupeKey: 'x',
        lido: false,
        criadoEm: new Date(T0),
        ticker: 'BTC',
        endereco: carteira.endereco,
        alias: 'Baleia',
      };
      await app.listen({ host: '127.0.0.1', port: 0 });
      porta = (app.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      if (!fechada) await app.close();
      await analise.encerrar();
      await ambiente.limpar();
    });

    it('cabeçalhos, retry e eventos nomeados publicados no barramento', async () => {
      const sse = await ligarSse(porta);
      expect(sse.resposta.statusCode).toBe(200);
      expect(sse.resposta.headers).toMatchObject({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      await sse.esperarPor(/retry: 3000\n\n/);

      barramento.emitir('evento', { ...base, id: 1_000 });
      barramento.emitir('estado-ativo', {
        assetId: base.assetId,
        ticker: 'BTC',
        anterior: 'idle',
        estado: 'running',
        runId: 5,
        instante: new Date(T0),
      });
      barramento.emitir('ciclo', {
        assetId: base.assetId,
        ticker: 'BTC',
        runId: 5,
        instante: new Date(T0),
        duracaoMs: 12,
        carteirasOk: 1,
        carteirasFalhadas: 0,
        eventos: 0,
        falhou: false,
        erro: null,
      });
      await sse.esperarPor(/event: ciclo\n/);

      const recebidos = blocos(sse.texto());
      expect(recebidos.map((b) => [b.nome, b.id])).toEqual([
        ['evento', '1000'],
        ['estado-ativo', undefined],
        ['ciclo', undefined],
      ]);
      for (const b of recebidos) {
        schemasEventosSse[b.nome as keyof typeof schemasEventosSse].parse(b.dados);
      }
      expect(recebidos[0]!.dados).toMatchObject({ id: 1_000, tipo: 'CLOSED', alias: 'Baleia' });
      expect(recebidos[1]!.dados).toMatchObject({
        estado: 'running',
        instante: new Date(T0).toISOString(),
      });
      sse.fechar();
    });

    it('Last-Event-ID: reenvia os eventos persistidos seguintes, por ordem, sem duplicar', async () => {
      const sse = await ligarSse(porta, '/api/stream', { 'last-event-id': String(ids[0]) });
      // Evento ao vivo logo a seguir (possivelmente durante o reenvio): sai depois e só uma vez.
      barramento.emitir('evento', { ...base, id: ids[2]! + 100 });
      barramento.emitir('evento', { ...base, id: ids[2]! });
      await sse.esperarPor(new RegExp(`id: ${ids[2]! + 100}\\n`));
      expect(blocos(sse.texto()).map((b) => Number(b.id))).toEqual([ids[1], ids[2], ids[2]! + 100]);
      sse.fechar();
    });

    it('?desdeId= também reenvia; Last-Event-ID inválido é ignorado', async () => {
      const sse = await ligarSse(porta, `/api/stream?desdeId=${ids[1]}`);
      await sse.esperarPor(new RegExp(`id: ${ids[2]}\\n`));
      expect(blocos(sse.texto()).map((b) => Number(b.id))).toEqual([ids[2]]);
      sse.fechar();

      const sem = await ligarSse(porta, '/api/stream', { 'last-event-id': 'abc' });
      await sem.esperarPor(/retry:/);
      barramento.emitir('evento', { ...base, id: 7 });
      await sem.esperarPor(/id: 7\n/);
      expect(blocos(sem.texto()).map((b) => b.id)).toEqual(['7']);
      sem.fechar();
    });

    it('heartbeat por comentário a cada 25 s (relógio controlado)', async () => {
      const sse = await ligarSse(porta);
      await sse.esperarPor(/retry:/);
      expect(sse.texto()).not.toContain(': ping');
      relogio.avancar(HEARTBEAT - 1);
      relogio.avancar(1);
      await sse.esperarPor(/: ping\n\n/);
      relogio.avancar(HEARTBEAT);
      await sse.esperarPor(/: ping\n\n[^]*: ping\n\n/);
      sse.fechar();
    });

    it('limpa ouvintes e temporizadores quando o cliente desliga', async () => {
      // As ligações dos testes anteriores (já fechadas pelo cliente) também foram limpas.
      await esperarAte(() => barramento.contarOuvintes('evento') === 0);
      const antes = 0;
      const ligacoes = await Promise.all([ligarSse(porta), ligarSse(porta)]);
      await Promise.all(ligacoes.map((l) => l.esperarPor(/retry:/)));
      expect(barramento.contarOuvintes('evento')).toBe(antes + 2);
      expect(relogio.pendentes(HEARTBEAT)).toBe(2);
      for (const l of ligacoes) l.fechar();
      await esperarAte(
        () =>
          barramento.contarOuvintes('evento') === antes &&
          barramento.contarOuvintes('estado-ativo') === 0 &&
          barramento.contarOuvintes('ciclo') === 0,
      );
      expect(relogio.pendentes(HEARTBEAT)).toBe(0);
    });

    it('corta um cliente que não lê (buffer acima de 1 MB) e limpa', async () => {
      const sse = await ligarSse(porta);
      await sse.esperarPor(/retry:/);
      sse.resposta.pause();
      for (let i = 0; i < 20; i++) {
        barramento.emitir('evento', {
          ...base,
          id: 10_000 + i,
          payload: { lixo: 'x'.repeat(500_000) },
        });
      }
      await esperarAte(() => barramento.contarOuvintes('evento') === 0, 5_000);
      sse.fechar();
    });

    it('o encerramento da app fecha as ligações SSE abertas (sem ficar pendurado)', async () => {
      const sse = await ligarSse(porta);
      await sse.esperarPor(/retry:/);
      const inicio = Date.now();
      await app.close();
      fechada = true;
      await sse.terminou;
      expect(Date.now() - inicio).toBeLessThan(2_000);
      expect(barramento.contarOuvintes('evento')).toBe(0);
      expect(relogio.pendentes(HEARTBEAT)).toBe(0);
    });
  },
);
