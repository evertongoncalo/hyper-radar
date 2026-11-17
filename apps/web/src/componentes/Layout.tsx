import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useContagemNaoLidos } from '../hooks/consultas';
import { useEstadoLigacao } from '../hooks/tempoReal';
import { ESTADOS_LIGACAO_PT, type EstadoLigacao } from '../lib/sse';

export const AVISO_LEGAL =
  'Informação para apoio à decisão. Não constitui aconselhamento financeiro.';

const LIGACOES = [
  { para: '/', texto: 'Painel' },
  { para: '/carteiras', texto: 'Carteiras' },
  { para: '/eventos', texto: 'Eventos' },
  { para: '/definicoes', texto: 'Definições' },
] as const;

const COR_LIGACAO: Record<EstadoLigacao, string> = {
  'a-ligar': 'bg-amber-400',
  ligado: 'bg-emerald-400',
  'a-reconectar': 'bg-amber-400',
  desligado: 'bg-red-500',
};

export function IndicadorLigacao() {
  const estado = useEstadoLigacao();
  return (
    <p
      className="flex items-center gap-2 text-xs text-neutral-300"
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${COR_LIGACAO[estado]}`} />
      <span>Tempo real: {ESTADOS_LIGACAO_PT[estado]}</span>
    </p>
  );
}

function Navegacao() {
  const { data } = useContagemNaoLidos();
  return (
    <nav aria-label="Navegação principal">
      <ul className="flex gap-1 overflow-x-auto md:flex-col">
        {LIGACOES.map((l) => (
          <li key={l.para}>
            <NavLink
              to={l.para}
              end={l.para === '/'}
              className={({ isActive }) =>
                `flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-sky-400 ${
                  isActive
                    ? 'bg-neutral-800 font-medium text-white'
                    : 'text-neutral-300 hover:bg-neutral-900'
                }`
              }
            >
              {l.texto}
              {l.para === '/eventos' && data && data.total > 0 && (
                <span className="rounded-full bg-sky-700 px-1.5 text-xs text-white">
                  {data.total}
                  <span className="sr-only"> não lidos</span>
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Estrutura geral: navegação lateral (superior no telemóvel) e aviso legal fixo. */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col pb-12 md:flex-row">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-sky-700 focus:px-3 focus:py-2"
      >
        Saltar para o conteúdo
      </a>
      <header className="flex flex-col gap-3 border-b border-neutral-800 px-4 py-3 md:sticky md:top-0 md:h-[calc(100vh-3rem)] md:w-56 md:shrink-0 md:border-r md:border-b-0 md:py-6">
        <div className="flex items-center justify-between md:flex-col md:items-start md:gap-3">
          <h1 className="text-xl font-semibold tracking-tight">HyperRadar</h1>
          <IndicadorLigacao />
        </div>
        <Navegacao />
        <p className="hidden text-xs text-neutral-500 md:mt-auto md:block">
          Sem esta aba aberta não há notificações.
        </p>
      </header>
      <main id="conteudo" className="min-w-0 flex-1 px-4 py-6 md:px-8">
        {children}
      </main>
      <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-800 bg-neutral-950/95 px-4 py-2 text-center text-xs text-neutral-300 sm:text-sm">
        <p role="note">{AVISO_LEGAL}</p>
      </footer>
    </div>
  );
}
