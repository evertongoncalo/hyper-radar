import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  pedirPermissaoNotificacoes,
  permissaoNotificacoes,
  type EstadoPermissao,
} from '../lib/notificacoes';
import {
  alterarPreferencias,
  obterPreferencias,
  subscreverPreferencias,
  type Preferencias,
} from '../lib/preferencias';

/** Preferências locais (som/notificações), partilhadas por toda a app. */
export function usePreferencias(): [Preferencias, (p: Partial<Preferencias>) => void] {
  const prefs = useSyncExternalStore(subscreverPreferencias, obterPreferencias);
  return [prefs, alterarPreferencias];
}

/** Permissão de notificações e ação para a pedir (por clique do utilizador). */
export function usePermissaoNotificacoes(): [EstadoPermissao, () => Promise<void>] {
  const [estado, setEstado] = useState<EstadoPermissao>(permissaoNotificacoes);
  const pedir = useCallback(async () => {
    setEstado(await pedirPermissaoNotificacoes());
  }, []);
  return [estado, pedir];
}

/** Instante atual, atualizado periodicamente (para indicadores relativos ao tempo). */
export function useAgora(intervaloMs = 15_000): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);
  return agora;
}
