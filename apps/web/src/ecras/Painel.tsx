import { criarAtivoPedidoSchema } from '@hyper-radar/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { mensagemDeErro } from '../api/cliente';
import { BotaoAnalise } from '../componentes/BotaoAnalise';
import {
  CaixaErro,
  Carregando,
  classeBotaoPrimario,
  classeCampo,
  Etiqueta,
  EtiquetaEstado,
  Seccao,
  Vazio,
} from '../componentes/comuns';
import { useAtivos, useCriarAtivo, useDefinicoes } from '../hooks/consultas';
import { useAgora } from '../hooks/locais';
import { avaliarDesatualizacao } from '../lib/desatualizado';
import { formatarDataHora, formatarRelativo } from '../lib/formatacao';

function FormularioAtivo() {
  const [ticker, setTicker] = useState('');
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const criar = useCriarAtivo();

  const submeter = (e: FormEvent) => {
    e.preventDefault();
    const r = criarAtivoPedidoSchema.safeParse({ ticker });
    if (!r.success) {
      setErroLocal(r.error.issues[0]?.message ?? 'Ticker inválido.');
      return;
    }
    setErroLocal(null);
    criar.mutate(r.data.ticker, { onSuccess: () => setTicker('') });
  };

  // A mensagem da API já inclui a sugestão ("Quis dizer …?") quando existe.
  const erro = erroLocal ?? (criar.isError ? mensagemDeErro(criar.error) : null);

  return (
    <form onSubmit={submeter} className="flex flex-col gap-2" noValidate>
      <label htmlFor="novo-ticker" className="text-sm text-neutral-300">
        Ticker (ex.: <code>BTC</code>, <code>xyz:NVDA</code>)
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="novo-ticker"
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          className={`${classeCampo} w-48`}
          placeholder="BTC"
          autoComplete="off"
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? 'erro-ticker' : undefined}
        />
        <button type="submit" className={classeBotaoPrimario} disabled={criar.isPending}>
          {criar.isPending ? 'A validar…' : 'Adicionar ativo'}
        </button>
      </div>
      {erro && (
        <p id="erro-ticker" role="alert" className="text-sm text-red-300">
          {erro}
        </p>
      )}
    </form>
  );
}

export function Painel() {
  const ativos = useAtivos();
  const definicoes = useDefinicoes();
  const agora = useAgora();
  const intervalo = definicoes.data?.intervaloRecolhaSegundos;

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-semibold">Painel</h2>
      <Seccao titulo="Adicionar ativo" id="titulo-adicionar-ativo">
        <FormularioAtivo />
      </Seccao>
      <Seccao titulo="Ativos" id="titulo-ativos">
        {ativos.isPending ? (
          <Carregando texto="A carregar ativos…" />
        ) : ativos.isError ? (
          <CaixaErro erro={ativos.error} aoRepetir={() => void ativos.refetch()} />
        ) : ativos.data.length === 0 ? (
          <Vazio>Ainda não há ativos. Adicione um acima para começar.</Vazio>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ativos.data.map((a) => {
              const d = avaliarDesatualizacao(a, agora, intervalo);
              const ultimo = a.saude?.ultimoCicloSucesso ?? null;
              return (
                <li
                  key={a.id}
                  className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to={`/ativos/${a.id}`}
                      className="text-lg font-semibold text-sky-400 hover:underline"
                    >
                      {a.ticker}
                    </Link>
                    <EtiquetaEstado estado={a.estado} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-2 text-sm">
                    <dt className="text-neutral-400">Carteiras</dt>
                    <dd>{a.numeroCarteiras}</dd>
                    <dt className="text-neutral-400">Não lidos</dt>
                    <dd>{a.eventosNaoLidos}</dd>
                    <dt className="text-neutral-400">Último ciclo</dt>
                    <dd>
                      {ultimo ? (
                        <time dateTime={ultimo} title={formatarDataHora(ultimo)}>
                          {formatarRelativo(ultimo, agora)}
                        </time>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </dl>
                  {d.desatualizado && (
                    <Etiqueta tom="aviso" titulo={d.motivo ?? undefined}>
                      Dados desatualizados{d.motivo ? `: ${d.motivo}` : ''}
                    </Etiqueta>
                  )}
                  <div>
                    <BotaoAnalise ativo={a} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Seccao>
    </div>
  );
}
