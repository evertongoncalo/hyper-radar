import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { CHAVE_OPENAI_FALSA, RAIZ, type FaseBaleia, type RegistoFalso } from './configuracao';

/*
 * Servidor falso local (Node `http`, sem dependências) para os E2E: imita `POST /info` da
 * Hyperliquid (dados derivados das fixtures gravadas) e `POST /v1/responses` da OpenAI.
 * O estado da carteira falsa é programável por fase em `POST /__controlo/estado`.
 * Escuta só em 127.0.0.1; a API real nunca é contactada.
 */

const PASTA_FIXTURES = join(RAIZ, 'apps', 'api', 'src', 'hyperliquid', '__fixtures__');
type Json = unknown;
type Registo = Record<string, unknown>;

const fixture = (nome: string): Json =>
  JSON.parse(readFileSync(join(PASTA_FIXTURES, `${nome}.json`), 'utf8'));

/** Valor da conta da baleia falsa (USD) e posição long aberta na fase `long-aberta`. */
const ACCOUNT_VALUE = '100000.0';
export const POSICAO_LONG = {
  szi: '2.0',
  entryPx: '65000.0',
  positionValue: '130500.0',
  marginUsed: '13050.0',
  liquidationPx: '16312.5',
  stopLoss: '63000.0',
  takeProfit: '70000.0',
} as const;

function clearinghouseState(fase: FaseBaleia): Json {
  if (fase === 'sem-posicao') {
    const base = fixture('clearinghouseState-sem-posicoes') as Registo;
    const resumo = { ...(base.marginSummary as Registo), accountValue: ACCOUNT_VALUE };
    return {
      ...base,
      marginSummary: resumo,
      crossMarginSummary: resumo,
      withdrawable: ACCOUNT_VALUE,
      time: Date.now(),
    };
  }
  // Fixture com posição (short BTC) convertida numa long BTC com SL/TP.
  const base = fixture('clearinghouseState-com-posicao') as Registo;
  const [ap] = base.assetPositions as Registo[];
  const posicao = ap!.position as Registo;
  const resumo = {
    accountValue: ACCOUNT_VALUE,
    totalNtlPos: POSICAO_LONG.positionValue,
    totalRawUsd: '-30500.0',
    totalMarginUsed: POSICAO_LONG.marginUsed,
  };
  return {
    ...base,
    marginSummary: resumo,
    crossMarginSummary: resumo,
    crossMaintenanceMarginUsed: '3262.5',
    withdrawable: '86950.0',
    assetPositions: [
      {
        ...ap,
        position: {
          ...posicao,
          szi: POSICAO_LONG.szi,
          leverage: { type: 'cross', value: 10 },
          entryPx: POSICAO_LONG.entryPx,
          positionValue: POSICAO_LONG.positionValue,
          unrealizedPnl: '500.0',
          returnOnEquity: '0.0383141762',
          liquidationPx: POSICAO_LONG.liquidationPx,
          marginUsed: POSICAO_LONG.marginUsed,
        },
      },
    ],
    time: Date.now(),
  };
}

function frontendOpenOrders(fase: FaseBaleia): Json {
  if (fase === 'sem-posicao') return fixture('frontendOpenOrders-vazio');
  // Fixture com SL/TP de uma short, invertidos para proteger a long (vendas reduce-only).
  const [sl, tp] = fixture('frontendOpenOrders-com-triggers') as Registo[];
  const agora = Date.now();
  return [
    {
      ...sl,
      side: 'A',
      limitPx: '62000.0',
      triggerCondition: 'Price below 63000',
      triggerPx: POSICAO_LONG.stopLoss,
      timestamp: agora,
    },
    {
      ...tp,
      side: 'A',
      limitPx: '71000.0',
      triggerCondition: 'Price above 70000',
      triggerPx: POSICAO_LONG.takeProfit,
      timestamp: agora,
    },
  ];
}

/** Resposta ao corpo de `POST /info`, ou `undefined` se o tipo não for suportado. */
function responderInfo(corpo: Registo, fase: FaseBaleia): Json | undefined {
  const dex = typeof corpo.dex === 'string' && corpo.dex !== '' ? corpo.dex : null;
  const sufixo = dex === null ? 'nativo' : dex === 'xyz' ? 'xyz' : null;
  switch (corpo.type) {
    case 'perpDexs':
      return fixture('perpDexs');
    case 'meta':
    case 'metaAndAssetCtxs':
    case 'allMids':
      // Como na API real: DEX inexistente → 500 com corpo `null` (tratado no chamador).
      return sufixo === null ? null : fixture(`${corpo.type}-${sufixo}`);
    case 'clearinghouseState':
      return clearinghouseState(fase);
    case 'frontendOpenOrders':
      return frontendOpenOrders(fase);
    case 'userFills':
      return fixture('userFills');
    case 'userFillsByTime':
      return fixture('userFillsByTime');
    case 'userAbstraction':
      // A fixture é "unifiedAccount" (accountValue não representativo); aqui conta normal.
      return 'default';
    default:
      return undefined;
  }
}

/** Relatório válido no schema strict (`relatorio_ia_hyperradar`). */
export const RELATORIO_FALSO = {
  resumo:
    'Cenário hipotético: a carteira acompanhada abriu uma posição long em BTC; os dados sugerem, com incerteza, um viés de alta.',
  vies: 'alta',
  confianca: 0.55,
  alinhamento_baleias: {
    nivel: 'moderado',
    descricao: 'Só uma carteira acompanhada, em long; o alinhamento não pode ser confirmado.',
  },
  riscos: ['Uma única carteira pode ser cobertura (hedge) noutra conta.'],
  niveis_chave: [
    { preco: 63000, descricao: 'Stop loss da baleia.' },
    { preco: 70000, descricao: 'Take profit da baleia.' },
  ],
  cenarios: [
    {
      nome: 'Continuação',
      probabilidade: 0.55,
      descricao: 'O preço poderá testar a zona dos 70 000.',
      gatilho: 'Fecho acima de 66 000.',
    },
  ],
  cenario_entrada_sugerido: {
    lado: 'long',
    entrada: 65250,
    stop_loss: 63000,
    take_profit: 70000,
    justificacao: 'Hipótese condicional alinhada com os níveis da baleia; sem garantias.',
  },
  avisos: ['Aviso E2E: não constitui aconselhamento financeiro.'],
} as const;

function responderOpenAi(corpo: Registo): { estado: number; json: Json } {
  const formato = (corpo.text as Registo | undefined)?.format as Registo | undefined;
  if (
    typeof corpo.model !== 'string' ||
    formato?.type !== 'json_schema' ||
    formato.strict !== true ||
    formato.name !== 'relatorio_ia_hyperradar'
  ) {
    return { estado: 400, json: { error: { code: 'invalid_request', type: 'e2e' } } };
  }
  return {
    estado: 200,
    json: {
      id: 'resp_e2e',
      object: 'response',
      status: 'completed',
      model: `${corpo.model}-e2e`,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(RELATORIO_FALSO) }],
        },
      ],
      usage: { input_tokens: 1200, output_tokens: 450 },
    },
  };
}

function lerCorpo(pedido: IncomingMessage): Promise<Registo | null> {
  return new Promise((resolver, rejeitar) => {
    const partes: Buffer[] = [];
    pedido.on('data', (p: Buffer) => partes.push(p));
    pedido.on('error', rejeitar);
    pedido.on('end', () => {
      try {
        const json: unknown = JSON.parse(Buffer.concat(partes).toString('utf8') || 'null');
        resolver(typeof json === 'object' && json !== null ? (json as Registo) : null);
      } catch {
        resolver(null);
      }
    });
  });
}

function enviar(resposta: ServerResponse, estado: number, json: Json): void {
  resposta.writeHead(estado, { 'content-type': 'application/json' });
  resposta.end(JSON.stringify(json));
}

export interface ServidorFalso {
  fechar(): Promise<void>;
}

export async function arrancarServidorFalso(porta: number): Promise<ServidorFalso> {
  let fase: FaseBaleia = 'sem-posicao';
  const registo: RegistoFalso = { info: {}, openai: 0, desconhecidos: 0 };

  const servidor: Server = createServer((pedido, resposta) => {
    void (async () => {
      const corpo = pedido.method === 'POST' ? await lerCorpo(pedido) : null;
      const rota = `${pedido.method} ${pedido.url}`;
      if (rota === 'POST /info' && corpo && typeof corpo.type === 'string') {
        registo.info[corpo.type] = (registo.info[corpo.type] ?? 0) + 1;
        const dados = responderInfo(corpo, fase);
        if (dados === undefined) {
          enviar(resposta, 422, 'Failed to deserialize the JSON body into the target type');
        } else if (dados === null) {
          enviar(resposta, 500, null);
        } else {
          enviar(resposta, 200, dados);
        }
      } else if (rota === 'POST /v1/responses' && corpo) {
        if (pedido.headers.authorization !== `Bearer ${CHAVE_OPENAI_FALSA}`) {
          enviar(resposta, 401, { error: { code: 'invalid_api_key' } });
          return;
        }
        registo.openai++;
        const r = responderOpenAi(corpo);
        enviar(resposta, r.estado, r.json);
      } else if (rota === 'POST /__controlo/estado' && corpo) {
        if (corpo.fase !== 'sem-posicao' && corpo.fase !== 'long-aberta') {
          enviar(resposta, 400, { erro: 'fase inválida' });
          return;
        }
        fase = corpo.fase;
        enviar(resposta, 200, { fase });
      } else if (rota === 'GET /__controlo/registo') {
        enviar(resposta, 200, { ...registo, fase });
      } else {
        registo.desconhecidos++;
        enviar(resposta, 404, { erro: `rota desconhecida: ${rota}` });
      }
    })().catch(() => enviar(resposta, 500, { erro: 'falha no servidor falso' }));
  });

  await new Promise<void>((resolver, rejeitar) => {
    servidor.once('error', rejeitar);
    servidor.listen(porta, '127.0.0.1', () => resolver());
  });

  return {
    fechar: () =>
      new Promise<void>((resolver) => {
        servidor.closeAllConnections();
        servidor.close(() => resolver());
      }),
  };
}
