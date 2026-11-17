import {
  adicionarCarteiraRespostaSchema,
  agregadosAtivoRespostaSchema,
  ativoDetalheSchema,
  ativoResumoSchema,
  carteiraDtoSchema,
  listaAtivosSchema,
  listaCarteirasSchema,
  respostaErroSchema,
} from '@hyper-radar/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estadoCarteira, MINUTO } from '../analise/__testes__/auxiliares';
import { ErroCircuitoAberto, ErroHttp } from '../hyperliquid';
import { listarEventos, obterRunAtivo } from '../repositorios';
import { criarAmbiente, disponivel, enderecoFicticio } from '../repositorios/__testes__/ambiente';
import { criarApp, esperarAte } from './__testes__/auxiliares';

describe.skipIf(!disponivel)(
  'rotas de ativos, carteiras e análise (Postgres real, Hyperliquid falsa)',
  { timeout: 30_000 },
  () => {
    const ambiente = criarAmbiente();
    const { app, analise, cliente, mercado, relogio } = criarApp(ambiente.db);
    const { db } = ambiente;

    beforeAll(() => ambiente.preparar());
    afterAll(async () => {
      await app.close();
      await analise.encerrar();
      await ambiente.limpar();
    });

    type Metodo = 'GET' | 'POST' | 'PATCH' | 'DELETE';
    const pedir = (method: Metodo, url: string, payload?: object) =>
      app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    const erro = (r: { json: () => unknown }) => respostaErroSchema.parse(r.json()).erro;

    async function criarAtivo(ticker: string) {
      const r = await pedir('POST', '/api/ativos', { ticker });
      expect(r.statusCode).toBe(201);
      return ativoResumoSchema.parse(r.json());
    }

    async function adicionar(assetId: number, endereco: string, extra: object = {}) {
      const r = await pedir('POST', `/api/ativos/${assetId}/carteiras`, { endereco, ...extra });
      expect(r.statusCode).toBe(201);
      return adicionarCarteiraRespostaSchema.parse(r.json());
    }

    /** Dispara o próximo ciclo e espera que termine. */
    async function ciclo(assetId: number) {
      relogio.avancar(MINUTO);
      await esperarAte(() => !analise.obterSaude(assetId)?.cicloEmCurso);
    }

    const eventosDoAtivo = async (assetId: number) =>
      (await listarEventos(db, { assetId })).itens.map((e) => e.tipo);

    describe('ativos', () => {
      it('cria um ativo nativo validando-o na Hyperliquid com 1 chamada (meta)', async () => {
        mercado.chamadas.length = 0;
        const ativo = await criarAtivo('BTC');
        expect(ativo).toMatchObject({
          ticker: 'BTC',
          dex: null,
          estado: 'idle',
          numeroCarteiras: 0,
          eventosNaoLidos: 0,
          saude: null,
        });
        expect(mercado.chamadas).toEqual(['meta:']);
      });

      it('cria um ativo HIP-3 consultando o DEX certo', async () => {
        mercado.chamadas.length = 0;
        const ativo = await criarAtivo(' xyz:NVDA ');
        expect(ativo).toMatchObject({ ticker: 'xyz:NVDA', dex: 'xyz' });
        expect(mercado.chamadas).toEqual(['perpDexs', 'meta:xyz']);
      });

      it.each([
        ['DOGE', /"DOGE" não existe nos perps nativos/],
        ['btc', /Quis dizer "BTC"\?/],
        ['abc:NVDA', /O DEX "abc" não existe/],
        ['XYZ:NVDA', /Quis dizer "xyz"\?/],
        ['xyz:FOO', /"xyz:FOO" não existe no DEX "xyz"/],
        ['LUNA', /retirado de negociação/],
      ])('ticker inexistente %s → 400 com mensagem clara', async (ticker, mensagem) => {
        const r = await pedir('POST', '/api/ativos', { ticker });
        expect(r.statusCode).toBe(400);
        expect(erro(r)).toMatchObject({ codigo: 'TICKER_INEXISTENTE' });
        expect(erro(r).mensagem).toMatch(mensagem);
      });

      it('duplicado → 409 sem chamar a Hyperliquid', async () => {
        mercado.chamadas.length = 0;
        const r = await pedir('POST', '/api/ativos', { ticker: 'BTC' });
        expect(r.statusCode).toBe(409);
        expect(erro(r).codigo).toBe('TICKER_DUPLICADO');
        expect(mercado.chamadas).toEqual([]);
      });

      it('Hyperliquid indisponível → 503 (circuito) / 502 (resposta inválida)', async () => {
        mercado.erroMeta = new ErroCircuitoAberto(5_000);
        const r1 = await pedir('POST', '/api/ativos', { ticker: 'ETH' });
        mercado.erroMeta = new ErroHttp(500, 'erro', true);
        const r2 = await pedir('POST', '/api/ativos', { ticker: 'ETH' });
        mercado.erroMeta = null;
        expect([r1.statusCode, r2.statusCode]).toEqual([503, 502]);
        expect(erro(r1).codigo).toBe('HYPERLIQUID_INDISPONIVEL');
      });

      it.each([{}, { ticker: '' }, { ticker: 'a:b:c' }, { ticker: 7 }, { ticker: 'BTC', x: 1 }])(
        'corpo inválido %j → 400',
        async (corpo) => {
          const r = await pedir('POST', '/api/ativos', corpo);
          expect(r.statusCode).toBe(400);
          expect(erro(r).codigo).toBe('VALIDACAO');
        },
      );

      it.each(['abc', '0', '-1', '1.5', '99999999999'])('id inválido %s → 400', async (id) => {
        const r = await pedir('GET', `/api/ativos/${id}`);
        expect(r.statusCode).toBe(400);
        expect(erro(r).detalhes).toMatchObject({ problemas: [{ caminho: 'params.id' }] });
      });

      it('ativo inexistente → 404 em detalhe, apagar, carteiras, análise e agregados', async () => {
        const urls: [Metodo, string, object?][] = [
          ['GET', '/api/ativos/999999'],
          ['DELETE', '/api/ativos/999999'],
          ['POST', '/api/ativos/999999/carteiras', { endereco: enderecoFicticio(1) }],
          ['DELETE', '/api/ativos/999999/carteiras/1'],
          ['POST', '/api/ativos/999999/analise/iniciar'],
          ['POST', '/api/ativos/999999/analise/parar'],
          ['GET', '/api/ativos/999999/agregados'],
        ];
        for (const [m, url, corpo] of urls) {
          const r = await pedir(m, url, corpo);
          expect([url, r.statusCode, erro(r).codigo]).toEqual([url, 404, 'NAO_ENCONTRADO']);
        }
      });
    });

    describe('carteiras do ativo, análise e reinício', () => {
      const A = enderecoFicticio(0xa1);
      const B = enderecoFicticio(0xb2);
      let eth: number;
      let idA: number;
      let idB: number;

      beforeAll(async () => {
        eth = (await criarAtivo('ETH')).id;
        cliente.definir(A, estadoCarteira({ tamanho: 10, entryPx: 95, sl: 90, tp: 120 }));
        cliente.definir(B, estadoCarteira({ tamanho: 5, lado: 'short' }));
      });

      it('adiciona carteira (normaliza o endereço; alias vazio → null); sem análise ativa', async () => {
        const r = await adicionar(eth, A.toUpperCase().replace('0X', '0x'), {
          alias: '  Baleia A ',
          entidade: '',
        });
        idA = r.carteira.id;
        expect(r).toMatchObject({
          carteira: { endereco: A, alias: 'Baleia A', entidade: null },
          analiseReiniciada: false,
        });
      });

      it('carteira já associada → 409 e o alias não muda', async () => {
        const r = await pedir('POST', `/api/ativos/${eth}/carteiras`, {
          endereco: A,
          alias: 'Outro',
        });
        expect(r.statusCode).toBe(409);
        expect(erro(r).codigo).toBe('CARTEIRA_JA_ASSOCIADA');
        const lista = listaCarteirasSchema.parse((await pedir('GET', '/api/carteiras')).json());
        expect(lista.find((c) => c.id === idA)?.alias).toBe('Baleia A');
      });

      it.each([{ endereco: '0x123' }, {}, { endereco: A, alias: 'x'.repeat(101) }])(
        'corpo inválido %j → 400',
        async (corpo) => {
          const r = await pedir('POST', `/api/ativos/${eth}/carteiras`, corpo);
          expect(r.statusCode).toBe(400);
        },
      );

      it('iniciar: sem carteiras → 409; com carteiras → running com saúde', async () => {
        const vazio = (await criarAtivo('xyz:TSLA')).id;
        const r0 = await pedir('POST', `/api/ativos/${vazio}/analise/iniciar`);
        expect([r0.statusCode, erro(r0).codigo]).toEqual([409, 'SEM_CARTEIRAS']);

        const r = await pedir('POST', `/api/ativos/${eth}/analise/iniciar`);
        expect(r.statusCode).toBe(200);
        const ativo = ativoResumoSchema.parse(r.json());
        expect(ativo).toMatchObject({ estado: 'running', numeroCarteiras: 1 });
        expect(ativo.saude).toMatchObject({
          cicloEmCurso: false,
          ultimoErro: null,
          carteirasDesatualizadas: [],
        });
        expect(ativo.saude?.ultimoCicloSucesso).not.toBeNull();

        const r2 = await pedir('POST', `/api/ativos/${eth}/analise/iniciar`);
        expect([r2.statusCode, erro(r2).codigo]).toEqual([409, 'JA_EM_CURSO']);
      });

      it('detalhe: posição, SL/TP, accountValue, preço da Hyperliquid e saúde', async () => {
        const r = await pedir('GET', `/api/ativos/${eth}`);
        expect(r.statusCode).toBe(200);
        const d = ativoDetalheSchema.parse(r.json());
        expect(d.precoMercado).toMatchObject({ fonte: 'hyperliquid' });
        expect(d.carteiras).toHaveLength(1);
        expect(d.carteiras[0]).toMatchObject({
          id: idA,
          alias: 'Baleia A',
          desatualizada: false,
          ultimoSnapshot: {
            accountValue: 1_000_000,
            accountValueRepresentativo: null,
            precoMercado: 100,
            posicao: { lado: 'long', tamanho: 10, entryPx: 95, alavancagem: 5 },
            ordens: [
              { tipo: 'SL', triggerPx: 90, tamanho: null, reduceOnly: true },
              { tipo: 'TP', triggerPx: 120, tamanho: null, reduceOnly: true },
            ],
          },
        });
      });

      it('detalhe: sem preço ao vivo (erro, demora ou ausente) usa o último snapshot', async () => {
        for (const mids of [new Error('rede'), 'pendente' as const, {}]) {
          mercado.mids = mids;
          const d = ativoDetalheSchema.parse((await pedir('GET', `/api/ativos/${eth}`)).json());
          expect(d.precoMercado).toMatchObject({ valor: 100, fonte: 'snapshot' });
        }
        // Ativo sem snapshots e sem preço: `null`.
        const lista = listaAtivosSchema.parse((await pedir('GET', '/api/ativos')).json());
        const nvda = lista.find((a) => a.ticker === 'xyz:NVDA')!.id;
        const d = ativoDetalheSchema.parse((await pedir('GET', `/api/ativos/${nvda}`)).json());
        expect(d.precoMercado).toBeNull();
        mercado.mids = { BTC: 65_000, ETH: 3_000 };
      });

      it('carteira cuja leitura falha fica marcada como desatualizada', async () => {
        cliente.definir(
          A,
          new Error('rede'),
          estadoCarteira({ tamanho: 10, entryPx: 95, sl: 90, tp: 120 }),
        );
        await ciclo(eth);
        const d = ativoDetalheSchema.parse((await pedir('GET', `/api/ativos/${eth}`)).json());
        expect(d.carteiras[0]?.desatualizada).toBe(true);
        expect(d.saude?.ultimoErro?.mensagem).toBe('rede');
        await ciclo(eth);
        const d2 = ativoDetalheSchema.parse((await pedir('GET', `/api/ativos/${eth}`)).json());
        expect(d2.carteiras[0]?.desatualizada).toBe(false);
      });

      it('adicionar carteira com análise ativa reinicia: novo run e sem falsos OPENED', async () => {
        const run1 = (await obterRunAtivo(db, eth))!.id;
        const r = await adicionar(eth, B);
        idB = r.carteira.id;
        expect(r.analiseReiniciada).toBe(true);
        const run2 = (await obterRunAtivo(db, eth))!;
        expect(run2.id).not.toBe(run1);
        expect(run2.motivoReinicio).toBe(`carteira adicionada (${B})`);
        await ciclo(eth);
        expect(await eventosDoAtivo(eth)).toEqual([]);
        const d = ativoDetalheSchema.parse((await pedir('GET', `/api/ativos/${eth}`)).json());
        expect(d.saude?.runId).toBe(run2.id);
        expect(d.carteiras.map((c) => c.ultimoSnapshot?.posicao?.lado)).toEqual(['long', 'short']);
      });

      it('agregados do run atual', async () => {
        const r = await pedir('GET', `/api/ativos/${eth}/agregados`);
        expect(r.statusCode).toBe(200);
        const a = agregadosAtivoRespostaSchema.parse(r.json());
        expect(a.atual).toMatchObject({ ativo: 'ETH', totalCarteiras: 2, netUsd: 1_000 - 500 });
        expect(a.atual.instante).not.toBeNull();
      });

      it('remover carteira com análise ativa reinicia; remover de novo → 404', async () => {
        const run2 = (await obterRunAtivo(db, eth))!.id;
        const r = await pedir('DELETE', `/api/ativos/${eth}/carteiras/${idB}`);
        expect(r.statusCode).toBe(204);
        const run3 = (await obterRunAtivo(db, eth))!;
        expect(run3.id).not.toBe(run2);
        expect(run3.motivoReinicio).toBe(`carteira removida (${idB})`);
        expect(await eventosDoAtivo(eth)).toEqual([]);

        const r2 = await pedir('DELETE', `/api/ativos/${eth}/carteiras/${idB}`);
        expect([r2.statusCode, erro(r2).codigo]).toEqual([404, 'NAO_ENCONTRADO']);
      });

      it('parar → stopped; parar de novo → 409', async () => {
        const r = await pedir('POST', `/api/ativos/${eth}/analise/parar`);
        expect(r.statusCode).toBe(200);
        expect(ativoResumoSchema.parse(r.json())).toMatchObject({ estado: 'stopped', saude: null });
        const r2 = await pedir('POST', `/api/ativos/${eth}/analise/parar`);
        expect([r2.statusCode, erro(r2).codigo]).toEqual([409, 'NAO_EM_CURSO']);
      });

      it('remover a última carteira de um ativo em análise pára a análise', async () => {
        await pedir('POST', `/api/ativos/${eth}/analise/iniciar`);
        const r = await pedir('DELETE', `/api/ativos/${eth}/carteiras/${idA}`);
        expect(r.statusCode).toBe(204);
        const d = ativoDetalheSchema.parse((await pedir('GET', `/api/ativos/${eth}`)).json());
        expect(d).toMatchObject({ estado: 'stopped', numeroCarteiras: 0, carteiras: [] });
      });

      it('lista de ativos com nº de carteiras, eventos não lidos e saúde', async () => {
        await adicionar(eth, A);
        const lista = listaAtivosSchema.parse((await pedir('GET', '/api/ativos')).json());
        expect(lista.find((a) => a.id === eth)).toMatchObject({
          ticker: 'ETH',
          numeroCarteiras: 1,
          eventosNaoLidos: 0,
          saude: null,
        });
      });
    });

    describe('carteiras (global)', () => {
      const C = enderecoFicticio(0xc3);
      let idC: number;
      let ativos: number[];

      beforeAll(async () => {
        mercado.metas.nativo!.push(
          { ...mercado.metas.nativo![0]!, coin: 'SOL' },
          { ...mercado.metas.nativo![0]!, coin: 'AVAX' },
        );
        ativos = [(await criarAtivo('SOL')).id, (await criarAtivo('AVAX')).id];
        cliente.definir(C, estadoCarteira({ tamanho: 1 }));
        cliente.definir(enderecoFicticio(0xd4), estadoCarteira());
        for (const id of ativos) {
          idC = (await adicionar(id, C)).carteira.id;
          await adicionar(id, enderecoFicticio(0xd4));
        }
      });

      it('lista as carteiras com os ativos a que pertencem', async () => {
        const lista = listaCarteirasSchema.parse((await pedir('GET', '/api/carteiras')).json());
        expect(lista.find((c) => c.id === idC)?.ativos.map((a) => a.ticker)).toEqual([
          'SOL',
          'AVAX',
        ]);
      });

      it('PATCH altera alias/entidade; "" limpa; {} mantém', async () => {
        const r = await pedir('PATCH', `/api/carteiras/${idC}`, {
          alias: 'Fundo',
          entidade: 'Entidade X',
        });
        expect(r.statusCode).toBe(200);
        expect(carteiraDtoSchema.parse(r.json())).toMatchObject({
          alias: 'Fundo',
          entidade: 'Entidade X',
        });
        const r2 = await pedir('PATCH', `/api/carteiras/${idC}`, { alias: '' });
        expect(r2.json()).toMatchObject({ alias: null, entidade: 'Entidade X' });
        const r3 = await pedir('PATCH', `/api/carteiras/${idC}`, {});
        expect(r3.json()).toMatchObject({ alias: null, entidade: 'Entidade X' });
      });

      it('PATCH: campo desconhecido → 400; inexistente → 404', async () => {
        expect((await pedir('PATCH', `/api/carteiras/${idC}`, { endereco: 'x' })).statusCode).toBe(
          400,
        );
        const r = await pedir('PATCH', '/api/carteiras/999999', { alias: 'x' });
        expect([r.statusCode, erro(r).codigo]).toEqual([404, 'NAO_ENCONTRADO']);
      });

      it('DELETE reinicia as análises ativas dos ativos afetados', async () => {
        for (const id of ativos) await pedir('POST', `/api/ativos/${id}/analise/iniciar`);
        const antes = await Promise.all(
          ativos.map(async (id) => (await obterRunAtivo(db, id))!.id),
        );
        const r = await pedir('DELETE', `/api/carteiras/${idC}`);
        expect(r.statusCode).toBe(204);
        const depois = await Promise.all(ativos.map(async (id) => (await obterRunAtivo(db, id))!));
        depois.forEach((run, i) => {
          expect(run.id).not.toBe(antes[i]);
          expect(run.motivoReinicio).toBe(`carteira apagada (${idC})`);
        });
        const lista = listaCarteirasSchema.parse((await pedir('GET', '/api/carteiras')).json());
        expect(lista.some((c) => c.id === idC)).toBe(false);
        const r2 = await pedir('DELETE', `/api/carteiras/${idC}`);
        expect(r2.statusCode).toBe(404);
      });

      it('DELETE de um ativo em análise pára-a antes de apagar', async () => {
        const id = ativos[0]!;
        expect(analise.ativosEmAnalise()).toContain(id);
        const r = await pedir('DELETE', `/api/ativos/${id}`);
        expect(r.statusCode).toBe(204);
        expect(analise.ativosEmAnalise()).not.toContain(id);
        expect((await pedir('GET', `/api/ativos/${id}`)).statusCode).toBe(404);
        // Apagar um ativo parado também funciona.
        await pedir('POST', `/api/ativos/${ativos[1]}/analise/parar`);
        expect((await pedir('DELETE', `/api/ativos/${ativos[1]}`)).statusCode).toBe(204);
      });
    });
  },
);
