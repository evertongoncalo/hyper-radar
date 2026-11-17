import { adicionarCarteiraPedidoSchema, type CarteiraNoAtivo } from '@hyper-radar/shared';
import { useState, type FormEvent } from 'react';
import { mensagemDeErro } from '../api/cliente';
import { useAdicionarCarteira, useRemoverCarteiraDoAtivo } from '../hooks/consultas';
import { distanciaLiquidacaoPct } from '../lib/desatualizado';
import {
  formatarDataHora,
  formatarNumero,
  formatarPct,
  formatarPreco,
  formatarTamanho,
  formatarUsd,
  formatarUsdComSinal,
  LADO_PT,
  nomeCarteira,
} from '../lib/formatacao';
import {
  classeBotaoPerigo,
  classeBotaoPrimario,
  classeCampo,
  Endereco,
  Etiqueta,
  Vazio,
} from './comuns';

export const NOTA_SLTP =
  'Só são visíveis SL/TP colocados na exchange; stops geridos fora dela não aparecem.';
export const AVISO_REINICIO =
  'Adicionar ou remover uma carteira reinicia a análise deste ativo (nova linha de base, sem falsos eventos).';

function Protecoes({ c, tipo }: { c: CarteiraNoAtivo; tipo: 'SL' | 'TP' }) {
  const ordens = c.ultimoSnapshot?.ordens.filter((o) => o.tipo === tipo) ?? [];
  if (ordens.length === 0) return <>—</>;
  return (
    <ul>
      {ordens.map((o, i) => (
        <li key={i}>
          {formatarPreco(o.triggerPx)}
          {o.tamanho !== null && (
            <span className="text-neutral-400"> ({formatarTamanho(o.tamanho)})</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Linha({
  c,
  precoAtivo,
  aoRemover,
  aRemover,
}: {
  c: CarteiraNoAtivo;
  precoAtivo: number | null;
  aoRemover: () => void;
  aRemover: boolean;
}) {
  const s = c.ultimoSnapshot;
  const p = s?.posicao ?? null;
  const preco = s?.precoMercado ?? precoAtivo;
  const dist = p ? distanciaLiquidacaoPct(preco, p.liquidationPx) : null;
  return (
    <tr className="border-t border-neutral-800 align-top">
      <th scope="row" className="py-2 pr-3 text-left font-normal">
        <div className="font-medium">{nomeCarteira(c)}</div>
        <Endereco endereco={c.endereco} />
        {c.entidade && <div className="text-xs text-neutral-400">Entidade: {c.entidade}</div>}
        <div className="mt-1 flex flex-wrap gap-1">
          {c.desatualizada && (
            <Etiqueta tom="aviso" titulo="A última leitura desta carteira falhou.">
              Desatualizada
            </Etiqueta>
          )}
          {s?.accountValueRepresentativo === false && (
            <Etiqueta
              tom="aviso"
              titulo="Conta unificada / margem de portfólio: o accountValue por DEX não representa o saldo real."
            >
              Equity não representativa (conta unificada)
            </Etiqueta>
          )}
        </div>
        {s && (
          <div className="text-xs text-neutral-500">
            <time dateTime={s.instante}>{formatarDataHora(s.instante)}</time>
          </div>
        )}
      </th>
      {p ? (
        <>
          <td className="py-2 pr-3">
            <Etiqueta tom={p.lado}>{LADO_PT[p.lado]}</Etiqueta>
          </td>
          <td className="py-2 pr-3 text-right tabular-nums">{formatarTamanho(p.tamanho)}</td>
          <td className="py-2 pr-3 text-right tabular-nums">{formatarUsd(p.notional)}</td>
          <td className="py-2 pr-3 text-right tabular-nums">{formatarPreco(p.entryPx)}</td>
          <td className="py-2 pr-3 text-right tabular-nums">
            {formatarNumero(p.alavancagem, 1)}×{' '}
            <span className="text-xs text-neutral-400">{p.tipoMargem}</span>
          </td>
          <td className="py-2 pr-3 text-right tabular-nums">
            {formatarPreco(p.liquidationPx)}
            {dist !== null && (
              <div className="text-xs text-neutral-400">{formatarPct(dist, 1)}</div>
            )}
          </td>
          <td
            className={`py-2 pr-3 text-right tabular-nums ${p.unrealizedPnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}
          >
            {formatarUsdComSinal(p.unrealizedPnl)}
          </td>
          <td className="py-2 pr-3 text-right tabular-nums">
            <Protecoes c={c} tipo="SL" />
          </td>
          <td className="py-2 pr-3 text-right tabular-nums">
            <Protecoes c={c} tipo="TP" />
          </td>
        </>
      ) : (
        <td colSpan={9} className="py-2 pr-3 text-neutral-400">
          {s ? 'Sem posição neste ativo.' : 'Ainda sem leitura.'}
        </td>
      )}
      <td className="py-2 text-right">
        <button
          type="button"
          className={classeBotaoPerigo}
          onClick={aoRemover}
          disabled={aRemover}
          aria-label={`Remover ${nomeCarteira(c)} deste ativo`}
        >
          Remover
        </button>
      </td>
    </tr>
  );
}

export function TabelaCarteiras({
  ativoId,
  ticker,
  carteiras,
  precoAtivo,
}: {
  ativoId: number;
  ticker: string;
  carteiras: CarteiraNoAtivo[];
  precoAtivo: number | null;
}) {
  const remover = useRemoverCarteiraDoAtivo(ativoId);
  const pedirRemocao = (c: CarteiraNoAtivo) => {
    if (
      window.confirm(
        `Remover ${nomeCarteira(c)} de ${ticker}? A análise deste ativo será reiniciada.`,
      )
    ) {
      remover.mutate(c.id);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-400" role="note">
        {NOTA_SLTP}
      </p>
      {remover.isError && (
        <p role="alert" className="text-sm text-red-300">
          {mensagemDeErro(remover.error)}
        </p>
      )}
      {carteiras.length === 0 ? (
        <Vazio>Este ativo ainda não tem carteiras. Adicione uma abaixo.</Vazio>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm">
            <caption className="sr-only">Carteiras e posições em {ticker}</caption>
            <thead className="text-xs text-neutral-400">
              <tr>
                <th scope="col" className="py-1 pr-3 text-left">
                  Carteira
                </th>
                <th scope="col" className="py-1 pr-3 text-left">
                  Lado
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  Tamanho
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  Notional
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  Entrada
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  Alavancagem
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  Liquidação (dist.)
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  PnL
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  SL
                </th>
                <th scope="col" className="py-1 pr-3 text-right">
                  TP
                </th>
                <th scope="col" className="py-1 text-right">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {carteiras.map((c) => (
                <Linha
                  key={c.id}
                  c={c}
                  precoAtivo={precoAtivo}
                  aoRemover={() => pedirRemocao(c)}
                  aRemover={remover.isPending}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormularioCarteira ativoId={ativoId} />
    </div>
  );
}

function FormularioCarteira({ ativoId }: { ativoId: number }) {
  const [endereco, setEndereco] = useState('');
  const [alias, setAlias] = useState('');
  const [entidade, setEntidade] = useState('');
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const adicionar = useAdicionarCarteira(ativoId);

  const submeter = (e: FormEvent) => {
    e.preventDefault();
    setSucesso(null);
    const r = adicionarCarteiraPedidoSchema.safeParse({ endereco, alias, entidade });
    if (!r.success) {
      setErroLocal(r.error.issues[0]?.message ?? 'Dados inválidos.');
      return;
    }
    setErroLocal(null);
    adicionar.mutate(r.data, {
      onSuccess: (res) => {
        setEndereco('');
        setAlias('');
        setEntidade('');
        setSucesso(
          res.analiseReiniciada
            ? 'Carteira adicionada. A análise foi reiniciada.'
            : 'Carteira adicionada.',
        );
      },
    });
  };
  const erro = erroLocal ?? (adicionar.isError ? mensagemDeErro(adicionar.error) : null);

  return (
    <form
      onSubmit={submeter}
      noValidate
      className="flex flex-col gap-2 border-t border-neutral-800 pt-3"
    >
      <h3 className="font-medium">Adicionar carteira</h3>
      <p className="text-xs text-amber-200">{AVISO_REINICIO}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Endereço
          <input
            value={endereco}
            onChange={(e) => setEndereco(e.target.value)}
            className={`${classeCampo} w-[26rem] max-w-full font-mono`}
            placeholder="0x…"
            autoComplete="off"
            aria-invalid={erro ? true : undefined}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Alias (opcional)
          <input value={alias} onChange={(e) => setAlias(e.target.value)} className={classeCampo} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Entidade (opcional)
          <input
            value={entidade}
            onChange={(e) => setEntidade(e.target.value)}
            className={classeCampo}
          />
        </label>
        <button type="submit" className={classeBotaoPrimario} disabled={adicionar.isPending}>
          Adicionar carteira
        </button>
      </div>
      {erro && (
        <p role="alert" className="text-sm text-red-300">
          {erro}
        </p>
      )}
      {sucesso && (
        <p role="status" className="text-sm text-emerald-300">
          {sucesso}
        </p>
      )}
    </form>
  );
}
