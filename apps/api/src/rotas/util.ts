import type { ServicoAnalise } from '../analise';

/** Remove as chaves com `undefined` (compatível com `exactOptionalPropertyTypes`). */
export function semIndefinidos<T extends object>(
  objeto: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(objeto).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * Reinicia a análise do ativo se estiver ativa neste processo (secção 2, ponto 6: nova linha de
 * base, sem falsos `OPENED`). Devolve `true` se houve reinício.
 */
export async function reiniciarSeAtiva(
  analise: ServicoAnalise,
  assetId: number,
  motivo: string,
): Promise<boolean> {
  if (!analise.ativosEmAnalise().includes(assetId)) return false;
  return (await analise.reiniciar(assetId, motivo)) !== null;
}
