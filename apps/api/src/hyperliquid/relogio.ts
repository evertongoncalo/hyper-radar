/** Relógio e temporizadores injetáveis (permite testes determinísticos). */
export interface Relogio {
  agora(): number;
  /** Agenda `fn` para daqui a `ms`; devolve uma função que cancela o agendamento. */
  agendar(fn: () => void, ms: number): () => void;
}

export const relogioSistema: Relogio = {
  agora: () => Date.now(),
  agendar: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

export function esperar(relogio: Relogio, ms: number): Promise<void> {
  return new Promise((resolver) => {
    relogio.agendar(resolver, ms);
  });
}
