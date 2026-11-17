import {
  contagemNaoLidosSchema,
  definicoesDtoSchema,
  exportacaoSchema,
  importacaoRespostaSchema,
  listaAtivosSchema,
  paginaEventosSchema,
  respostaErroSchema,
  type Exportacao,
} from '@hyper-radar/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estadoCarteira, T0 } from '../analise/__testes__/auxiliares';
import {
  associarCarteira,
  criarAtivo,
  criarOuObterCarteira,
  gravarEventos,
  obterRunAtivo,
  type TipoEvento,
} from '../repositorios';
import { criarAmbiente, disponivel, enderecoFicticio } from '../repositorios/__testes__/ambiente';
import { criarApp } from './__testes__/auxiliares';

const MIN = 60_000;

describe.skipIf(!disponivel)(
  'rotas de eventos, definições e exportação/importação (Postgres real)',
  { timeout: 30_000 },
  () => {
    const ambiente = criarAmbiente();
    const destino = criarAmbiente();
    const { db } = ambiente;
    const { app, analise, cliente } = criarApp(db);
    const outra = criarApp(destino.db);

    beforeAll(async () => {
      await Promise.all([ambiente.preparar(), destino.preparar()]);
    });
    afterAll(async () => {
      await Promise.all([app.close(), outra.app.close()]);
      await Promise.all([analise.encerrar(), outra.analise.encerrar()]);
      await Promise.all([ambiente.limpar(), destino.limpar()]);
    });

    type Metodo = 'GET' | 'POST' | 'PATCH';
    const pedir = (method: Metodo, url: string, payload?: object, alvo = app) =>
      alvo.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    const erro = (r: { json: () => unknown }) => respostaErroSchema.parse(r.json()).erro;

    describe('eventos', () => {
      let btc: number;
      let eth: number;
      let w1: number;
      let w2: number;
      const ids: number[] = [];

      beforeAll(async () => {
        btc = (await criarAtivo(db, 'BTC')).id;
        eth = (await criarAtivo(db, 'ETH')).id;
        w1 = (await criarOuObterCarteira(db, { endereco: enderecoFicticio(1), alias: 'Um' })).id;
        w2 = (await criarOuObterCarteira(db, { endereco: enderecoFicticio(2) })).id;
        const lista: [TipoEvento, number, number][] = [
          ['OPENED', btc, w1],
          ['INCREASED', btc, w1],
          ['OPENED', btc, w2],
          ['CLOSED', eth, w1],
          ['FLIPPED', eth, w2],
        ];
        const gravados = await gravarEventos(
          db,
          lista.map(([tipo, assetId, walletId], i) => ({
            tipo,
            assetId,
            walletId,
            payload: { i },
            dedupeKey: `teste|${i}`,
            criadoEm: new Date(T0 + i * MIN),
          })),
        );
        ids.push(...gravados.map((e) => e.id));
      });

      const listar = async (query = '') => {
        const r = await pedir('GET', `/api/eventos${query}`);
        expect(r.statusCode).toBe(200);
        return paginaEventosSchema.parse(r.json());
      };

      it('lista do mais recente para o mais antigo, com contexto', async () => {
        const p = await listar();
        expect(p.itens.map((e) => e.id)).toEqual([...ids].reverse());
        expect(p.proximoCursor).toBeNull();
        expect(p.itens.at(-1)).toMatchObject({
          tipo: 'OPENED',
          ticker: 'BTC',
          endereco: enderecoFicticio(1),
          alias: 'Um',
          payload: { i: 0 },
          lido: false,
          criadoEm: new Date(T0).toISOString(),
        });
      });

      it.each([
        [`?ativo=__btc__`, ['OPENED', 'INCREASED', 'OPENED'].reverse()],
        [`?carteira=__w2__`, ['FLIPPED', 'OPENED']],
        ['?tipos=OPENED,CLOSED', ['CLOSED', 'OPENED', 'OPENED']],
        ['?tipos=FLIPPED&tipos=INCREASED', ['FLIPPED', 'INCREASED']],
        [
          `?desde=${new Date(T0 + MIN).toISOString()}&ate=${new Date(T0 + 3 * MIN).toISOString()}`,
          ['CLOSED', 'OPENED', 'INCREASED'],
        ],
      ])('filtro %s', async (query, tipos) => {
        const q = query.replace('__btc__', String(btc)).replace('__w2__', String(w2));
        expect((await listar(q)).itens.map((e) => e.tipo)).toEqual(tipos);
      });

      it('paginação por cursor', async () => {
        const p1 = await listar('?limite=2');
        expect(p1.itens).toHaveLength(2);
        expect(p1.proximoCursor).toBe(p1.itens[1]!.id);
        const p2 = await listar(`?limite=2&cursor=${p1.proximoCursor}`);
        const p3 = await listar(`?limite=2&cursor=${p2.proximoCursor}`);
        expect([...p1.itens, ...p2.itens, ...p3.itens].map((e) => e.id)).toEqual(
          [...ids].reverse(),
        );
        expect(p3.proximoCursor).toBeNull();
      });

      it.each([
        '?tipos=FOO',
        '?limite=0',
        '?limite=201',
        '?naoLidos=sim',
        '?ativo=abc',
        '?desde=ontem',
        `?desde=${new Date(T0 + MIN).toISOString()}&ate=${new Date(T0).toISOString()}`,
      ])('query inválida %s → 400', async (query) => {
        const r = await pedir('GET', `/api/eventos${query}`);
        expect(r.statusCode).toBe(400);
        expect(erro(r).codigo).toBe('VALIDACAO');
      });

      it('marcar um evento como lido; inexistente → 404; id inválido → 400', async () => {
        const r = await pedir('POST', `/api/eventos/${ids[0]}/lido`);
        expect([r.statusCode, r.json()]).toEqual([200, { id: ids[0], lido: true }]);
        expect((await pedir('POST', '/api/eventos/999999999/lido')).statusCode).toBe(404);
        expect((await pedir('POST', '/api/eventos/abc/lido')).statusCode).toBe(400);
        expect((await listar('?naoLidos=true')).itens.map((e) => e.id)).not.toContain(ids[0]);
        expect((await listar('?naoLidos=false')).itens).toHaveLength(5);
      });

      it('contagem de não lidos (total e por ativo) e na lista de ativos', async () => {
        const r = await pedir('GET', '/api/eventos/nao-lidos/contagem');
        expect(contagemNaoLidosSchema.parse(r.json())).toEqual({
          total: 4,
          porAtivo: [
            { assetId: btc, naoLidos: 2 },
            { assetId: eth, naoLidos: 2 },
          ],
        });
        const ativos = listaAtivosSchema.parse((await pedir('GET', '/api/ativos')).json());
        expect(ativos.map((a) => a.eventosNaoLidos)).toEqual([2, 2]);
      });

      it('marcar todos os eventos de um ativo como lidos', async () => {
        const r = await pedir('POST', `/api/ativos/${btc}/eventos/lidos`);
        expect(r.json()).toEqual({ marcados: 2 });
        expect((await pedir('POST', `/api/ativos/${btc}/eventos/lidos`)).json()).toEqual({
          marcados: 0,
        });
        expect((await pedir('POST', '/api/ativos/999999/eventos/lidos')).statusCode).toBe(404);
        const c = contagemNaoLidosSchema.parse(
          (await pedir('GET', '/api/eventos/nao-lidos/contagem')).json(),
        );
        expect(c).toEqual({ total: 2, porAtivo: [{ assetId: eth, naoLidos: 2 }] });
      });
    });

    describe('definições', () => {
      it('GET devolve as omissões', async () => {
        const r = await pedir('GET', '/api/definicoes');
        expect(definicoesDtoSchema.parse(r.json())).toMatchObject({
          capitalUsd: 0,
          alavancagemMaxima: 5,
          riscoPorOperacaoPct: 1,
          intervaloRecolhaSegundos: 60,
        });
      });

      it('PATCH parcial', async () => {
        const r = await pedir('PATCH', '/api/definicoes', {
          capitalUsd: 1500.5,
          intervaloRecolhaSegundos: 15,
          limiteDiarioChamadasIa: 3,
        });
        expect(r.statusCode).toBe(200);
        expect(definicoesDtoSchema.parse(r.json())).toMatchObject({
          capitalUsd: 1500.5,
          alavancagemMaxima: 5,
          intervaloRecolhaSegundos: 15,
          limiteDiarioChamadasIa: 3,
        });
        expect((await pedir('PATCH', '/api/definicoes', {})).json()).toMatchObject({
          capitalUsd: 1500.5,
        });
      });

      it.each([
        { intervaloRecolhaSegundos: 14 },
        { intervaloRecolhaSegundos: 20.5 },
        { alavancagemMaxima: 101 },
        { riscoPorOperacaoPct: 0 },
        { capitalUsd: -1 },
        { capitalUsd: '10' },
        { limiteDiarioTokensIa: -1 },
        { modelo: 'x' },
      ])('PATCH inválido %j → 400', async (corpo) => {
        const r = await pedir('PATCH', '/api/definicoes', corpo);
        expect(r.statusCode).toBe(400);
        expect(erro(r).codigo).toBe('VALIDACAO');
      });
    });

    describe('exportação e importação', () => {
      let exportado: Exportacao;

      beforeAll(async () => {
        const btc = (await pedir('GET', '/api/ativos')).json()[0].id as number;
        await associarCarteira(
          db,
          btc,
          (await criarOuObterCarteira(db, { endereco: enderecoFicticio(1) })).id,
        );
        await criarOuObterCarteira(db, { endereco: enderecoFicticio(3), entidade: 'Fundo' });
      });

      it('exporta ativos, carteiras, associações e definições (sem snapshots/eventos)', async () => {
        const r = await pedir('GET', '/api/exportacao');
        expect(r.statusCode).toBe(200);
        expect(r.headers['content-disposition']).toBe(
          'attachment; filename="hyperradar-2026-01-10.json"',
        );
        exportado = exportacaoSchema.parse(r.json());
        expect(Object.keys(r.json()).sort()).toEqual(
          ['ativos', 'carteiras', 'definicoes', 'exportadoEm', 'versao'].sort(),
        );
        expect(exportado.ativos).toEqual([
          { ticker: 'BTC', carteiras: [enderecoFicticio(1)] },
          { ticker: 'ETH', carteiras: [] },
        ]);
        expect(exportado.carteiras).toEqual([
          { endereco: enderecoFicticio(1), alias: 'Um', entidade: null },
          { endereco: enderecoFicticio(2), alias: null, entidade: null },
          { endereco: enderecoFicticio(3), alias: null, entidade: 'Fundo' },
        ]);
        expect(exportado.definicoes).toMatchObject({ capitalUsd: 1500.5 });
      });

      it('importar a própria exportação é idempotente (nada criado nem alterado)', async () => {
        const r = await pedir('POST', '/api/importacao', exportado);
        expect(r.statusCode).toBe(200);
        expect(importacaoRespostaSchema.parse(r.json())).toEqual({
          ativosCriados: 0,
          carteirasCriadas: 0,
          carteirasAtualizadas: 0,
          associacoesCriadas: 0,
          definicoesAtualizadas: false,
          analisesReiniciadas: [],
        });
      });

      it('exportar → importar noutra base reproduz os dados; repetir não duplica', async () => {
        const r1 = await pedir('POST', '/api/importacao', exportado, outra.app);
        expect(r1.json()).toEqual({
          ativosCriados: 2,
          carteirasCriadas: 3,
          carteirasAtualizadas: 0,
          associacoesCriadas: 1,
          definicoesAtualizadas: true,
          analisesReiniciadas: [],
        });
        const r2 = await pedir('POST', '/api/importacao', exportado, outra.app);
        expect(r2.json()).toMatchObject({
          ativosCriados: 0,
          carteirasCriadas: 0,
          associacoesCriadas: 0,
          definicoesAtualizadas: false,
        });
        const reexportado = exportacaoSchema.parse(
          (await pedir('GET', '/api/exportacao', undefined, outra.app)).json(),
        );
        expect({ ...reexportado, exportadoEm: '' }).toEqual({ ...exportado, exportadoEm: '' });
      });

      it('é aditiva: não apaga nem limpa; acrescenta e reinicia análises ativas', async () => {
        const btc = listaAtivosSchema.parse((await pedir('GET', '/api/ativos')).json())[0]!.id;
        cliente.definir(enderecoFicticio(1), estadoCarteira());
        cliente.definir(enderecoFicticio(9), estadoCarteira({ tamanho: 3 }));
        await pedir('POST', `/api/ativos/${btc}/analise/iniciar`);
        const runAntes = (await obterRunAtivo(db, btc))!.id;

        const r = await pedir('POST', '/api/importacao', {
          versao: 1,
          exportadoEm: new Date(T0).toISOString(),
          carteiras: [
            { endereco: enderecoFicticio(1), alias: null, entidade: null },
            { endereco: enderecoFicticio(2), alias: 'Dois', entidade: null },
            {
              endereco: enderecoFicticio(9).toUpperCase().replace('0X', '0x'),
              alias: 'Nove',
              entidade: null,
            },
          ],
          ativos: [
            { ticker: 'BTC', carteiras: [enderecoFicticio(9)] },
            { ticker: 'SOL', carteiras: [] },
          ],
        });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual({
          ativosCriados: 1,
          carteirasCriadas: 1,
          carteirasAtualizadas: 1,
          associacoesCriadas: 1,
          definicoesAtualizadas: false,
          analisesReiniciadas: [btc],
        });
        expect((await obterRunAtivo(db, btc))!.id).not.toBe(runAntes);
        const depois = exportacaoSchema.parse((await pedir('GET', '/api/exportacao')).json());
        // O alias "Um" mantém-se (null não limpa); ETH e as carteiras existentes continuam lá.
        expect(depois.carteiras.find((c) => c.endereco === enderecoFicticio(1))?.alias).toBe('Um');
        expect(depois.ativos.map((a) => a.ticker)).toEqual(['BTC', 'ETH', 'SOL']);
        expect(depois.ativos[0]!.carteiras).toEqual([enderecoFicticio(1), enderecoFicticio(9)]);
        await pedir('POST', `/api/ativos/${btc}/analise/parar`);
      });

      it.each([
        ['versão desconhecida', { versao: 2 }],
        ['carteira não listada', { ativos: [{ ticker: 'BTC', carteiras: [enderecoFicticio(7)] }] }],
        [
          'ticker repetido',
          {
            ativos: [
              { ticker: 'BTC', carteiras: [] },
              { ticker: 'BTC', carteiras: [] },
            ],
          },
        ],
        ['endereço inválido', { carteiras: [{ endereco: '0x1', alias: null, entidade: null }] }],
        ['campo desconhecido grande (limite próprio > 1 MB)', { extra: 'x'.repeat(1_500_000) }],
      ])('importação inválida (%s) → 400', async (_nome, alteracao) => {
        const r = await pedir('POST', '/api/importacao', { ...exportado, ...alteracao });
        expect(r.statusCode).toBe(400);
        expect(erro(r).codigo).toBe('VALIDACAO');
      });
    });
  },
);
