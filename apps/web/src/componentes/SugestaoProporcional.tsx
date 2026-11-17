import type {
  AvisoSugestaoDto,
  NivelAviso,
  NivelProtecaoDto,
  RespostaSugestao,
  SugestaoCarteiraDto,
} from '@hyper-radar/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ErroApi } from '../api/cliente';
import type { CalculoSugestao } from '../hooks/consultas';
import {
  formatarDataHora,
  formatarNumero,
  formatarPct,
  formatarPreco,
  formatarUsd,
  LADO_PT,
  nomeCarteira,
} from '../lib/formatacao';
import {
  agruparAvisos,
  formatarPctComSinal,
  formatarRR,
  NIVEIS_PT,
  origemLimiteAlavancagem,
  textoParaCopiar,
} from '../lib/sugestao';
import {
  CaixaErro,
  Carregando,
  classeBotaoPrimario,
  classeBotaoSecundario,
  Endereco,
  Etiqueta,
  Vazio,
} from './comuns';

export const ID_PAINEL_SUGESTAO = 'painel-sugestao';

const ESTILO_NIVEL: Record<NivelAviso, string> = {
  critico: 'border-red-700 bg-red-950/60 text-red-100',
  atencao: 'border-amber-700 bg-amber-950/50 text-amber-100',
  info: 'border-sky-800 bg-sky-950/40 text-sky-100',
};

function IconeNivel({ nivel }: { nivel: NivelAviso }) {
  const comum = { 'aria-hidden': true, viewBox: '0 0 16 16', className: 'mt-0.5 h-4 w-4 shrink-0' };
  if (nivel === 'info') {
    return (
      <svg {...comum} fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm-1 3.5h2V12H7V7.5Z" />
      </svg>
    );
  }
  if (nivel === 'atencao') {
    return (
      <svg {...comum} fill="currentColor">
        <path d="M8 1.5 15 14H1L8 1.5Zm-.9 4.5v4h1.8V6H7.1Zm0 5v1.6h1.8V11H7.1Z" />
      </svg>
    );
  }
  return (
    <svg {...comum} fill="currentColor">
      <path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1L5.1 1Zm1.6 3.5L5.5 5.7 6.8 7l-1.3 1.3 1.2 1.2L8 8.2l1.3 1.3 1.2-1.2L9.2 7l1.3-1.3-1.2-1.2L8 5.8 6.7 4.5Z" />
    </svg>
  );
}

/** Avisos por nível (crítico → atenção → informação), com cor e ícone. */
export function ListaAvisos({ avisos }: { avisos: readonly AvisoSugestaoDto[] }) {
  const grupos = agruparAvisos(avisos);
  if (grupos.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">Avisos</h4>
      {grupos.map((g) => (
        <div key={g.nivel}>
          <h5 className="sr-only">{NIVEIS_PT[g.nivel]}</h5>
          <ul className="flex flex-col gap-1">
            {g.avisos.map((a, i) => (
              <li
                key={`${a.codigo}-${i}`}
                data-nivel={g.nivel}
                className={`flex gap-2 rounded-md border px-2 py-1.5 text-sm ${ESTILO_NIVEL[g.nivel]}`}
              >
                <IconeNivel nivel={g.nivel} />
                <span>
                  <span className="font-semibold">{NIVEIS_PT[g.nivel]}:</span> {a.mensagem}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Campo({ nome, children }: { nome: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-neutral-400">{nome}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

function Protecao({ tipo, nivel }: { tipo: 'SL' | 'TP'; nivel: NivelProtecaoDto | null }) {
  if (!nivel) {
    return <Etiqueta tom={tipo === 'SL' ? 'perigo' : 'aviso'}>Sem {tipo}</Etiqueta>;
  }
  return (
    <>
      {formatarPreco(nivel.preco)}{' '}
      <span className="text-xs text-neutral-400">
        ({formatarPctComSinal(nivel.distanciaPct)}; baleia {formatarPreco(nivel.precoBaleia)})
      </span>
    </>
  );
}

function BotaoCopiar({ texto, nome }: { texto: string; nome: string }) {
  const [estado, setEstado] = useState<'inicial' | 'copiado' | 'erro'>('inicial');
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setEstado('copiado');
    } catch {
      setEstado('erro');
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={classeBotaoSecundario}
        onClick={() => void copiar()}
        aria-label={`Copiar valores da sugestão para ${nome}`}
      >
        Copiar valores
      </button>
      <span role="status" className="text-xs">
        {estado === 'copiado' && <span className="text-emerald-300">Copiado (só texto).</span>}
        {estado === 'erro' && (
          <span className="text-red-300">
            Não foi possível copiar para a área de transferência.
          </span>
        )}
      </span>
    </div>
  );
}

function CartaoSugestao({
  item,
  ticker,
  alavancagemMaxima,
}: {
  item: SugestaoCarteiraDto;
  ticker: string;
  alavancagemMaxima: number;
}) {
  const { sugestao: s, carteira } = item;
  const p = s.posicao;
  const b = s.baleia;
  const nome = nomeCarteira(carteira);
  const idTitulo = `sugestao-carteira-${carteira.id}`;
  const texto = textoParaCopiar(item, ticker);
  const abaixoMinimo = s.motivo?.codigo === 'ABAIXO_ORDEM_MINIMA';

  return (
    <article
      aria-labelledby={idTitulo}
      className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950/40 p-3"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 id={idTitulo} className="font-medium">
            {nome}
          </h3>
          <Endereco endereco={carteira.endereco} />
          {carteira.entidade && (
            <span className="text-xs text-neutral-400">Entidade: {carteira.entidade}</span>
          )}
          <span className="text-xs text-neutral-500">
            Snapshot usado:{' '}
            {item.instanteSnapshot ? (
              <time dateTime={item.instanteSnapshot}>
                {formatarDataHora(item.instanteSnapshot)}
              </time>
            ) : (
              'nenhum'
            )}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {s.lado && <Etiqueta tom={s.lado}>{LADO_PT[s.lado]}</Etiqueta>}
          {s.viavel ? <Etiqueta>Viável</Etiqueta> : <Etiqueta tom="perigo">Inviável</Etiqueta>}
        </div>
      </header>

      {!s.viavel && s.motivo && (
        <div className="rounded-md border border-red-700 bg-red-950/60 p-2 text-sm text-red-100">
          <p className="font-semibold">Sem sugestão viável</p>
          <p>{s.motivo.mensagem}</p>
          {abaixoMinimo && p && (
            <p className="mt-1 text-xs">
              Ordem mínima: {formatarUsd(s.ordemMinimaUsd)} · notional calculado:{' '}
              {formatarUsd(p.notionalUsd)}. Valores calculados mostrados abaixo apenas para
              referência.
            </p>
          )}
        </div>
      )}

      {p && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Campo nome="Tamanho">
            {formatarNumero(p.tamanho, p.szDecimals)} {ticker}
          </Campo>
          <Campo nome="Notional">{formatarUsd(p.notionalUsd)}</Campo>
          <Campo nome="Margem (isolada)">{formatarUsd(p.margemUsd)}</Campo>
          <Campo nome="Alavancagem">
            {formatarNumero(p.alavancagem, 2)}×
            {p.alavancagemLimitada && (
              <span className="block text-xs text-amber-200">
                {origemLimiteAlavancagem(p.alavancagem, alavancagemMaxima) === 'utilizador'
                  ? 'Limitada ao seu máximo'
                  : 'Limitada ao máximo do ativo'}
              </span>
            )}
          </Campo>
          <Campo nome="Entrada de referência (preço atual)">{formatarPreco(p.precoEntrada)}</Campo>
          <Campo nome="Stop loss sugerido">
            <Protecao tipo="SL" nivel={p.stopLoss} />
          </Campo>
          <Campo nome="Take profit sugerido">
            <Protecao tipo="TP" nivel={p.takeProfit} />
          </Campo>
          <Campo nome="Liquidação (estimativa, margem isolada)">
            {p.liquidacaoEstimada === null ? 'Sem liquidação' : formatarPreco(p.liquidacaoEstimada)}
          </Campo>
          <Campo nome="Risco máximo por operação">{formatarUsd(p.riscoMaximoUsd)}</Campo>
          {p.stopLoss ? (
            <Campo nome="Perda até ao SL">{formatarUsd(p.perdaAteStopUsd)}</Campo>
          ) : (
            <Campo nome="Perda até à liquidação">
              <span className="text-red-300">{formatarUsd(p.perdaAteLiquidacaoUsd)}</span>
            </Campo>
          )}
          {s.rr && (
            <>
              <Campo nome="R:R sugerido">{formatarRR(s.rr.sugerido)}</Campo>
              <Campo nome="R:R aos níveis da baleia (entrar agora)">
                {formatarRR(s.rr.aosNiveisDaBaleia)}{' '}
                <span className="text-xs text-neutral-400">
                  (baleia na entrada: {formatarRR(s.rr.baleia)})
                </span>
              </Campo>
            </>
          )}
          {s.entradaTardia && (
            <Campo nome="Entrada tardia">
              {formatarPctComSinal(s.entradaTardia.variacaoFavoravelPct)} a favor{' '}
              <span className="text-xs text-neutral-400">
                (limiar {formatarPct(s.entradaTardia.limiarPct)})
              </span>
              {s.entradaTardia.tardia && (
                <span className="ml-1">
                  <Etiqueta tom="aviso">Entrada tardia</Etiqueta>
                </span>
              )}
            </Campo>
          )}
          {p.limitadoPeloRisco && (
            <p className="text-xs text-amber-200 sm:col-span-2 lg:col-span-3">
              Tamanho reduzido para respeitar o risco máximo por operação.
            </p>
          )}
        </dl>
      )}

      {b && (
        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-300">Dados da baleia usados</summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            <Campo nome="accountValue">
              {formatarUsd(b.accountValue)}
              {!b.accountValueRepresentativo && (
                <span className="block text-xs text-amber-200">Não representativo</span>
              )}
            </Campo>
            <Campo nome="% de margem">{formatarPct(b.percentagemMargemPct)}</Campo>
            <Campo nome="Alavancagem">
              {formatarNumero(b.alavancagem, 2)}× {b.tipoMargem}
            </Campo>
            <Campo nome="Fator (capital ÷ accountValue)">{formatarNumero(s.fator, 8)}</Campo>
            <Campo nome="Entrada da baleia">{formatarPreco(b.entryPx)}</Campo>
            {b.modoConta && <Campo nome="Modo de conta">{b.modoConta}</Campo>}
          </dl>
        </details>
      )}

      <ListaAvisos avisos={s.avisos} />

      {texto && <BotaoCopiar texto={texto} nome={nome} />}

      <p className="text-xs text-neutral-400" role="note">
        {s.avisoLegal}
      </p>
    </article>
  );
}

function Resultado({ resposta, calculadoEm }: { resposta: RespostaSugestao; calculadoEm: number }) {
  const d = resposta.definicoes;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">
        Calculado em{' '}
        <time dateTime={new Date(calculadoEm).toISOString()}>{formatarDataHora(calculadoEm)}</time>
        {resposta.precoMercado && (
          <>
            {' '}
            · preço {formatarPreco(resposta.precoMercado.valor)} (
            {resposta.precoMercado.fonte === 'snapshot' ? 'último gravado, ' : ''}
            <time dateTime={resposta.precoMercado.instante}>
              {formatarDataHora(resposta.precoMercado.instante)}
            </time>
            )
          </>
        )}{' '}
        · capital {formatarUsd(d.capitalUsd)}, alavancagem máx.{' '}
        {formatarNumero(d.alavancagemMaxima)}
        ×, risco {formatarPct(d.riscoPorOperacaoPct)}
      </p>
      {!resposta.analiseAtiva && (
        <p className="rounded-md border border-amber-700 bg-amber-950/50 p-2 text-sm text-amber-100">
          Análise inativa: usa-se o último snapshot disponível de cada carteira.
        </p>
      )}
      {resposta.sugestoes.length === 0 ? (
        <Vazio>
          Nenhuma carteira tem posição em {resposta.ticker} neste momento: não há nada a replicar.
        </Vazio>
      ) : (
        resposta.sugestoes.map((item) => (
          <CartaoSugestao
            key={item.carteira.id}
            item={item}
            ticker={resposta.ticker}
            alavancagemMaxima={d.alavancagemMaxima}
          />
        ))
      )}
      <p className="text-xs text-neutral-400">{resposta.avisoLegal}</p>
    </div>
  );
}

/** Painel da sugestão proporcional: só calcula quando o utilizador pede. */
export function PainelSugestao({
  calculo,
  aoCalcular,
}: {
  calculo: {
    data: CalculoSugestao | undefined;
    error: unknown;
    isPending: boolean;
    isError: boolean;
  };
  aoCalcular: (carteira?: number) => void;
}) {
  const dados = calculo.data;
  const capitalEmFalta =
    calculo.isError &&
    calculo.error instanceof ErroApi &&
    calculo.error.codigo === 'CAPITAL_NAO_CONFIGURADO';

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">
        Cálculo local e gratuito, apenas a pedido. Nunca envia ordens nem comunica com a exchange.
      </p>
      <div className="flex flex-wrap gap-2">
        {dados ? (
          <>
            <button
              type="button"
              className={classeBotaoPrimario}
              onClick={() => aoCalcular(dados.carteira)}
              disabled={calculo.isPending}
            >
              Recalcular
            </button>
            {dados.carteira !== undefined && (
              <button
                type="button"
                className={classeBotaoSecundario}
                onClick={() => aoCalcular()}
                disabled={calculo.isPending}
              >
                Calcular para todas as carteiras
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className={classeBotaoPrimario}
            onClick={() => aoCalcular()}
            disabled={calculo.isPending}
          >
            Calcular sugestão proporcional
          </button>
        )}
      </div>
      <div aria-live="polite" aria-busy={calculo.isPending}>
        {calculo.isPending ? (
          <Carregando texto="A calcular sugestão…" />
        ) : capitalEmFalta ? (
          <div
            role="alert"
            className="rounded-md border border-amber-700 bg-amber-950/50 p-3 text-sm text-amber-100"
          >
            <p>Para calcular a sugestão, configure primeiro o capital disponível.</p>
            <Link to="/definicoes" className="text-sky-300 underline">
              Ir para Definições
            </Link>
          </div>
        ) : calculo.isError ? (
          <CaixaErro erro={calculo.error} />
        ) : dados ? (
          <Resultado resposta={dados.resposta} calculadoEm={dados.calculadoEm} />
        ) : null}
      </div>
    </div>
  );
}
