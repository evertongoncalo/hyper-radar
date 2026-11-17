/** Preferências locais do utilizador (só neste browser). */
export interface Preferencias {
  /** Mostrar notificações do sistema (se o browser as permitir). */
  notificacoes: boolean;
  /** Tocar um som curto nos alertas in-app. */
  som: boolean;
}

export const CHAVE_PREFERENCIAS = 'hyperradar.preferencias';
export const PREFERENCIAS_OMISSAO: Preferencias = { notificacoes: true, som: true };

function ler(): Preferencias {
  try {
    const bruto = localStorage.getItem(CHAVE_PREFERENCIAS);
    if (!bruto) return PREFERENCIAS_OMISSAO;
    const p = JSON.parse(bruto) as Partial<Record<keyof Preferencias, unknown>>;
    return {
      notificacoes:
        typeof p.notificacoes === 'boolean' ? p.notificacoes : PREFERENCIAS_OMISSAO.notificacoes,
      som: typeof p.som === 'boolean' ? p.som : PREFERENCIAS_OMISSAO.som,
    };
  } catch {
    // Armazenamento bloqueado (modo privado) ou JSON corrompido: usa as omissões.
    return PREFERENCIAS_OMISSAO;
  }
}

let atuais: Preferencias | null = null;
const ouvintes = new Set<() => void>();

/** Preferências atuais (lidas uma vez do `localStorage`). */
export function obterPreferencias(): Preferencias {
  atuais ??= ler();
  return atuais;
}

export function alterarPreferencias(alteracao: Partial<Preferencias>): void {
  atuais = { ...obterPreferencias(), ...alteracao };
  try {
    localStorage.setItem(CHAVE_PREFERENCIAS, JSON.stringify(atuais));
  } catch {
    // Sem armazenamento: a preferência vale só nesta sessão.
  }
  for (const o of ouvintes) o();
}

export function subscreverPreferencias(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

/** Só para testes: volta a ler do `localStorage`. */
export function reiniciarPreferencias(): void {
  atuais = null;
}
