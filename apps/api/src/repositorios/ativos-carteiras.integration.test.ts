import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarAmbiente, disponivel, enderecoFicticio } from './__testes__/ambiente';
import {
  alterarEstadoAtivo,
  apagarAtivo,
  criarAtivo,
  listarAtivos,
  listarAtivosParaRetomar,
  obterAtivoPorId,
  obterAtivoPorTicker,
} from './ativos';
import {
  alterarCarteira,
  apagarCarteira,
  associarCarteira,
  criarOuObterCarteira,
  desassociarCarteira,
  listarCarteirasComAtivos,
  listarCarteirasDoAtivo,
  obterCarteiraPorEndereco,
  obterCarteiraPorId,
} from './carteiras';
import {
  ErroEnderecoInvalido,
  ErroNaoEncontrado,
  ErroTickerDuplicado,
  ErroTickerInvalido,
} from './erros';

describe.skipIf(!disponivel)('repositórios de ativos e carteiras (Postgres real)', () => {
  const ambiente = criarAmbiente();
  const { db } = ambiente;

  beforeAll(() => ambiente.preparar());
  afterAll(() => ambiente.limpar());

  describe('ativos', () => {
    it('cria ativos nativos e HIP-3, derivando o dex e normalizando espaços', async () => {
      const btc = await criarAtivo(db, '  BTC ');
      const nvda = await criarAtivo(db, 'xyz:NVDA');
      expect(btc).toMatchObject({ ticker: 'BTC', dex: null, estado: 'idle' });
      expect(btc.criadoEm).toBeInstanceOf(Date);
      expect(nvda).toMatchObject({ ticker: 'xyz:NVDA', dex: 'xyz', estado: 'idle' });
    });

    it('rejeita ticker duplicado com erro legível', async () => {
      const erro = await criarAtivo(db, 'BTC').catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ErroTickerDuplicado);
      expect((erro as Error).message).toBe('O ativo "BTC" já existe.');
    });

    it.each(['', '   ', 'xyz:', ':NVDA', 'a:b:c'])('rejeita ticker inválido "%s"', async (t) => {
      await expect(criarAtivo(db, t)).rejects.toBeInstanceOf(ErroTickerInvalido);
    });

    it('lista e obtém por id e por ticker', async () => {
      const todos = await listarAtivos(db);
      expect(todos.map((a) => a.ticker)).toEqual(['BTC', 'xyz:NVDA']);
      const nvda = await obterAtivoPorTicker(db, ' xyz:NVDA ');
      expect(nvda?.dex).toBe('xyz');
      expect(await obterAtivoPorId(db, nvda!.id)).toEqual(nvda);
      expect(await obterAtivoPorId(db, 999_999)).toBeNull();
      expect(await obterAtivoPorTicker(db, 'NADA')).toBeNull();
    });

    it('altera o estado e lista os ativos a retomar', async () => {
      const [btc, nvda] = await listarAtivos(db);
      const eth = await criarAtivo(db, 'ETH');
      await alterarEstadoAtivo(db, btc!.id, 'running');
      await alterarEstadoAtivo(db, nvda!.id, 'restarting');
      const parado = await alterarEstadoAtivo(db, eth.id, 'stopped');
      expect(parado.estado).toBe('stopped');
      expect((await listarAtivosParaRetomar(db)).map((a) => a.ticker)).toEqual(['BTC', 'xyz:NVDA']);
      await expect(alterarEstadoAtivo(db, 999_999, 'idle')).rejects.toBeInstanceOf(
        ErroNaoEncontrado,
      );
    });

    it('apaga um ativo', async () => {
      const a = await criarAtivo(db, 'APAGAR');
      expect(await apagarAtivo(db, a.id)).toBe(true);
      expect(await apagarAtivo(db, a.id)).toBe(false);
      expect(await obterAtivoPorId(db, a.id)).toBeNull();
    });
  });

  describe('carteiras', () => {
    it('cria normalizando para minúsculas e faz upsert pelo endereço', async () => {
      const maiusculas = `0x${'AB'.repeat(20)}`;
      const c1 = await criarOuObterCarteira(db, { endereco: ` ${maiusculas} `, alias: 'Baleia' });
      expect(c1).toMatchObject({ endereco: maiusculas.toLowerCase(), alias: 'Baleia' });

      // Sem alias: mantém o atual; com entidade: atualiza.
      const c2 = await criarOuObterCarteira(db, { endereco: maiusculas, entidade: 'Fundo X' });
      expect(c2).toMatchObject({ id: c1.id, alias: 'Baleia', entidade: 'Fundo X' });
      const c3 = await criarOuObterCarteira(db, { endereco: maiusculas, alias: null });
      expect(c3).toMatchObject({ id: c1.id, alias: null, entidade: 'Fundo X' });

      expect(await obterCarteiraPorEndereco(db, maiusculas)).toEqual(c3);
      expect(await obterCarteiraPorId(db, c1.id)).toEqual(c3);
      expect(await obterCarteiraPorId(db, 999_999)).toBeNull();
      expect(await obterCarteiraPorEndereco(db, enderecoFicticio(0xdead))).toBeNull();
    });

    it.each(['0x123', 'abc', `0x${'g'.repeat(40)}`])('rejeita endereço inválido %s', async (e) => {
      await expect(criarOuObterCarteira(db, { endereco: e })).rejects.toBeInstanceOf(
        ErroEnderecoInvalido,
      );
      await expect(obterCarteiraPorEndereco(db, e)).rejects.toBeInstanceOf(ErroEnderecoInvalido);
    });

    it('altera alias e entidade', async () => {
      const c = await criarOuObterCarteira(db, { endereco: enderecoFicticio(1) });
      expect(await alterarCarteira(db, c.id, { alias: 'A' })).toMatchObject({
        alias: 'A',
        entidade: null,
      });
      expect(await alterarCarteira(db, c.id, { entidade: 'E', alias: null })).toMatchObject({
        alias: null,
        entidade: 'E',
      });
      expect(await alterarCarteira(db, c.id, {})).toMatchObject({ entidade: 'E' });
      await expect(alterarCarteira(db, 999_999, { alias: 'x' })).rejects.toBeInstanceOf(
        ErroNaoEncontrado,
      );
      await expect(alterarCarteira(db, 999_999, {})).rejects.toBeInstanceOf(ErroNaoEncontrado);
    });

    it('associa, lista por ativo e com ativos, desassocia', async () => {
      const btc = (await obterAtivoPorTicker(db, 'BTC'))!;
      const nvda = (await obterAtivoPorTicker(db, 'xyz:NVDA'))!;
      const a = await criarOuObterCarteira(db, { endereco: enderecoFicticio(10), alias: 'A' });
      const b = await criarOuObterCarteira(db, { endereco: enderecoFicticio(11), alias: 'B' });

      expect(await associarCarteira(db, btc.id, a.id)).toBe(true);
      expect(await associarCarteira(db, btc.id, a.id)).toBe(false);
      await associarCarteira(db, btc.id, b.id);
      await associarCarteira(db, nvda.id, a.id);
      await expect(associarCarteira(db, btc.id, 999_999)).rejects.toBeInstanceOf(ErroNaoEncontrado);
      await expect(associarCarteira(db, 999_999, a.id)).rejects.toThrow(/Ativo/);

      expect((await listarCarteirasDoAtivo(db, btc.id)).map((c) => c.alias)).toEqual(['A', 'B']);

      const todas = await listarCarteirasComAtivos(db);
      const ca = todas.find((c) => c.id === a.id);
      const cb = todas.find((c) => c.id === b.id);
      expect(ca?.ativos.map((x) => x.ticker).sort()).toEqual(['BTC', 'xyz:NVDA']);
      expect(cb?.ativos).toEqual([{ id: btc.id, ticker: 'BTC' }]);
      // Carteiras sem ativos aparecem com lista vazia.
      expect(todas.some((c) => c.ativos.length === 0)).toBe(true);

      expect(await desassociarCarteira(db, btc.id, b.id)).toBe(true);
      expect(await desassociarCarteira(db, btc.id, b.id)).toBe(false);
      expect((await listarCarteirasDoAtivo(db, btc.id)).map((c) => c.alias)).toEqual(['A']);
    });

    it('apagar carteira remove as associações (cascata)', async () => {
      const btc = (await obterAtivoPorTicker(db, 'BTC'))!;
      const c = await criarOuObterCarteira(db, { endereco: enderecoFicticio(20) });
      await associarCarteira(db, btc.id, c.id);
      expect(await apagarCarteira(db, c.id)).toBe(true);
      expect(await apagarCarteira(db, c.id)).toBe(false);
      expect((await listarCarteirasDoAtivo(db, btc.id)).map((x) => x.id)).not.toContain(c.id);
    });

    it('apagar ativo remove as associações mas mantém a carteira', async () => {
      const ativo = await criarAtivo(db, 'CASCATA');
      const c = await criarOuObterCarteira(db, { endereco: enderecoFicticio(30) });
      await associarCarteira(db, ativo.id, c.id);
      await apagarAtivo(db, ativo.id);
      const todas = await listarCarteirasComAtivos(db);
      expect(todas.find((x) => x.id === c.id)?.ativos).toEqual([]);
    });
  });
});
