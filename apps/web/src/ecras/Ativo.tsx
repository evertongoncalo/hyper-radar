import { useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router';
import { mensagemDeErro } from '../api/cliente';
import { Agregados } from '../componentes/Agregados';
import { PainelAnaliseIa } from '../componentes/AnaliseIa';
import { BotaoAnalise } from '../componentes/BotaoAnalise';
import {
  CaixaErro,
  Carregando,
  classeBotaoSecundario,
  Etiqueta,
  EtiquetaEstado,
  Seccao,
  Vazio,
} from '../componentes/comuns';
import { ListaEventos } from '../componentes/FeedEventos';
import { ID_PAINEL_SUGESTAO, PainelSugestao } from '../componentes/SugestaoProporcional';
import { TabelaCarteiras } from '../componentes/TabelaCarteiras';
import {
  useAgregados,
  useAtivo,
  useCalcularSugestao,
  useDefinicoes,
  useEventos,
  useMarcarEventosDoAtivoLidos,
} from '../hooks/consultas';
import { useAgora } from '../hooks/locais';
import { avaliarDesatualizacao } from '../lib/desatualizado';
import { formatarDataHora, formatarPreco } from '../lib/formatacao';

function Feed({ ativoId, naoLidos }: { ativoId: number; naoLidos: number }) {
  const filtros = useMemo(() => ({ ativo: ativoId, limite: 20 }), [ativoId]);
  const eventos = useEventos(filtros);
  const marcarTodos = useMarcarEventosDoAtivoLidos(ativoId);
  const itens = eventos.data?.pages.flatMap((p) => p.itens) ?? [];
  return (
    <Seccao
      titulo="Eventos em tempo real"
      id="titulo-feed"
      acoes={
        naoLidos > 0 && (
          <button
            type="button"
            className={classeBotaoSecundario}
            onClick={() => marcarTodos.mutate()}
            disabled={marcarTodos.isPending}
          >
            Marcar todos como lidos ({naoLidos})
          </button>
        )
      }
    >
      {marcarTodos.isError && (
        <p role="alert" className="mb-2 text-sm text-red-300">
          {mensagemDeErro(marcarTodos.error)}
        </p>
      )}
      {eventos.isPending ? (
        <Carregando texto="A carregar eventos…" />
      ) : eventos.isError ? (
        <CaixaErro erro={eventos.error} aoRepetir={() => void eventos.refetch()} />
      ) : itens.length === 0 ? (
        <Vazio>Ainda não há eventos para este ativo.</Vazio>
      ) : (
        <>
          <ListaEventos eventos={itens} mostrarAtivo={false} />
          {eventos.hasNextPage && (
            <button
              type="button"
              className={`${classeBotaoSecundario} mt-2`}
              onClick={() => void eventos.fetchNextPage()}
              disabled={eventos.isFetchingNextPage}
            >
              Carregar mais
            </button>
          )}
        </>
      )}
    </Seccao>
  );
}

function SeccaoAgregados({ ativoId }: { ativoId: number }) {
  const agregados = useAgregados(ativoId);
  return (
    <Seccao titulo="Agregados" id="titulo-agregados">
      {agregados.isPending ? (
        <Carregando texto="A calcular agregados…" />
      ) : agregados.isError ? (
        <CaixaErro erro={agregados.error} aoRepetir={() => void agregados.refetch()} />
      ) : (
        <Agregados dados={agregados.data} />
      )}
    </Seccao>
  );
}

export function Ativo() {
  const { id: param } = useParams();
  const id = Number(param);
  const valido = Number.isInteger(id) && id > 0;
  if (!valido) {
    return (
      <div className="flex flex-col gap-3">
        <CaixaErro erro={new Error('Identificador de ativo inválido.')} />
        <Link to="/" className="text-sky-400 underline">
          Voltar ao painel
        </Link>
      </div>
    );
  }
  return <DetalheAtivo id={id} />;
}

function DetalheAtivo({ id }: { id: number }) {
  const ativo = useAtivo(id);
  const definicoes = useDefinicoes();
  const agora = useAgora();
  const sugestao = useCalcularSugestao(id);
  const refSugestao = useRef<HTMLDivElement>(null);
  const calcularSugestao = (carteira?: number) => sugestao.mutate(carteira);
  /** Botão "Sugestão" de uma linha: calcula só essa carteira e leva o utilizador ao painel. */
  const irParaSugestao = () => {
    const painel = refSugestao.current;
    painel?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    painel?.focus({ preventScroll: true });
  };
  const sugestaoDaCarteira = (carteira: number) => {
    calcularSugestao(carteira);
    irParaSugestao();
  };

  if (ativo.isPending) return <Carregando texto="A carregar ativo…" />;
  if (ativo.isError) {
    return (
      <div className="flex flex-col gap-3">
        <CaixaErro erro={ativo.error} aoRepetir={() => void ativo.refetch()} />
        <Link to="/" className="text-sky-400 underline">
          Voltar ao painel
        </Link>
      </div>
    );
  }
  const a = ativo.data;
  const d = avaliarDesatualizacao(a, agora, definicoes.data?.intervaloRecolhaSegundos);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold">{a.ticker}</h2>
            <EtiquetaEstado estado={a.estado} />
            {a.dex && <Etiqueta>DEX {a.dex}</Etiqueta>}
          </div>
          <p className="text-sm text-neutral-300">
            Preço:{' '}
            <span className="font-semibold tabular-nums">
              {formatarPreco(a.precoMercado?.valor)}
            </span>
            {a.precoMercado && (
              <span className="text-neutral-500">
                {' '}
                ({a.precoMercado.fonte === 'snapshot' ? 'último gravado, ' : ''}
                <time dateTime={a.precoMercado.instante}>
                  {formatarDataHora(a.precoMercado.instante)}
                </time>
                )
              </span>
            )}
          </p>
          {d.desatualizado && <Etiqueta tom="aviso">Dados desatualizados: {d.motivo}</Etiqueta>}
        </div>
        <BotaoAnalise ativo={a} />
      </header>

      <Seccao titulo="Carteiras" id="titulo-carteiras-ativo">
        <TabelaCarteiras
          ativoId={a.id}
          ticker={a.ticker}
          carteiras={a.carteiras}
          precoAtivo={a.precoMercado?.valor ?? null}
          aoPedirSugestao={sugestaoDaCarteira}
        />
      </Seccao>

      <SeccaoAgregados ativoId={a.id} />

      <div id={ID_PAINEL_SUGESTAO} ref={refSugestao} tabIndex={-1} className="outline-none">
        <Seccao titulo="Sugestão proporcional" id="titulo-sugestao-proporcional">
          <PainelSugestao calculo={sugestao} aoCalcular={calcularSugestao} />
        </Seccao>
      </div>

      <Seccao titulo="Análise IA" id="titulo-analise-ia">
        <PainelAnaliseIa
          ativoId={a.id}
          precoAtual={a.precoMercado?.valor ?? null}
          aoComparar={irParaSugestao}
        />
      </Seccao>

      <Feed ativoId={a.id} naoLidos={a.eventosNaoLidos} />
    </div>
  );
}
