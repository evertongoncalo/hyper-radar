import type { Relogio } from './relogio';

/** Cache curta em memória com deduplicação de pedidos idênticos em curso. */
export class CacheCurta {
  private readonly valores = new Map<string, { expiraEm: number; valor: unknown }>();
  private readonly emCurso = new Map<string, Promise<unknown>>();

  constructor(private readonly relogio: Relogio) {}

  /**
   * Devolve o valor em cache para `chave`, a promessa já em curso, ou executa `produzir`.
   * Com `ttlMs <= 0` não guarda o resultado, mas continua a deduplicar pedidos em curso.
   */
  obter<T>(chave: string, ttlMs: number, produzir: () => Promise<T>): Promise<T> {
    const guardado = this.valores.get(chave);
    if (guardado) {
      if (guardado.expiraEm > this.relogio.agora()) return Promise.resolve(guardado.valor as T);
      this.valores.delete(chave);
    }
    const pendente = this.emCurso.get(chave);
    if (pendente) return pendente as Promise<T>;

    const promessa = produzir()
      .then((valor) => {
        if (ttlMs > 0) this.valores.set(chave, { expiraEm: this.relogio.agora() + ttlMs, valor });
        return valor;
      })
      .finally(() => this.emCurso.delete(chave));
    this.emCurso.set(chave, promessa);
    return promessa;
  }

  limpar(): void {
    this.valores.clear();
  }
}
