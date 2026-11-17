import type { EventoDto } from '@hyper-radar/shared';
import { Link } from 'react-router';
import { mensagemDeErro } from '../api/cliente';
import { useMarcarEventoLido } from '../hooks/consultas';
import { formatarDataHora, nomeCarteira, TIPOS_EVENTO_PT } from '../lib/formatacao';
import { resumoEvento } from '../lib/notificacoes';
import { classeBotaoSecundario, Endereco, Etiqueta } from './comuns';

const TOM_TIPO: Record<EventoDto['tipo'], 'neutro' | 'aviso' | 'perigo' | 'long' | 'short'> = {
  OPENED: 'long',
  CLOSED: 'neutro',
  INCREASED: 'long',
  REDUCED: 'aviso',
  FLIPPED: 'aviso',
  SLTP_CHANGED: 'neutro',
  LIQ_NEAR: 'perigo',
};

/** Lista de eventos com marcação como lido. */
export function ListaEventos({
  eventos,
  mostrarAtivo = true,
}: {
  eventos: EventoDto[];
  mostrarAtivo?: boolean;
}) {
  const marcar = useMarcarEventoLido();
  return (
    <>
      {marcar.isError && (
        <p role="alert" className="mb-2 text-sm text-red-300">
          {mensagemDeErro(marcar.error)}
        </p>
      )}
      <ul className="divide-y divide-neutral-800">
        {eventos.map((e) => (
          <li
            key={e.id}
            className={`flex flex-wrap items-start justify-between gap-2 py-2 ${e.lido ? 'opacity-70' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {!e.lido && (
                  <span
                    className="h-2 w-2 rounded-full bg-sky-400"
                    aria-label="Não lido"
                    role="img"
                  />
                )}
                <Etiqueta tom={TOM_TIPO[e.tipo]}>{TIPOS_EVENTO_PT[e.tipo]}</Etiqueta>
                {mostrarAtivo && (
                  <Link
                    to={`/ativos/${e.assetId}`}
                    className="font-medium text-sky-400 hover:underline"
                  >
                    {e.ticker}
                  </Link>
                )}
                <span className="text-sm">{nomeCarteira(e)}</span>
                <Endereco endereco={e.endereco} />
              </div>
              <p className="mt-0.5 text-sm text-neutral-300">{resumoEvento(e)}</p>
              <p className="text-xs text-neutral-500">
                <time dateTime={e.criadoEm}>{formatarDataHora(e.criadoEm)}</time>
              </p>
            </div>
            {!e.lido && (
              <button
                type="button"
                className={classeBotaoSecundario}
                disabled={marcar.isPending}
                onClick={() => marcar.mutate({ id: e.id, assetId: e.assetId })}
                aria-label={`Marcar como lido: ${TIPOS_EVENTO_PT[e.tipo]} de ${nomeCarteira(e)} em ${e.ticker}`}
              >
                Marcar como lido
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
