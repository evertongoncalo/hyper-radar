import type { EstadoAtivoDto } from '@hyper-radar/shared';
import { useState, type ReactNode } from 'react';
import { mensagemDeErro } from '../api/cliente';
import { abreviarEndereco, ESTADOS_ATIVO_PT } from '../lib/formatacao';

/** Classes base dos botões (foco visível, estado desativado). */
export const classeBotao =
  'inline-flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50';
export const classeBotaoPrimario = `${classeBotao} bg-sky-600 text-white hover:bg-sky-500`;
export const classeBotaoSecundario = `${classeBotao} bg-neutral-800 text-neutral-100 hover:bg-neutral-700`;
export const classeBotaoPerigo = `${classeBotao} bg-red-800 text-white hover:bg-red-700`;
export const classeCampo =
  'rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-sky-400';

export function Carregando({ texto = 'A carregar…' }: { texto?: string }) {
  return (
    <p role="status" className="py-4 text-sm text-neutral-400">
      {texto}
    </p>
  );
}

export function CaixaErro({ erro, aoRepetir }: { erro: unknown; aoRepetir?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-800 bg-red-950/50 p-3 text-sm text-red-200"
    >
      <p>{mensagemDeErro(erro)}</p>
      {aoRepetir && (
        <button type="button" onClick={aoRepetir} className={`${classeBotaoSecundario} mt-2`}>
          Tentar novamente
        </button>
      )}
    </div>
  );
}

export function Vazio({ children }: { children: ReactNode }) {
  return <p className="py-4 text-sm text-neutral-400">{children}</p>;
}

export function Seccao({
  titulo,
  children,
  acoes,
  id,
}: {
  titulo: string;
  children: ReactNode;
  acoes?: ReactNode;
  id?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold">
          {titulo}
        </h2>
        {acoes}
      </div>
      {children}
    </section>
  );
}

const CORES_ESTADO: Record<EstadoAtivoDto, string> = {
  idle: 'bg-neutral-800 text-neutral-200',
  running: 'bg-emerald-900 text-emerald-200',
  stopped: 'bg-amber-900 text-amber-100',
  restarting: 'bg-sky-900 text-sky-100',
};

export function EtiquetaEstado({ estado }: { estado: EstadoAtivoDto }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${CORES_ESTADO[estado]}`}
    >
      <span aria-hidden="true">●</span>
      {ESTADOS_ATIVO_PT[estado]}
    </span>
  );
}

export function Etiqueta({
  children,
  tom = 'neutro',
  titulo,
}: {
  children: ReactNode;
  tom?: 'neutro' | 'aviso' | 'perigo' | 'long' | 'short';
  titulo?: string | undefined;
}) {
  const cores = {
    neutro: 'bg-neutral-800 text-neutral-200',
    aviso: 'bg-amber-900 text-amber-100',
    perigo: 'bg-red-900 text-red-100',
    long: 'bg-emerald-900 text-emerald-200',
    short: 'bg-red-900 text-red-100',
  }[tom];
  return (
    <span
      title={titulo}
      className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${cores}`}
    >
      {children}
    </span>
  );
}

/** Endereço abreviado com o completo no `title` e botão de cópia. */
export function Endereco({ endereco }: { endereco: string }) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(endereco);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      setCopiado(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      <span title={endereco}>{abreviarEndereco(endereco)}</span>
      <button
        type="button"
        onClick={() => void copiar()}
        aria-label={`Copiar endereço ${endereco}`}
        className="rounded p-0.5 text-neutral-400 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        {copiado ? (
          <span className="text-emerald-400">Copiado</span>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
            <path d="M4 2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2Zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6ZM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2Z" />
          </svg>
        )}
      </button>
    </span>
  );
}
