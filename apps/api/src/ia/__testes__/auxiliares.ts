import { AVISO_IA_NAO_ACONSELHAMENTO, type RelatorioIa } from '@hyper-radar/shared';
import type { FuncaoFetch, GeradorIa, PedidoGeracao, RespostaGeracao } from '../cliente-openai';

/** Relatório válido segundo o schema. */
export function relatorioValido(extra: Partial<RelatorioIa> = {}): RelatorioIa {
  return {
    resumo: 'As carteiras seguidas poderão estar maioritariamente long.',
    vies: 'alta',
    confianca: 0.6,
    alinhamento_baleias: { nivel: 'moderado', descricao: 'Duas de três carteiras long.' },
    riscos: ['Hedge possível noutra plataforma.'],
    niveis_chave: [{ preco: 95, descricao: 'Zona de liquidação de longs.' }],
    cenarios: [
      { nome: 'Continuação', probabilidade: 0.55, descricao: 'Poderá subir.', gatilho: '> 105' },
    ],
    cenario_entrada_sugerido: {
      lado: 'long',
      entrada: 100,
      stop_loss: 95,
      take_profit: 110,
      justificacao: 'Hipotético, caso o suporte se mantenha.',
    },
    avisos: [AVISO_IA_NAO_ACONSELHAMENTO],
    ...extra,
  };
}

/** Corpo de resposta da Responses API com o texto dado como `output_text`. */
export function corpoResposta(
  texto: string,
  extra: { status?: string; uso?: [number, number]; recusa?: string; model?: string } = {},
) {
  const [entrada, saida] = extra.uso ?? [1_000, 500];
  return {
    id: 'resp_teste',
    object: 'response',
    status: extra.status ?? 'completed',
    model: extra.model ?? 'gpt-6.1-sol-2026-10-01',
    incomplete_details: extra.status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: extra.recusa
          ? [{ type: 'refusal', refusal: extra.recusa }]
          : [{ type: 'output_text', text: texto, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: entrada,
      output_tokens: saida,
      total_tokens: entrada + saida,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 100 },
    },
  };
}

export const json = (corpo: unknown, estado = 200, cabecalhos: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), {
    status: estado,
    headers: { 'content-type': 'application/json', ...cabecalhos },
  });

/** `fetch` falso com respostas em fila (a última repete-se); regista os pedidos. */
export function fetchFalso(...respostas: (Response | Error | (() => Promise<Response>))[]) {
  const pedidos: { url: string; init: RequestInit }[] = [];
  const fn: FuncaoFetch = async (url, init) => {
    pedidos.push({ url, init });
    const r = respostas.length > 1 ? respostas.shift()! : respostas[0]!;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r.clone();
  };
  return { fn, pedidos };
}

/** Gerador falso (sem rede): devolve o relatório programado e conta as chamadas. */
export class GeradorFalso implements GeradorIa {
  configurado = true;
  readonly pedidos: PedidoGeracao[] = [];
  resposta: () => Promise<RespostaGeracao> = async () => ({
    dados: relatorioValido(),
    modelo: 'gpt-6.1-sol-2026-10-01',
    tokensEntrada: 1_000,
    tokensSaida: 500,
  });

  async gerar(pedido: PedidoGeracao): Promise<RespostaGeracao> {
    this.pedidos.push(pedido);
    return this.resposta();
  }
}
