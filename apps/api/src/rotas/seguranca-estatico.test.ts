import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { respostaErroSchema } from '@hyper-radar/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ErroAnaliseJaEmCurso, ErroServicoEncerrado } from '../analise';
import {
  ErroCircuitoAberto,
  ErroHttp,
  ErroLimiteTaxa,
  ErroParametroInvalido,
  ErroRespostaInvalida,
} from '../hyperliquid';
import {
  ErroNaoEncontrado,
  ErroRestricaoViolada,
  ErroRunJaAberto,
  ErroTickerDuplicado,
} from '../repositorios';
import { criarApp, dbInutilizavel } from './__testes__/auxiliares';
import { analisar, ErroApi, traduzirErro } from './erros';

// Pasta temporária com um "build" do frontend e um ficheiro secreto fora dela.
const base = mkdtempSync(join(tmpdir(), 'hyperradar-web-'));
const pastaWeb = join(base, 'dist');
mkdirSync(join(pastaWeb, 'assets'), { recursive: true });
writeFileSync(join(pastaWeb, 'index.html'), '<!doctype html><title>HyperRadar</title>');
writeFileSync(join(pastaWeb, 'assets', 'app-123.js'), 'console.log(1)');
writeFileSync(join(pastaWeb, 'favicon.svg'), '<svg/>');
writeFileSync(join(pastaWeb, 'dados.bin'), 'x');
writeFileSync(join(base, 'segredo.txt'), 'SEGREDO');

const { app } = criarApp(dbInutilizavel, {
  pastaWeb,
  seguranca: { porta: 3000, origensPermitidas: ['http://127.0.0.1:5173/'] },
});
const HOST = { host: 'localhost:3000' };

afterAll(async () => {
  await app.close();
  rmSync(base, { recursive: true, force: true });
});

const erroDe = (corpo: unknown) => respostaErroSchema.parse(corpo).erro;

describe('proteção de Host (DNS rebinding)', () => {
  it.each(['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'LOCALHOST:3000'])(
    'aceita %s',
    async (host) => {
      const r = await app.inject({ method: 'GET', url: '/api/inexistente', headers: { host } });
      expect(r.statusCode).toBe(404);
      expect(erroDe(r.json()).codigo).toBe('NAO_ENCONTRADO');
    },
  );

  it.each(['evil.example:3000', 'localhost:4000', 'localhost', '127.0.0.1.evil.example', ''])(
    'rejeita %j com 403',
    async (host) => {
      const r = await app.inject({ method: 'GET', url: '/api/ativos', headers: { host } });
      expect(r.statusCode).toBe(403);
      expect(erroDe(r.json()).codigo).toBe('HOST_INVALIDO');
    },
  );

  it('sem porta configurada aceita qualquer porta local', async () => {
    const { app: semPorta } = criarApp(dbInutilizavel);
    const r = await semPorta.inject({
      method: 'GET',
      url: '/x',
      headers: { host: 'localhost:9999' },
    });
    expect(r.statusCode).toBe(404);
    await semPorta.close();
  });
});

describe('proteção de Origin (CSRF) em métodos mutáveis', () => {
  const post = (origin?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/ativos',
      headers: { ...HOST, ...(origin === undefined ? {} : { origin }) },
      payload: {},
    });

  it.each(['http://evil.example', 'null', 'http://localhost:5173', 'https://localhost:3000'])(
    'rejeita Origin %s',
    async (origin) => {
      const r = await post(origin);
      expect(r.statusCode).toBe(403);
      expect(erroDe(r.json()).codigo).toBe('ORIGEM_INVALIDA');
    },
  );

  // Passam a proteção e chegam à validação do corpo (400), sem tocar na BD.
  it.each([undefined, 'http://localhost:3000', 'http://127.0.0.1:5173'])(
    'aceita Origin %s',
    async (origin) => {
      const r = await post(origin);
      expect(r.statusCode).toBe(400);
      expect(erroDe(r.json()).codigo).toBe('VALIDACAO');
    },
  );

  it('GET de outra origem não é bloqueado (sem CORS, o browser não lê a resposta)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/inexistente',
      headers: { ...HOST, origin: 'http://evil.example' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('corpo dos pedidos', () => {
  const post = (payload: string, contentType: string) =>
    app.inject({
      method: 'POST',
      url: '/api/ativos',
      headers: { ...HOST, 'content-type': contentType },
      payload,
    });

  it('text/plain → 415 (formulários "simples")', async () => {
    const r = await post('{"ticker":"BTC"}', 'text/plain');
    expect(r.statusCode).toBe(415);
    expect(erroDe(r.json()).codigo).toBe('TIPO_CONTEUDO_INVALIDO');
  });

  it('JSON inválido → 400', async () => {
    const r = await post('{"ticker":', 'application/json');
    expect(r.statusCode).toBe(400);
    expect(erroDe(r.json()).codigo).toBe('JSON_INVALIDO');
  });

  it('JSON vazio → 400', async () => {
    const r = await post('', 'application/json');
    expect(r.statusCode).toBe(400);
    expect(erroDe(r.json()).codigo).toBe('JSON_INVALIDO');
  });

  it('acima do limite → 413', async () => {
    const r = await post(JSON.stringify({ ticker: 'x'.repeat(1_100_000) }), 'application/json');
    expect(r.statusCode).toBe(413);
    expect(erroDe(r.json()).codigo).toBe('CORPO_DEMASIADO_GRANDE');
  });

  it('validação devolve os problemas por campo, em PT-PT', async () => {
    const r = await post(JSON.stringify({ ticker: 'a b', extra: 1 }), 'application/json');
    expect(r.statusCode).toBe(400);
    const erro = erroDe(r.json());
    expect(erro.mensagem).toMatch(/^Pedido inválido \(body/);
    expect(erro.detalhes).toMatchObject({
      problemas: expect.arrayContaining([
        { caminho: 'body.ticker', mensagem: 'Ticker inválido: use "ATIVO" ou "dex:ATIVO".' },
      ]),
    });
  });

  it('erro inesperado → 500 sem detalhes internos', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ativos', headers: HOST });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({
      erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno do servidor.' },
    });
  });

  it('cabeçalhos de endurecimento em todas as respostas', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/x', headers: HOST });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });
});

describe('frontend estático', () => {
  const get = (url: string, method: 'GET' | 'HEAD' | 'POST' = 'GET') =>
    app.inject({ method, url, headers: HOST });

  it('serve index.html na raiz, sem cache', async () => {
    const r = await get('/');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.body).toContain('HyperRadar');
  });

  it('fallback SPA para rotas do frontend (sem extensão), com query string', async () => {
    const r = await get('/ativos/3?separador=eventos');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('HyperRadar');
  });

  it('serve assets com tipo MIME e cache imutável', async () => {
    const r = await get('/assets/app-123.js');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(r.headers['cache-control']).toContain('immutable');
    expect((await get('/favicon.svg')).headers['content-type']).toBe('image/svg+xml');
    expect((await get('/dados.bin')).headers['content-type']).toBe('application/octet-stream');
  });

  it('HEAD é aceite', async () => {
    expect((await get('/', 'HEAD')).statusCode).toBe(200);
  });

  it.each(['/assets/falta.js', '/api/nada', '/api', '/health/x'])(
    '%s → 404 JSON (sem fallback)',
    async (url) => {
      const r = await get(url);
      expect(r.statusCode).toBe(404);
      expect(erroDe(r.json()).codigo).toBe('NAO_ENCONTRADO');
    },
  );

  it('POST a um caminho desconhecido → 404 JSON', async () => {
    const r = await app.inject({ method: 'POST', url: '/qualquer', headers: HOST });
    expect(r.statusCode).toBe(404);
  });

  it.each([
    '/..%2fsegredo.txt',
    '/%2e%2e/segredo.txt',
    '/assets/..%2f..%2fsegredo.txt',
    '/..%5csegredo.txt',
    '/%2e%2e%5c%2e%2e%5csegredo.txt',
    '/index.html%00.js',
  ])('path traversal %s não sai da pasta', async (url) => {
    const r = await get(url);
    expect(r.body).not.toContain('SEGREDO');
    expect(r.statusCode).toBe(404);
  });

  it('caminho mal codificado → 400', async () => {
    const r = await get('/%E0%A4%A');
    expect(r.statusCode).toBe(400);
    expect(erroDe(r.json()).codigo).toBe('PEDIDO_INVALIDO');
  });

  it('sem build do frontend, a raiz dá 404 JSON', async () => {
    const { app: semWeb } = criarApp(dbInutilizavel, { pastaWeb: join(base, 'nao-existe') });
    const r = await semWeb.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(404);
    expect(erroDe(r.json()).codigo).toBe('NAO_ENCONTRADO');
    await semWeb.close();
  });
});

describe('mapeamento central de erros', () => {
  it.each([
    [new ErroNaoEncontrado('Ativo', 1), 404, 'NAO_ENCONTRADO'],
    [new ErroTickerDuplicado('BTC'), 409, 'TICKER_DUPLICADO'],
    [new ErroRunJaAberto(), 409, 'RUN_JA_ABERTO'],
    [new ErroRestricaoViolada('x'), 400, 'RESTRICAO_VIOLADA'],
    [new ErroAnaliseJaEmCurso('BTC'), 409, 'JA_EM_CURSO'],
    [new ErroServicoEncerrado(), 503, 'SERVICO_INDISPONIVEL'],
    [new ErroCircuitoAberto(10_000), 503, 'HYPERLIQUID_INDISPONIVEL'],
    [new ErroLimiteTaxa(), 503, 'HYPERLIQUID_INDISPONIVEL'],
    [new ErroHttp(500, 'falhou', true), 502, 'HYPERLIQUID_INDISPONIVEL'],
    [new ErroRespostaInvalida('detalhe interno'), 502, 'HYPERLIQUID_INDISPONIVEL'],
    [new ErroParametroInvalido('DEX inválido'), 400, 'PEDIDO_INVALIDO'],
    [new ErroApi(409, 'CARTEIRA_JA_ASSOCIADA', 'x'), 409, 'CARTEIRA_JA_ASSOCIADA'],
    [Object.assign(new Error('x'), { statusCode: 405 }), 405, 'PEDIDO_INVALIDO'],
    [new Error('segredo interno'), 500, 'ERRO_INTERNO'],
    ['não é um erro', 500, 'ERRO_INTERNO'],
  ])('%s → %i %s', (erro, estado, codigo) => {
    const r = traduzirErro(erro);
    expect(r.estado).toBe(estado);
    expect(r.corpo.erro.codigo).toBe(codigo);
    expect(JSON.stringify(r.corpo)).not.toContain('interno"');
  });

  it('erros da Hyperliquid não expõem detalhes internos', () => {
    const r = traduzirErro(new ErroRespostaInvalida('campo x em falta'));
    expect(r.corpo.erro.mensagem).not.toContain('campo x');
  });

  it('analisar: params/query ausentes validam como objeto vazio', () => {
    expect(() => analisar(respostaErroSchema, undefined, 'query')).toThrow(
      /Pedido inválido \(query\.erro\)/,
    );
  });
});
