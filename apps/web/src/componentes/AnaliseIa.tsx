import {
  AVISO_LEGAL,
  type EstadoIa,
  type RelatorioIa,
  type RelatorioIaDto,
  type ResumoRelatorioIa,
} from '@hyper-radar/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAnalisarComIa, useEstadoIa, useRelatorioIa, useRelatoriosIa } from '../hooks/consultas';
import {
  formatarDataHora,
  formatarNumero,
  formatarPct,
  formatarPreco,
  LADO_PT,
} from '../lib/formatacao';
import {
  ALINHAMENTO_PT,
  descreverErroIa,
  distanciaPct,
  estimarCustoUsd,
  formatarCustoIa,
  formatarUsoLimite,
  limiteAtingido,
  precoDoModelo,
  TOKENS_REFERENCIA,
  VIES_PT,
} from '../lib/ia';
import { formatarPctComSinal } from '../lib/sugestao';
import { CaixaErro, Carregando, classeBotaoPrimario, classeBotaoSecundario, Vazio } from './comuns';

const ESTILO_VIES: Record<RelatorioIa['vies'], { classe: string; simbolo: string }> = {
  alta: { classe: 'border-emerald-700 bg-emerald-950/60 text-emerald-200', simbolo: '▲' },
  baixa: { classe: 'border-red-700 bg-red-950/60 text-red-200', simbolo: '▼' },
  neutro: { classe: 'border-neutral-600 bg-neutral-800 text-neutral-200', simbolo: '■' },
  misto: { classe: 'border-amber-700 bg-amber-950/50 text-amber-100', simbolo: '◆' },
};

function EtiquetaVies({ vies }: { vies: RelatorioIa['vies'] }) {
  const e = ESTILO_VIES[vies];
  return (
    <span
      data-vies={vies}
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-sm font-medium ${e.classe}`}
    >
      <span aria-hidden="true">{e.simbolo}</span>
      Viés: {VIES_PT[vies]}
    </span>
  );
}

function BarraConfianca({ valor }: { valor: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, valor)) * 100);
  return (
    <div className="flex min-w-40 flex-1 flex-col gap-1">
      <span className="text-sm">Confiança: {formatarPct(pct, 0)}</span>
      <div
        role="meter"
        aria-label="Confiança do modelo"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct} %`}
        className="h-2 w-full overflow-hidden rounded bg-neutral-800"
      >
        <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Bloco({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-sm font-medium text-neutral-200">{titulo}</h4>
      {children}
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

function Distancia({ preco, referencia }: { preco: number; referencia: number | null }) {
  const d = distanciaPct(preco, referencia);
  if (d === null) return null;
  return <span className="text-xs text-neutral-400"> ({formatarPctComSinal(d)})</span>;
}

export interface MetadadosRelatorio {
  /** `null` = relatório aberto do histórico. */
  daCache: boolean | null;
  avisoLegal: string;
}

/** Relatório estruturado (sem markdown: cada campo tem o seu componente). */
export function RelatorioIaVista({
  dto,
  meta,
  precoAtual,
  aoComparar,
}: {
  dto: RelatorioIaDto;
  meta: MetadadosRelatorio;
  precoAtual: number | null;
  aoComparar?: (() => void) | undefined;
}) {
  const r = dto.relatorio;
  const niveis = [...r.niveis_chave].sort((a, b) => b.preco - a.preco);
  const c = r.cenario_entrada_sugerido;
  return (
    <article
      aria-labelledby={`relatorio-ia-${dto.id}`}
      className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-950/40 p-3"
    >
      <h3 id={`relatorio-ia-${dto.id}`} className="font-medium">
        Relatório IA de {formatarDataHora(dto.criadoEm)}
      </h3>

      <div className="flex flex-wrap items-center gap-3">
        <EtiquetaVies vies={r.vies} />
        <BarraConfianca valor={r.confianca} />
      </div>

      <Bloco titulo="Resumo">
        <p className="text-sm whitespace-pre-line">{r.resumo}</p>
      </Bloco>

      <Bloco titulo="Alinhamento das baleias">
        <p className="text-sm">
          <span className="font-semibold">{ALINHAMENTO_PT[r.alinhamento_baleias.nivel]}:</span>{' '}
          {r.alinhamento_baleias.descricao}
        </p>
      </Bloco>

      <Bloco titulo="Riscos">
        {r.riscos.length === 0 ? (
          <p className="text-sm text-neutral-400">Sem riscos indicados.</p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {r.riscos.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        )}
      </Bloco>

      <Bloco titulo="Níveis-chave">
        {niveis.length === 0 ? (
          <p className="text-sm text-neutral-400">Sem níveis indicados.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Níveis-chave por preço">
            {niveis.map((n, i) => (
              <li key={i} className="flex flex-wrap gap-x-2">
                <span className="font-semibold tabular-nums">
                  {formatarPreco(n.preco)}
                  <Distancia preco={n.preco} referencia={precoAtual} />
                </span>
                <span>{n.descricao}</span>
              </li>
            ))}
          </ul>
        )}
      </Bloco>

      <Bloco titulo="Cenários">
        {r.cenarios.length === 0 ? (
          <p className="text-sm text-neutral-400">Sem cenários indicados.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {r.cenarios.map((s, i) => (
              <li key={i} className="rounded-md border border-neutral-800 p-2 text-sm">
                <p className="font-semibold">
                  {s.nome} · {formatarPct(s.probabilidade * 100, 0)}
                </p>
                <p>{s.descricao}</p>
                <p className="text-xs text-neutral-400">Gatilho: {s.gatilho}</p>
              </li>
            ))}
          </ul>
        )}
      </Bloco>

      <section
        aria-labelledby={`cenario-hipotetico-${dto.id}`}
        className="flex flex-col gap-2 rounded-md border border-dashed border-amber-700 bg-amber-950/20 p-3"
      >
        <h4 id={`cenario-hipotetico-${dto.id}`} className="text-sm font-semibold text-amber-100">
          Cenário hipotético — não é uma recomendação
        </h4>
        {c ? (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <Campo nome="Lado">{LADO_PT[c.lado]}</Campo>
              <Campo nome="Entrada">{formatarPreco(c.entrada)}</Campo>
              <Campo nome="Stop loss">
                {formatarPreco(c.stop_loss)}
                <Distancia preco={c.stop_loss} referencia={c.entrada} />
              </Campo>
              <Campo nome="Take profit">
                {formatarPreco(c.take_profit)}
                <Distancia preco={c.take_profit} referencia={c.entrada} />
              </Campo>
            </dl>
            <p className="text-sm">{c.justificacao}</p>
          </>
        ) : (
          <p className="text-sm text-neutral-400">O modelo não indicou um cenário de entrada.</p>
        )}
        {aoComparar && (
          <div>
            <button type="button" className={classeBotaoSecundario} onClick={aoComparar}>
              Comparar com a Sugestão proporcional
            </button>
          </div>
        )}
      </section>

      <Bloco titulo="Avisos">
        <ul className="flex flex-col gap-1">
          {r.avisos.map((a, i) => (
            <li
              key={i}
              className="rounded-md border border-amber-700 bg-amber-950/50 px-2 py-1.5 text-sm text-amber-100"
            >
              {a}
            </li>
          ))}
        </ul>
      </Bloco>

      <p className="text-xs text-neutral-400" role="note">
        {meta.avisoLegal}
      </p>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-neutral-400 sm:grid-cols-2 lg:grid-cols-4">
        <Campo nome="Modelo">{dto.modelo}</Campo>
        <Campo nome="Data (Lisboa)">
          <time dateTime={dto.criadoEm}>{formatarDataHora(dto.criadoEm)}</time>
        </Campo>
        <Campo nome="Tokens (entrada / saída)">
          {formatarNumero(dto.tokensEntrada, 0)} / {formatarNumero(dto.tokensSaida, 0)}
        </Campo>
        <Campo nome="Custo estimado">{formatarCustoIa(dto.custoEstimadoUsd)}</Campo>
        <Campo nome="Origem">
          {meta.daCache === null
            ? 'Histórico'
            : meta.daCache
              ? 'Da cache (sem nova chamada nem custo)'
              : 'Nova chamada'}
        </Campo>
      </dl>
    </article>
  );
}

/** Modelo, preços e uso de hoje da IA (também usado nas Definições). */
export function UsoIaHoje({ estado }: { estado: EstadoIa }) {
  const preco = precoDoModelo(estado);
  const h = estado.hoje;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <Campo nome="Modelo">{estado.modelo}</Campo>
      <Campo nome="Preço por 1M tokens (entrada / saída)">
        {preco
          ? `${formatarCustoIa(preco.entradaUsdPorMilhao)} / ${formatarCustoIa(preco.saidaUsdPorMilhao)}`
          : 'Sem preço conhecido'}
      </Campo>
      <Campo nome="Chamadas hoje">{formatarUsoLimite(h.chamadas, h.limiteChamadas)}</Campo>
      <Campo nome="Tokens hoje">{formatarUsoLimite(h.tokens, h.limiteTokens)}</Campo>
      <Campo nome="Custo estimado hoje">{formatarCustoIa(h.custoEstimadoUsd)}</Campo>
    </dl>
  );
}

function Confirmacao({
  estado,
  forcar,
  aoConfirmar,
  aoCancelar,
}: {
  estado: EstadoIa | undefined;
  forcar: boolean;
  aoConfirmar: () => void;
  aoCancelar: () => void;
}) {
  const custo = estimarCustoUsd(precoDoModelo(estado));
  return (
    <div
      role="alertdialog"
      aria-labelledby="confirmar-ia-titulo"
      aria-describedby="confirmar-ia-texto"
      className="flex flex-col gap-2 rounded-md border border-sky-800 bg-sky-950/40 p-3 text-sm"
    >
      <p id="confirmar-ia-titulo" className="font-semibold">
        {forcar ? 'Forçar uma nova análise?' : 'Pedir análise à IA?'}
      </p>
      <p id="confirmar-ia-texto">
        Esta ação pode ter custo na OpenAI (modelo {estado?.modelo ?? 'configurado no servidor'}
        ).{' '}
        {custo === null
          ? 'Custo por estimar: o modelo não tem preço conhecido.'
          : `Poderá custar ~${formatarCustoIa(custo)} (estimativa para ~${formatarNumero(TOKENS_REFERENCIA.entrada, 0)} tokens de entrada e ~${formatarNumero(TOKENS_REFERENCIA.saida, 0)} de saída).`}{' '}
        {forcar
          ? 'A cache é ignorada e a chamada conta para os limites diários.'
          : 'Se nada tiver mudado desde a última análise, é devolvido o relatório anterior sem custo.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={classeBotaoPrimario} onClick={aoConfirmar} autoFocus>
          Confirmar
        </button>
        <button type="button" className={classeBotaoSecundario} onClick={aoCancelar}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function ErroAnalise({ erro }: { erro: unknown }) {
  const d = descreverErroIa(erro);
  return (
    <div
      role="alert"
      className="rounded-md border border-red-800 bg-red-950/50 p-3 text-sm text-red-200"
    >
      <p className="font-semibold">{d.titulo}</p>
      <p>{d.mensagem}</p>
      {d.ligacaoDefinicoes && (
        <Link to="/definicoes" className="text-sky-300 underline">
          Rever limites em Definições
        </Link>
      )}
    </div>
  );
}

function LinhaHistorico({
  item,
  aberto,
  aoAbrir,
}: {
  item: ResumoRelatorioIa;
  aberto: boolean;
  aoAbrir: () => void;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-neutral-800 p-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-0.5">
        <span>
          <time dateTime={item.criadoEm}>{formatarDataHora(item.criadoEm)}</time> ·{' '}
          {VIES_PT[item.vies]} · confiança {formatarPct(Math.round(item.confianca * 100), 0)}
        </span>
        <span className="text-xs text-neutral-400">
          {item.modelo} · {formatarCustoIa(item.custoEstimadoUsd)}
        </span>
        <span className="line-clamp-2 text-xs text-neutral-300">{item.resumo}</span>
      </div>
      <button
        type="button"
        className={classeBotaoSecundario}
        onClick={aoAbrir}
        aria-pressed={aberto}
        aria-label={`Abrir relatório de ${formatarDataHora(item.criadoEm)}`}
      >
        {aberto ? 'Aberto' : 'Abrir'}
      </button>
    </li>
  );
}

function Historico({
  ativoId,
  selecionado,
  aoAbrir,
}: {
  ativoId: number;
  selecionado: number | null;
  aoAbrir: (id: number) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const lista = useRelatoriosIa(ativoId, aberto);
  const itens = lista.data?.pages.flatMap((p) => p.itens) ?? [];
  return (
    <details
      className="text-sm"
      onToggle={(e) => setAberto((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-neutral-300">Histórico de relatórios</summary>
      <div className="mt-2 flex flex-col gap-2">
        {!aberto ? null : lista.isPending ? (
          <Carregando texto="A carregar histórico…" />
        ) : lista.isError ? (
          <CaixaErro erro={lista.error} aoRepetir={() => void lista.refetch()} />
        ) : itens.length === 0 ? (
          <Vazio>Ainda não há relatórios para este ativo.</Vazio>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {itens.map((i) => (
                <LinhaHistorico
                  key={i.id}
                  item={i}
                  aberto={selecionado === i.id}
                  aoAbrir={() => aoAbrir(i.id)}
                />
              ))}
            </ul>
            {lista.hasNextPage && (
              <div>
                <button
                  type="button"
                  className={classeBotaoSecundario}
                  onClick={() => void lista.fetchNextPage()}
                  disabled={lista.isFetchingNextPage}
                >
                  Carregar mais relatórios
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/**
 * Painel "Análise IA": só chama a OpenAI quando o utilizador clica e confirma. Nada aqui
 * dispara a análise ao montar, ao focar a janela nem com eventos SSE.
 */
export function PainelAnaliseIa({
  ativoId,
  precoAtual,
  aoComparar,
}: {
  ativoId: number;
  precoAtual: number | null;
  aoComparar?: () => void;
}) {
  const estado = useEstadoIa();
  const analise = useAnalisarComIa(ativoId);
  const [confirmar, setConfirmar] = useState<{ forcar: boolean } | null>(null);
  const [historicoId, setHistoricoId] = useState<number | null>(null);
  const historico = useRelatorioIa(historicoId);

  const e = estado.data;
  const semChave = e !== undefined && !e.configurada;
  const desativado = estado.isPending || semChave || analise.isPending;
  const ultimo = analise.data;

  const pedir = (forcar: boolean) => setConfirmar({ forcar });
  const confirmarPedido = () => {
    if (!confirmar) return;
    const { forcar } = confirmar;
    setConfirmar(null);
    setHistoricoId(null);
    analise.mutate({ forcar });
  };

  let conteudo: ReactNode = null;
  if (historicoId !== null) {
    conteudo = historico.isPending ? (
      <Carregando texto="A abrir relatório…" />
    ) : historico.isError ? (
      <CaixaErro erro={historico.error} />
    ) : (
      <RelatorioIaVista
        dto={historico.data}
        meta={{ daCache: null, avisoLegal: AVISO_LEGAL }}
        precoAtual={precoAtual}
        aoComparar={aoComparar}
      />
    );
  } else if (analise.isPending) {
    conteudo = <Carregando texto="A analisar com IA… (pode demorar até 1–2 minutos)" />;
  } else if (analise.isError) {
    conteudo = <ErroAnalise erro={analise.error} />;
  } else if (ultimo) {
    conteudo = (
      <RelatorioIaVista
        dto={ultimo.relatorio}
        meta={{ daCache: ultimo.daCache, avisoLegal: ultimo.avisoLegal }}
        precoAtual={precoAtual}
        aoComparar={aoComparar}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400">
        Apenas a pedido: cada análise envia dados agregados à OpenAI e pode ter custo. Nunca é
        chamada automaticamente.
      </p>

      {estado.isPending ? (
        <Carregando texto="A carregar estado da IA…" />
      ) : estado.isError ? (
        <CaixaErro erro={estado.error} aoRepetir={() => void estado.refetch()} />
      ) : (
        <>
          {semChave && (
            <div
              role="note"
              className="rounded-md border border-amber-700 bg-amber-950/50 p-3 text-sm text-amber-100"
            >
              <p className="font-semibold">Análise IA não configurada.</p>
              <p>
                Defina <code>OPENAI_API_KEY</code> no ficheiro <code>.env</code> e reinicie o
                servidor. A chave nunca é mostrada nem enviada para o browser.
              </p>
            </div>
          )}
          <UsoIaHoje estado={estado.data} />
          {limiteAtingido(estado.data.hoje) && (
            <p className="text-sm text-amber-200">
              Limite diário atingido: novas análises serão recusadas até amanhã (ou aumente o limite
              em{' '}
              <Link to="/definicoes" className="text-sky-300 underline">
                Definições
              </Link>
              ).
            </p>
          )}
        </>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={classeBotaoPrimario}
          onClick={() => pedir(false)}
          disabled={desativado || confirmar !== null}
        >
          {analise.isPending ? 'A analisar…' : 'Analisar com IA'}
        </button>
        {ultimo?.daCache && historicoId === null && !analise.isPending && (
          <button
            type="button"
            className={classeBotaoSecundario}
            onClick={() => pedir(true)}
            disabled={desativado || confirmar !== null}
          >
            Forçar nova análise
          </button>
        )}
        {historicoId !== null && (ultimo || analise.isError) && (
          <button
            type="button"
            className={classeBotaoSecundario}
            onClick={() => setHistoricoId(null)}
          >
            Voltar à última análise
          </button>
        )}
      </div>

      {confirmar && (
        <Confirmacao
          estado={e}
          forcar={confirmar.forcar}
          aoConfirmar={confirmarPedido}
          aoCancelar={() => setConfirmar(null)}
        />
      )}

      <div
        aria-live="polite"
        aria-busy={analise.isPending || (historicoId !== null && historico.isPending)}
      >
        {conteudo}
      </div>

      <Historico ativoId={ativoId} selecionado={historicoId} aoAbrir={setHistoricoId} />
    </div>
  );
}
