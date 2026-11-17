/** EventSource falso para testes (sem rede). */

export class EventSourceFalso {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instancias: EventSourceFalso[] = [];

  readyState = EventSourceFalso.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private ouvintes = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    EventSourceFalso.instancias.push(this);
  }

  addEventListener(nome: string, f: (e: MessageEvent) => void) {
    this.ouvintes.set(nome, [...(this.ouvintes.get(nome) ?? []), f]);
  }

  close() {
    this.readyState = EventSourceFalso.CLOSED;
  }

  // Ajudas de teste
  abrir() {
    this.readyState = EventSourceFalso.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitir(nome: string, dados: unknown, id?: string) {
    const e = new MessageEvent(nome, {
      data: typeof dados === 'string' ? dados : JSON.stringify(dados),
      lastEventId: id ?? '',
    });
    for (const f of this.ouvintes.get(nome) ?? []) f(e);
  }

  falhar(fechar = false) {
    this.readyState = fechar ? EventSourceFalso.CLOSED : EventSourceFalso.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  static ultima(): EventSourceFalso {
    const u = EventSourceFalso.instancias.at(-1);
    if (!u) throw new Error('Nenhum EventSource criado.');
    return u;
  }
}
