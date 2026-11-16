import { readFileSync } from 'node:fs';
import type { Relogio } from '../relogio';
import type { CorpoInfo } from '../transporte';

/** Endereços fictícios usados nas fixtures (anonimizadas). */
export const CARTEIRA_COM_POSICAO = '0x' + '1'.repeat(40);
export const CARTEIRA_HIP3 = '0x' + '2'.repeat(40);
export const CARTEIRA_VAZIA = '0x' + '3'.repeat(40);

export function carregarFixture(nome: string): unknown {
  return JSON.parse(readFileSync(new URL(`../__fixtures__/${nome}.json`, import.meta.url), 'utf8'));
}

/** Relógio manual: o tempo só avança com `avancar`, executando os temporizadores por ordem. */
export class RelogioFalso implements Relogio {
  private atual = 0;
  private sequencia = 0;
  private tarefas: { em: number; id: number; fn: () => void }[] = [];

  agora(): number {
    return this.atual;
  }

  agendar(fn: () => void, ms: number): () => void {
    const tarefa = { em: this.atual + Math.max(0, ms), id: this.sequencia++, fn };
    this.tarefas.push(tarefa);
    return () => {
      this.tarefas = this.tarefas.filter((t) => t !== tarefa);
    };
  }

  get pendentes(): number {
    return this.tarefas.length;
  }

  async avancar(ms: number): Promise<void> {
    const alvo = this.atual + ms;
    for (;;) {
      await descarregar();
      const proxima = this.tarefas
        .filter((t) => t.em <= alvo)
        .sort((a, b) => a.em - b.em || a.id - b.id)[0];
      if (!proxima) break;
      this.tarefas = this.tarefas.filter((t) => t !== proxima);
      this.atual = proxima.em;
      proxima.fn();
    }
    this.atual = alvo;
    await descarregar();
  }
}

/** Deixa correr todas as microtarefas pendentes. */
export const descarregar = () => new Promise<void>((resolver) => setImmediate(resolver));

/** `corpo` é serializado em JSON; `texto` é enviado tal como está. */
export type RespostaFalsa =
  | ({ estado?: number; cabecalhos?: Record<string, string> } & (
      { corpo: unknown } | { texto: string }
    ))
  | Error
  | 'pendurar';

/** `fetch` falso que regista os corpos enviados e responde com `responder`. */
export function criarFetchFalso(
  responder: (corpo: CorpoInfo, chamada: number) => RespostaFalsa | Promise<RespostaFalsa>,
) {
  const chamadas: CorpoInfo[] = [];
  const urls: string[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(String(url));
    const corpo = JSON.parse(String(init?.body)) as CorpoInfo;
    chamadas.push(corpo);
    const r = await responder(corpo, chamadas.length);
    if (r instanceof Error) throw r;
    if (r === 'pendurar') {
      return new Promise<Response>((_, rejeitar) => {
        init?.signal?.addEventListener('abort', () =>
          rejeitar(new DOMException('Pedido abortado', 'AbortError')),
        );
      });
    }
    const texto = 'texto' in r ? r.texto : JSON.stringify(r.corpo);
    return new Response(texto, { status: r.estado ?? 200, headers: r.cabecalhos ?? {} });
  };
  return { fetch: fn as typeof fetch, chamadas, urls };
}

/** Escolhe a fixture adequada a cada pedido (carteiras e DEX das fixtures gravadas). */
export function responderComFixtures(corpo: CorpoInfo): RespostaFalsa {
  const sufixoDex = typeof corpo.dex === 'string' ? corpo.dex : 'nativo';
  const user = corpo.user;
  switch (corpo.type) {
    case 'meta':
    case 'metaAndAssetCtxs':
    case 'allMids':
      return { corpo: carregarFixture(`${corpo.type}-${sufixoDex}`) };
    case 'clearinghouseState':
      if (user === CARTEIRA_COM_POSICAO && !corpo.dex) {
        return { corpo: carregarFixture('clearinghouseState-com-posicao') };
      }
      if (user === CARTEIRA_HIP3 && corpo.dex === 'xyz') {
        return { corpo: carregarFixture('clearinghouseState-xyz') };
      }
      return { corpo: carregarFixture('clearinghouseState-sem-posicoes') };
    case 'frontendOpenOrders':
      if (user === CARTEIRA_COM_POSICAO && !corpo.dex) {
        return { corpo: carregarFixture('frontendOpenOrders-com-triggers') };
      }
      if (user === CARTEIRA_HIP3 && corpo.dex === 'xyz') {
        return { corpo: carregarFixture('frontendOpenOrders-xyz') };
      }
      return { corpo: carregarFixture('frontendOpenOrders-vazio') };
    default:
      return { corpo: carregarFixture(corpo.type) };
  }
}
