import type { AtivoResumo } from '@hyper-radar/shared';
import { mensagemDeErro } from '../api/cliente';
import { useAlternarAnalise } from '../hooks/consultas';
import { classeBotaoPrimario, classeBotaoSecundario } from './comuns';

/** Botão "Iniciar análise" / "Parar análise" de um ativo, com erro da API inline. */
export function BotaoAnalise({ ativo }: { ativo: Pick<AtivoResumo, 'id' | 'ticker' | 'estado'> }) {
  const mutacao = useAlternarAnalise();
  const emCurso = ativo.estado === 'running' || ativo.estado === 'restarting';
  const acao = emCurso ? 'parar' : 'iniciar';
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={mutacao.isPending}
        onClick={() => mutacao.mutate({ id: ativo.id, acao })}
        className={emCurso ? classeBotaoSecundario : classeBotaoPrimario}
        aria-label={`${emCurso ? 'Parar' : 'Iniciar'} análise de ${ativo.ticker}`}
      >
        {emCurso ? 'Parar análise' : 'Iniciar análise'}
      </button>
      {mutacao.isError && (
        <span role="alert" className="text-xs text-red-300">
          {mensagemDeErro(mutacao.error)}
        </span>
      )}
    </span>
  );
}
