import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';

export interface Toast {
  id: number;
  titulo: string;
  corpo?: string;
  /** Ligação opcional (ex.: detalhe do ativo). */
  ligacao?: { para: string; texto: string };
  tom?: 'info' | 'erro' | 'sucesso';
}

type NovoToast = Omit<Toast, 'id'>;

interface ContextoToasts {
  mostrar(toast: NovoToast): void;
}

const Contexto = createContext<ContextoToasts | null>(null);

/** Duração de cada toast no ecrã (ms). */
export const DURACAO_TOAST_MS = 8000;
const MAXIMO_TOASTS = 5;

const CORES: Record<NonNullable<Toast['tom']>, string> = {
  info: 'border-sky-700',
  erro: 'border-red-700',
  sucesso: 'border-emerald-700',
};

export function ProvedorToasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const proximo = useRef(1);

  const fechar = useCallback((id: number) => {
    setToasts((lista) => lista.filter((t) => t.id !== id));
  }, []);

  const mostrar = useCallback(
    (toast: NovoToast) => {
      const id = proximo.current++;
      setToasts((lista) => [...lista, { ...toast, id }].slice(-MAXIMO_TOASTS));
      setTimeout(() => fechar(id), DURACAO_TOAST_MS);
    },
    [fechar],
  );

  const valor = useMemo(() => ({ mostrar }), [mostrar]);

  return (
    <Contexto.Provider value={valor}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed right-4 bottom-16 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-md border-l-4 bg-neutral-900 p-3 shadow-lg ring-1 ring-neutral-800 ${CORES[t.tom ?? 'info']}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium text-neutral-100">{t.titulo}</p>
              <button
                type="button"
                onClick={() => fechar(t.id)}
                className="rounded px-1 text-neutral-400 hover:text-neutral-100"
                aria-label="Fechar aviso"
              >
                ×
              </button>
            </div>
            {t.corpo && <p className="mt-1 text-sm text-neutral-300">{t.corpo}</p>}
            {t.ligacao && (
              <Link
                to={t.ligacao.para}
                onClick={() => fechar(t.id)}
                className="mt-2 inline-block text-sm text-sky-400 underline hover:text-sky-300"
              >
                {t.ligacao.texto}
              </Link>
            )}
          </div>
        ))}
      </div>
    </Contexto.Provider>
  );
}

export function useToasts(): ContextoToasts {
  const c = useContext(Contexto);
  if (!c) throw new Error('useToasts tem de ser usado dentro de <ProvedorToasts>.');
  return c;
}
