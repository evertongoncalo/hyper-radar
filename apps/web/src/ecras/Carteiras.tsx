import {
  alterarCarteiraPedidoSchema,
  importacaoPedidoSchema,
  type CarteiraComAtivosDto,
  type ImportacaoResposta,
} from '@hyper-radar/shared';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router';
import { mensagemDeErro } from '../api/cliente';
import { api } from '../api/recursos';
import {
  CaixaErro,
  Carregando,
  classeBotaoPerigo,
  classeBotaoPrimario,
  classeBotaoSecundario,
  classeCampo,
  Endereco,
  Seccao,
  Vazio,
} from '../componentes/comuns';
import {
  useAlterarCarteira,
  useApagarCarteira,
  useCarteiras,
  useImportar,
} from '../hooks/consultas';
import { dataIsoLisboa, formatarDataHora, nomeCarteira } from '../lib/formatacao';

/** Descarrega `dados` como ficheiro JSON (Blob + ligação temporária). */
export function descarregarJson(dados: unknown, nome: string): void {
  const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Lê e valida um ficheiro de importação; devolve os dados ou a lista de problemas. */
export async function lerFicheiroImportacao(
  ficheiro: Blob,
): Promise<
  | { ok: true; dados: ReturnType<typeof importacaoPedidoSchema.parse> }
  | { ok: false; problemas: string[] }
> {
  let json: unknown;
  try {
    json = JSON.parse(await ficheiro.text());
  } catch {
    return { ok: false, problemas: ['O ficheiro não é JSON válido.'] };
  }
  const r = importacaoPedidoSchema.safeParse(json);
  if (r.success) return { ok: true, dados: r.data };
  return {
    ok: false,
    problemas: r.error.issues
      .slice(0, 10)
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
  };
}

function resumoImportacao(r: ImportacaoResposta): string[] {
  const linhas = [
    `${r.ativosCriados} ativo(s) criado(s)`,
    `${r.carteirasCriadas} carteira(s) criada(s)`,
    `${r.carteirasAtualizadas} carteira(s) atualizada(s)`,
    `${r.associacoesCriadas} associação(ões) criada(s)`,
    r.definicoesAtualizadas ? 'Definições atualizadas' : 'Definições mantidas',
  ];
  if (r.analisesReiniciadas.length) {
    linhas.push(`${r.analisesReiniciadas.length} análise(s) reiniciada(s)`);
  }
  return linhas;
}

function ExportarImportar() {
  const [aExportar, setAExportar] = useState(false);
  const [erroExportar, setErroExportar] = useState<string | null>(null);
  const [problemas, setProblemas] = useState<string[]>([]);
  const importar = useImportar();
  const entrada = useRef<HTMLInputElement>(null);

  const exportar = async () => {
    setAExportar(true);
    setErroExportar(null);
    try {
      const dados = await api.exportar();
      descarregarJson(dados, `hyperradar-${dataIsoLisboa(dados.exportadoEm)}.json`);
    } catch (e) {
      setErroExportar(mensagemDeErro(e));
    } finally {
      setAExportar(false);
    }
  };

  const aoEscolher = async (e: ChangeEvent<HTMLInputElement>) => {
    const ficheiro = e.target.files?.[0];
    e.target.value = '';
    if (!ficheiro) return;
    importar.reset();
    const r = await lerFicheiroImportacao(ficheiro);
    if (!r.ok) {
      setProblemas(r.problemas);
      return;
    }
    setProblemas([]);
    importar.mutate(r.dados);
  };

  return (
    <Seccao titulo="Exportar / importar" id="titulo-exportar">
      <p className="mb-2 text-sm text-neutral-400">
        Backup em JSON dos ativos, carteiras, associações e definições (sem snapshots nem eventos).
        A importação só acrescenta: nunca apaga. Carteiras novas reiniciam as análises afetadas.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={classeBotaoSecundario}
          onClick={() => void exportar()}
          disabled={aExportar}
        >
          {aExportar ? 'A exportar…' : 'Exportar JSON'}
        </button>
        <button
          type="button"
          className={classeBotaoSecundario}
          onClick={() => entrada.current?.click()}
          disabled={importar.isPending}
        >
          {importar.isPending ? 'A importar…' : 'Importar JSON'}
        </button>
        <input
          ref={entrada}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label="Ficheiro JSON a importar"
          onChange={(e) => void aoEscolher(e)}
        />
      </div>
      {erroExportar && (
        <p role="alert" className="mt-2 text-sm text-red-300">
          {erroExportar}
        </p>
      )}
      {(problemas.length > 0 || importar.isError) && (
        <div role="alert" className="mt-2 text-sm text-red-300">
          <p>Ficheiro rejeitado:</p>
          <ul className="list-disc pl-5">
            {importar.isError ? (
              <li>{mensagemDeErro(importar.error)}</li>
            ) : (
              problemas.map((p) => <li key={p}>{p}</li>)
            )}
          </ul>
        </div>
      )}
      {importar.isSuccess && (
        <div role="status" className="mt-2 text-sm text-emerald-300">
          <p>Importação concluída:</p>
          <ul className="list-disc pl-5">
            {resumoImportacao(importar.data).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </Seccao>
  );
}

function LinhaCarteira({ c }: { c: CarteiraComAtivosDto }) {
  const [editar, setEditar] = useState(false);
  const [alias, setAlias] = useState(c.alias ?? '');
  const [entidade, setEntidade] = useState(c.entidade ?? '');
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const alterar = useAlterarCarteira();
  const apagar = useApagarCarteira();

  const guardar = (e: FormEvent) => {
    e.preventDefault();
    const r = alterarCarteiraPedidoSchema.safeParse({ alias, entidade });
    if (!r.success) {
      setErroLocal(r.error.issues[0]?.message ?? 'Dados inválidos.');
      return;
    }
    setErroLocal(null);
    alterar.mutate({ id: c.id, pedido: r.data }, { onSuccess: () => setEditar(false) });
  };

  const pedirApagar = () => {
    const aviso =
      c.ativos.length > 0
        ? ` Está associada a ${c.ativos.length} ativo(s); as análises em curso serão reiniciadas.`
        : '';
    if (window.confirm(`Apagar a carteira ${nomeCarteira(c)}?${aviso}`)) apagar.mutate(c.id);
  };

  const erro =
    erroLocal ??
    (alterar.isError
      ? mensagemDeErro(alterar.error)
      : apagar.isError
        ? mensagemDeErro(apagar.error)
        : null);

  return (
    <tr className="border-t border-neutral-800 align-top">
      <td className="py-2 pr-3">
        <Endereco endereco={c.endereco} />
        <div className="text-xs text-neutral-500">
          Criada em <time dateTime={c.criadoEm}>{formatarDataHora(c.criadoEm)}</time>
        </div>
      </td>
      {editar ? (
        <td colSpan={2} className="py-2 pr-3">
          <form onSubmit={guardar} className="flex flex-wrap items-end gap-2" noValidate>
            <label className="flex flex-col text-xs">
              Alias
              <input
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                className={classeCampo}
              />
            </label>
            <label className="flex flex-col text-xs">
              Entidade
              <input
                value={entidade}
                onChange={(e) => setEntidade(e.target.value)}
                className={classeCampo}
              />
            </label>
            <button type="submit" className={classeBotaoPrimario} disabled={alterar.isPending}>
              Guardar
            </button>
            <button
              type="button"
              className={classeBotaoSecundario}
              onClick={() => {
                setEditar(false);
                setAlias(c.alias ?? '');
                setEntidade(c.entidade ?? '');
                setErroLocal(null);
                alterar.reset();
              }}
            >
              Cancelar
            </button>
          </form>
        </td>
      ) : (
        <>
          <td className="py-2 pr-3">{c.alias ?? <span className="text-neutral-500">—</span>}</td>
          <td className="py-2 pr-3">{c.entidade ?? <span className="text-neutral-500">—</span>}</td>
        </>
      )}
      <td className="py-2 pr-3">
        {c.ativos.length === 0 ? (
          <span className="text-neutral-500">Nenhum</span>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {c.ativos.map((a) => (
              <li key={a.id}>
                <Link to={`/ativos/${a.id}`} className="text-sky-400 hover:underline">
                  {a.ticker}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {erro && (
          <p role="alert" className="text-xs text-red-300">
            {erro}
          </p>
        )}
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        {!editar && (
          <button
            type="button"
            className={`${classeBotaoSecundario} mr-1`}
            onClick={() => setEditar(true)}
            aria-label={`Editar ${nomeCarteira(c)}`}
          >
            Editar
          </button>
        )}
        <button
          type="button"
          className={classeBotaoPerigo}
          onClick={pedirApagar}
          disabled={apagar.isPending}
          aria-label={`Apagar ${nomeCarteira(c)}`}
        >
          Apagar
        </button>
      </td>
    </tr>
  );
}

export function Carteiras() {
  const carteiras = useCarteiras();
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-semibold">Carteiras</h2>
      <Seccao titulo="Todas as carteiras" id="titulo-todas-carteiras">
        <p className="mb-2 text-xs text-amber-200">
          Apagar uma carteira reinicia a análise dos ativos a que está associada.
        </p>
        {carteiras.isPending ? (
          <Carregando texto="A carregar carteiras…" />
        ) : carteiras.isError ? (
          <CaixaErro erro={carteiras.error} aoRepetir={() => void carteiras.refetch()} />
        ) : carteiras.data.length === 0 ? (
          <Vazio>
            Ainda não há carteiras. Adicione-as no detalhe de um ativo ou importe um JSON.
          </Vazio>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs text-neutral-400">
                <tr>
                  <th scope="col" className="py-1 pr-3">
                    Endereço
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Alias
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Entidade
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Ativos
                  </th>
                  <th scope="col" className="py-1 text-right">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {carteiras.data.map((c) => (
                  <LinhaCarteira key={c.id} c={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Seccao>
      <ExportarImportar />
    </div>
  );
}
