import type { AgregadosAtivoResposta, VariacaoAgregadoDto } from '@hyper-radar/shared';
import {
  formatarNumero,
  formatarPct,
  formatarPreco,
  formatarUsd,
  formatarUsdComSinal,
  LADO_PT,
} from '../lib/formatacao';
import { Etiqueta, Vazio } from './comuns';

function Cartao({ rotulo, valor, detalhe }: { rotulo: string; valor: string; detalhe?: string }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3">
      <dt className="text-xs text-neutral-400">{rotulo}</dt>
      <dd className="text-lg font-semibold tabular-nums">{valor}</dd>
      {detalhe && <dd className="text-xs text-neutral-400">{detalhe}</dd>}
    </div>
  );
}

function Variacao({ titulo, v }: { titulo: string; v: VariacaoAgregadoDto | null }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3 text-sm">
      <h4 className="mb-1 text-xs text-neutral-400">{titulo}</h4>
      {v ? (
        <dl className="grid grid-cols-2 gap-x-2 tabular-nums">
          <dt>Net</dt>
          <dd>{formatarUsdComSinal(v.netUsd.absoluta)}</dd>
          <dt>Long</dt>
          <dd>{formatarUsdComSinal(v.longUsd.absoluta)}</dd>
          <dt>Short</dt>
          <dd>{formatarUsdComSinal(v.shortUsd.absoluta)}</dd>
          <dt>Carteiras L/S</dt>
          <dd>
            {v.carteirasLong >= 0 ? '+' : ''}
            {v.carteirasLong} / {v.carteirasShort >= 0 ? '+' : ''}
            {v.carteirasShort}
          </dd>
          {v.precoReferencia && (
            <>
              <dt>Preço</dt>
              <dd>{v.precoReferencia.pct === null ? '—' : formatarPct(v.precoReferencia.pct)}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="text-neutral-400">Sem histórico suficiente.</p>
      )}
    </div>
  );
}

/** Agregados do ativo: exposição, médias, zonas de liquidação, variações e hedge por entidade. */
export function Agregados({ dados }: { dados: AgregadosAtivoResposta }) {
  const a = dados.atual;
  const maxZona = Math.max(1, ...a.zonasLiquidacao.map((z) => z.notional));
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Cartao
          rotulo={a.netUsd >= 0 ? 'Net long' : 'Net short'}
          valor={formatarUsd(Math.abs(a.netUsd))}
          detalhe={`Long ${formatarUsd(a.long.notionalUsd)} · Short ${formatarUsd(a.short.notionalUsd)}`}
        />
        <Cartao
          rotulo="Carteiras long / short"
          valor={`${a.long.carteiras} / ${a.short.carteiras}`}
          detalhe={`${a.carteirasSemPosicao} sem posição`}
        />
        <Cartao
          rotulo="Entrada média long / short"
          valor={`${formatarPreco(a.long.entradaMedia)} / ${formatarPreco(a.short.entradaMedia)}`}
          detalhe="Ponderada pelo tamanho"
        />
        <Cartao
          rotulo="Alavancagem média"
          valor={a.alavancagemMedia === null ? '—' : `${formatarNumero(a.alavancagemMedia, 1)}×`}
          detalhe={`Long ${a.long.alavancagemMedia === null ? '—' : formatarNumero(a.long.alavancagemMedia, 1) + '×'} · Short ${a.short.alavancagemMedia === null ? '—' : formatarNumero(a.short.alavancagemMedia, 1) + '×'}`}
        />
      </dl>

      <div className="grid gap-2 sm:grid-cols-2">
        <Variacao titulo="Variação 1 h" v={dados.variacao1h} />
        <Variacao titulo="Variação 24 h" v={dados.variacao24h} />
      </div>

      <div>
        <h3 className="mb-2 font-medium">Zonas de liquidação</h3>
        {a.zonasLiquidacao.length === 0 ? (
          <Vazio>Sem preços de liquidação conhecidos.</Vazio>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {a.zonasLiquidacao.map((z, i) => (
              <li key={i} className="grid grid-cols-[7rem_1fr_auto] items-center gap-2">
                <span className="tabular-nums">{formatarPreco(z.preco)}</span>
                <span className="h-3 rounded bg-neutral-800" aria-hidden="true">
                  <span
                    className={`block h-3 rounded ${z.lado === 'long' ? 'bg-emerald-600' : 'bg-red-600'}`}
                    style={{ width: `${Math.max(2, (z.notional / maxZona) * 100)}%` }}
                  />
                </span>
                <span className="text-xs text-neutral-300 tabular-nums">
                  {LADO_PT[z.lado]} {formatarUsd(z.notional)} · {formatarPct(z.distanciaPct, 1)} ·{' '}
                  {z.carteiras.length} cart.
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 font-medium">Por entidade</h3>
        {a.entidades.length === 0 ? (
          <Vazio>Nenhuma carteira tem entidade definida.</Vazio>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {a.entidades.map((e) => (
              <li key={e.entidade} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.entidade}</span>
                <span className="text-neutral-400">({e.carteiras.length} cart.)</span>
                <span className="tabular-nums">Net {formatarUsdComSinal(e.netUsd)}</span>
                {e.hedgeInterno && (
                  <Etiqueta tom="aviso">Hedge interno: {formatarUsd(e.notionalHedgeado)}</Etiqueta>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          A posição visível pode ser só uma perna: a mesma entidade pode estar coberta noutras
          plataformas.
        </p>
      </div>
    </div>
  );
}
