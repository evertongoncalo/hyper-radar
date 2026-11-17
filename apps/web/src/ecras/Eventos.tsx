import { TIPOS_EVENTO_API, type TipoEventoDto } from '@hyper-radar/shared';
import { useMemo, useState } from 'react';
import type { FiltrosEventos } from '../api/recursos';
import {
  CaixaErro,
  Carregando,
  classeBotaoSecundario,
  classeCampo,
  Seccao,
  Vazio,
} from '../componentes/comuns';
import { ListaEventos } from '../componentes/FeedEventos';
import { useAtivos, useCarteiras, useEventos } from '../hooks/consultas';
import { lisboaParaIso, nomeCarteira, TIPOS_EVENTO_PT } from '../lib/formatacao';

export const TAMANHO_PAGINA_EVENTOS = 50;

interface Formulario {
  ativo: string;
  carteira: string;
  tipos: TipoEventoDto[];
  naoLidos: boolean;
  /** Valores `datetime-local`, em hora de Lisboa. */
  desde: string;
  ate: string;
}

const VAZIO: Formulario = {
  ativo: '',
  carteira: '',
  tipos: [],
  naoLidos: false,
  desde: '',
  ate: '',
};

/** Converte o formulário nos filtros da API (datas de Lisboa → ISO UTC). */
export function paraFiltros(f: Formulario): { filtros: FiltrosEventos; erro: string | null } {
  const desde = f.desde ? lisboaParaIso(f.desde) : null;
  const ate = f.ate ? lisboaParaIso(f.ate) : null;
  let erro: string | null = null;
  if ((f.desde && !desde) || (f.ate && !ate)) erro = 'Data inválida.';
  else if (desde && ate && Date.parse(desde) > Date.parse(ate)) {
    erro = '"Desde" tem de ser anterior ou igual a "Até".';
  }
  return {
    erro,
    filtros: {
      ativo: f.ativo ? Number(f.ativo) : undefined,
      carteira: f.carteira ? Number(f.carteira) : undefined,
      tipos: f.tipos.length ? f.tipos : undefined,
      naoLidos: f.naoLidos || undefined,
      desde: erro ? undefined : (desde ?? undefined),
      ate: erro ? undefined : (ate ?? undefined),
      limite: TAMANHO_PAGINA_EVENTOS,
    },
  };
}

export function Eventos() {
  const [form, setForm] = useState<Formulario>(VAZIO);
  const { filtros, erro: erroFiltros } = useMemo(() => paraFiltros(form), [form]);
  const eventos = useEventos(filtros);
  const ativos = useAtivos();
  const carteiras = useCarteiras();
  const itens = eventos.data?.pages.flatMap((p) => p.itens) ?? [];

  const alterar = <K extends keyof Formulario>(k: K, v: Formulario[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const alternarTipo = (t: TipoEventoDto) =>
    alterar(
      'tipos',
      form.tipos.includes(t) ? form.tipos.filter((x) => x !== t) : [...form.tipos, t],
    );

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-semibold">Eventos</h2>
      <Seccao titulo="Filtros" id="titulo-filtros">
        <form className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Ativo
              <select
                value={form.ativo}
                onChange={(e) => alterar('ativo', e.target.value)}
                className={classeCampo}
              >
                <option value="">Todos</option>
                {ativos.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.ticker}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Carteira
              <select
                value={form.carteira}
                onChange={(e) => alterar('carteira', e.target.value)}
                className={classeCampo}
              >
                <option value="">Todas</option>
                {carteiras.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {nomeCarteira(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Desde (Lisboa)
              <input
                type="datetime-local"
                value={form.desde}
                onChange={(e) => alterar('desde', e.target.value)}
                className={classeCampo}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Até (Lisboa)
              <input
                type="datetime-local"
                value={form.ate}
                onChange={(e) => alterar('ate', e.target.value)}
                className={classeCampo}
              />
            </label>
          </div>
          <fieldset className="flex flex-wrap gap-3 text-sm">
            <legend className="mb-1 text-sm text-neutral-300">Tipos</legend>
            {TIPOS_EVENTO_API.map((t) => (
              <label key={t} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={form.tipos.includes(t)}
                  onChange={() => alternarTipo(t)}
                />
                {TIPOS_EVENTO_PT[t]}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={form.naoLidos}
                onChange={(e) => alterar('naoLidos', e.target.checked)}
              />
              Só não lidos
            </label>
            <button type="button" className={classeBotaoSecundario} onClick={() => setForm(VAZIO)}>
              Limpar filtros
            </button>
          </div>
          {erroFiltros && (
            <p role="alert" className="text-sm text-red-300">
              {erroFiltros}
            </p>
          )}
        </form>
      </Seccao>
      <Seccao titulo="Histórico" id="titulo-historico">
        {eventos.isPending ? (
          <Carregando texto="A carregar eventos…" />
        ) : eventos.isError ? (
          <CaixaErro erro={eventos.error} aoRepetir={() => void eventos.refetch()} />
        ) : itens.length === 0 ? (
          <Vazio>Nenhum evento com estes filtros.</Vazio>
        ) : (
          <>
            <ListaEventos eventos={itens} />
            {eventos.hasNextPage && (
              <button
                type="button"
                className={`${classeBotaoSecundario} mt-3`}
                onClick={() => void eventos.fetchNextPage()}
                disabled={eventos.isFetchingNextPage}
              >
                {eventos.isFetchingNextPage ? 'A carregar…' : 'Carregar mais'}
              </button>
            )}
          </>
        )}
      </Seccao>
    </div>
  );
}
