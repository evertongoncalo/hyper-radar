import {
  ErroHttp,
  ErroLimiteTaxa,
  ErroRede,
  ErroRespostaInvalida,
  ErroTempoEsgotado,
} from './erros';
import type { Relogio } from './relogio';

export const URL_BASE_OFICIAL = 'https://api.hyperliquid.xyz';

export interface OpcoesTransporte {
  urlBase: string;
  timeoutMs: number;
  fetch: typeof fetch;
  relogio: Relogio;
}

/** Corpo de um pedido ao endpoint `/info` (só leitura). */
export type CorpoInfo = { type: string } & Record<string, unknown>;

/** Envia um pedido `POST {urlBase}/info` e devolve o JSON, convertendo falhas em erros tipados. */
export async function enviarInfo(opcoes: OpcoesTransporte, corpo: CorpoInfo): Promise<unknown> {
  const controlador = new AbortController();
  const cancelarTemporizador = opcoes.relogio.agendar(() => controlador.abort(), opcoes.timeoutMs);
  try {
    let resposta: Response;
    try {
      resposta = await opcoes.fetch(`${opcoes.urlBase.replace(/\/+$/, '')}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: controlador.signal,
      });
    } catch (erro) {
      if (controlador.signal.aborted) throw new ErroTempoEsgotado(opcoes.timeoutMs);
      throw new ErroRede(erro);
    }

    let texto: string;
    try {
      texto = await resposta.text();
    } catch (erro) {
      if (controlador.signal.aborted) throw new ErroTempoEsgotado(opcoes.timeoutMs);
      throw new ErroRede(erro);
    }

    if (resposta.status === 429) {
      throw new ErroLimiteTaxa(lerRetryAfter(resposta.headers.get('retry-after')));
    }
    if (resposta.status >= 500) {
      // Observado na API real: DEX inexistente (ou `dex: "ALL_DEXES"`) devolve 500 com corpo `null`.
      // É um erro do pedido, não do servidor, por isso não se repete.
      if (texto.trim() === 'null') {
        throw new ErroHttp(
          resposta.status,
          `A Hyperliquid rejeitou o pedido "${corpo.type}" (HTTP ${resposta.status}); verifique o parâmetro dex.`,
          false,
        );
      }
      throw new ErroHttp(
        resposta.status,
        `Erro do servidor da Hyperliquid (HTTP ${resposta.status}).`,
        true,
      );
    }
    if (!resposta.ok) {
      throw new ErroHttp(
        resposta.status,
        `Pedido "${corpo.type}" rejeitado pela Hyperliquid (HTTP ${resposta.status}): ${texto.slice(0, 200)}`,
        false,
      );
    }

    try {
      return JSON.parse(texto) as unknown;
    } catch (erro) {
      throw new ErroRespostaInvalida('o corpo não é JSON válido.', { cause: erro });
    }
  } finally {
    cancelarTemporizador();
  }
}

/** Converte o cabeçalho `Retry-After` (segundos) em ms; ignora valores inválidos. */
function lerRetryAfter(valor: string | null): number | null {
  if (valor === null) return null;
  const segundos = Number(valor);
  return Number.isFinite(segundos) && segundos >= 0 ? segundos * 1000 : null;
}
