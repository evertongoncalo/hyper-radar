import type { AtivoDetalhe, AtivoResumo, EventoDto } from '@hyper-radar/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { chaves } from '../api/recursos';
import { useToasts } from '../componentes/Toasts';
import { mostrarNotificacaoSistema, textoNotificacao } from '../lib/notificacoes';
import { obterPreferencias } from '../lib/preferencias';
import { tocarAlerta } from '../lib/som';
import { criarLigadorSse, type EstadoLigacao, type ManipuladorSse } from '../lib/sse';

// Estado global da ligação (um único ligador por aplicação).
let estadoAtual: EstadoLigacao = 'desligado';
const ouvintes = new Set<() => void>();
function definirEstado(e: EstadoLigacao) {
  estadoAtual = e;
  for (const o of ouvintes) o();
}
const subscrever = (o: () => void) => {
  ouvintes.add(o);
  return () => {
    ouvintes.delete(o);
  };
};

/** Estado da ligação SSE (para o indicador). */
export function useEstadoLigacao(): EstadoLigacao {
  return useSyncExternalStore(subscrever, () => estadoAtual);
}

/** Máximo de ids de eventos lembrados para não notificar duas vezes (reenvios). */
const MAXIMO_IDS_VISTOS = 1000;

/** Aplica um evento SSE à cache das queries. */
export function aplicarEventoSse(
  qc: QueryClient,
  ...[nome, dados]: Parameters<ManipuladorSse>
): void {
  if (nome === 'evento') {
    const e = dados as EventoDto;
    void qc.invalidateQueries({ queryKey: chaves.eventos });
    void qc.invalidateQueries({ queryKey: chaves.naoLidos });
    void qc.invalidateQueries({ queryKey: chaves.ativos });
    void qc.invalidateQueries({ queryKey: chaves.ativo(e.assetId) });
    void qc.invalidateQueries({ queryKey: chaves.agregados(e.assetId) });
    return;
  }
  const { assetId } = dados as { assetId: number };
  if (nome === 'estado-ativo') {
    const { estado } = dados as { estado: AtivoResumo['estado'] };
    // Atualização imediata do estado; o resto (saúde, contagens) vem com o refetch.
    qc.setQueryData<AtivoResumo[]>(chaves.ativos, (l) =>
      l?.map((a) => (a.id === assetId ? { ...a, estado } : a)),
    );
    qc.setQueryData<AtivoDetalhe>(chaves.ativo(assetId), (a) => (a ? { ...a, estado } : a));
  }
  void qc.invalidateQueries({ queryKey: chaves.ativos });
  void qc.invalidateQueries({ queryKey: chaves.ativo(assetId) });
  void qc.invalidateQueries({ queryKey: chaves.agregados(assetId) });
}

/**
 * Liga ao SSE (uma vez), mantém as queries atualizadas e alerta cada evento novo: notificação
 * do sistema se permitida e ativa; senão toast in-app + som (se ativo).
 */
export function useTempoReal(): void {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const { mostrar } = useToasts();
  const refs = useRef({ navegar, mostrar });

  useEffect(() => {
    refs.current = { navegar, mostrar };
  }, [navegar, mostrar]);

  useEffect(() => {
    const vistos = new Set<number>();
    const alertar = (e: EventoDto) => {
      if (vistos.has(e.id)) return;
      vistos.add(e.id);
      if (vistos.size > MAXIMO_IDS_VISTOS) vistos.delete(vistos.values().next().value!);

      const prefs = obterPreferencias();
      const destino = `/ativos/${e.assetId}`;
      if (prefs.notificacoes && mostrarNotificacaoSistema(e, () => refs.current.navegar(destino))) {
        return;
      }
      const { titulo, corpo } = textoNotificacao(e);
      refs.current.mostrar({ titulo, corpo, ligacao: { para: destino, texto: 'Ver ativo' } });
      if (prefs.som) tocarAlerta();
    };

    const ligador = criarLigadorSse({
      aoEvento: (nome, dados) => {
        aplicarEventoSse(qc, nome, dados);
        if (nome === 'evento') alertar(dados as EventoDto);
      },
      // Depois de uma quebra podem ter-se perdido estados/ciclos: refresca tudo.
      aoReligar: () => void qc.invalidateQueries(),
    });
    const cancelar = ligador.subscrever(definirEstado);
    ligador.ligar();
    definirEstado(ligador.estado());
    return () => {
      cancelar();
      ligador.desligar();
      definirEstado('desligado');
    };
  }, [qc]);
}
