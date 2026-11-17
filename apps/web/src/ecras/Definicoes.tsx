import {
  camposDefinicoesSchema,
  INTERVALO_RECOLHA_MINIMO_S,
  type AlterarDefinicoesPedido,
  type DefinicoesDto,
} from '@hyper-radar/shared';
import { useState, type FormEvent } from 'react';
import { ErroApi, mensagemDeErro } from '../api/cliente';
import {
  CaixaErro,
  Carregando,
  classeBotaoPrimario,
  classeBotaoSecundario,
  classeCampo,
  Seccao,
} from '../componentes/comuns';
import { useAlterarDefinicoes, useDefinicoes } from '../hooks/consultas';
import { usePermissaoNotificacoes, usePreferencias } from '../hooks/locais';
import { formatarDataHora } from '../lib/formatacao';

type Campo = Exclude<keyof DefinicoesDto, 'atualizadoEm'>;

const CAMPOS: { campo: Campo; rotulo: string; ajuda: string }[] = [
  { campo: 'capitalUsd', rotulo: 'Capital (USD)', ajuda: 'Base da sugestão proporcional.' },
  { campo: 'alavancagemMaxima', rotulo: 'Alavancagem máxima', ajuda: 'Inteiro entre 1 e 100.' },
  {
    campo: 'riscoPorOperacaoPct',
    rotulo: 'Risco por operação (%)',
    ajuda: 'Percentagem do capital, maior do que 0.',
  },
  {
    campo: 'intervaloRecolhaSegundos',
    rotulo: 'Intervalo de recolha (s)',
    ajuda: `Mínimo ${INTERVALO_RECOLHA_MINIMO_S} s (limites da Hyperliquid).`,
  },
  { campo: 'limiteDiarioChamadasIa', rotulo: 'Limite diário de chamadas IA', ajuda: '0 desativa.' },
  { campo: 'limiteDiarioTokensIa', rotulo: 'Limite diário de tokens IA', ajuda: '0 desativa.' },
];

type Valores = Record<Campo, string>;
type Erros = Partial<Record<Campo, string>>;

/** Texto do campo → número (aceita vírgula decimal); vazio → `NaN` (rejeitado pelo schema). */
export function lerNumero(texto: string): number {
  const t = texto.trim().replace(/\s/g, '').replace(',', '.');
  return t === '' ? Number.NaN : Number(t);
}

/** Valida o formulário com o schema partilhado; devolve só os campos alterados. */
export function validarDefinicoes(
  valores: Valores,
  atuais: DefinicoesDto,
): { ok: true; alteracoes: AlterarDefinicoesPedido } | { ok: false; erros: Erros } {
  const numeros = Object.fromEntries(CAMPOS.map(({ campo }) => [campo, lerNumero(valores[campo])]));
  const r = camposDefinicoesSchema.safeParse(numeros);
  if (!r.success) {
    const erros: Erros = {};
    for (const i of r.error.issues) {
      const c = i.path[0] as Campo;
      erros[c] ??= i.message;
    }
    return { ok: false, erros };
  }
  const alteracoes: AlterarDefinicoesPedido = {};
  for (const { campo } of CAMPOS) {
    if (r.data[campo] !== atuais[campo]) alteracoes[campo] = r.data[campo];
  }
  return { ok: true, alteracoes };
}

function FormularioDefinicoes({ atuais }: { atuais: DefinicoesDto }) {
  const [valores, setValores] = useState<Valores>(
    () => Object.fromEntries(CAMPOS.map(({ campo }) => [campo, String(atuais[campo])])) as Valores,
  );
  const [erros, setErros] = useState<Erros>({});
  const [mensagem, setMensagem] = useState<string | null>(null);
  const alterar = useAlterarDefinicoes();

  const submeter = (e: FormEvent) => {
    e.preventDefault();
    setMensagem(null);
    const r = validarDefinicoes(valores, atuais);
    if (!r.ok) {
      setErros(r.erros);
      return;
    }
    setErros({});
    if (Object.keys(r.alteracoes).length === 0) {
      setMensagem('Sem alterações para guardar.');
      return;
    }
    alterar.mutate(r.alteracoes, {
      onSuccess: () => setMensagem('Definições guardadas.'),
      onError: (erro) => {
        // Problemas por campo devolvidos pela API (`body.campo`).
        if (erro instanceof ErroApi) {
          const porCampo: Erros = {};
          for (const p of erro.problemas) {
            const c = p.caminho.replace(/^body\./, '') as Campo;
            if (CAMPOS.some((x) => x.campo === c)) porCampo[c] ??= p.mensagem;
          }
          setErros(porCampo);
        }
      },
    });
  };

  return (
    <form onSubmit={submeter} noValidate className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {CAMPOS.map(({ campo, rotulo, ajuda }) => {
          const erro = erros[campo];
          return (
            <div key={campo} className="flex flex-col gap-1 text-sm">
              <label htmlFor={`def-${campo}`}>{rotulo}</label>
              <input
                id={`def-${campo}`}
                inputMode="decimal"
                value={valores[campo]}
                onChange={(e) => setValores((v) => ({ ...v, [campo]: e.target.value }))}
                className={classeCampo}
                aria-invalid={erro ? true : undefined}
                aria-describedby={`ajuda-${campo}${erro ? ` erro-${campo}` : ''}`}
              />
              <span id={`ajuda-${campo}`} className="text-xs text-neutral-500">
                {ajuda}
              </span>
              {erro && (
                <span id={`erro-${campo}`} role="alert" className="text-xs text-red-300">
                  {erro}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span>Modelo de IA</span>
        <span className="text-neutral-400">
          Configurado no servidor; escolha disponível na Fase 6.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={classeBotaoPrimario} disabled={alterar.isPending}>
          {alterar.isPending ? 'A guardar…' : 'Guardar definições'}
        </button>
        <span className="text-xs text-neutral-500">
          Atualizado em{' '}
          <time dateTime={atuais.atualizadoEm}>{formatarDataHora(atuais.atualizadoEm)}</time>
        </span>
      </div>
      {alterar.isError && (
        <p role="alert" className="text-sm text-red-300">
          {mensagemDeErro(alterar.error)}
        </p>
      )}
      {mensagem && (
        <p role="status" className="text-sm text-emerald-300">
          {mensagem}
        </p>
      )}
    </form>
  );
}

const PERMISSAO_PT = {
  granted: 'Permitidas',
  denied: 'Bloqueadas no browser (é usado o aviso dentro da app)',
  default: 'Ainda não pedidas',
  indisponivel: 'Não suportadas por este browser (é usado o aviso dentro da app)',
} as const;

function PreferenciasNotificacoes() {
  const [prefs, alterar] = usePreferencias();
  const [permissao, pedir] = usePermissaoNotificacoes();
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p
        className="rounded-md border border-amber-800 bg-amber-950/40 p-2 text-amber-100"
        role="note"
      >
        Sem esta aba aberta não há notificações (não é usado Web Push).
      </p>
      <p>
        Notificações do sistema: <strong>{PERMISSAO_PT[permissao]}</strong>
      </p>
      {permissao === 'default' && (
        <div>
          <button type="button" className={classeBotaoSecundario} onClick={() => void pedir()}>
            Ativar notificações do sistema
          </button>
        </div>
      )}
      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={prefs.notificacoes}
          onChange={(e) => alterar({ notificacoes: e.target.checked })}
        />
        Mostrar notificações do sistema (quando permitidas)
      </label>
      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={prefs.som}
          onChange={(e) => alterar({ som: e.target.checked })}
        />
        Tocar som nos avisos dentro da app
      </label>
      <p className="text-xs text-neutral-500">
        Estas preferências ficam guardadas apenas neste browser.
      </p>
    </div>
  );
}

export function Definicoes() {
  const definicoes = useDefinicoes();
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-semibold">Definições</h2>
      <Seccao titulo="Análise e risco" id="titulo-analise-risco">
        {definicoes.isPending ? (
          <Carregando texto="A carregar definições…" />
        ) : definicoes.isError ? (
          <CaixaErro erro={definicoes.error} aoRepetir={() => void definicoes.refetch()} />
        ) : (
          <FormularioDefinicoes atuais={definicoes.data} />
        )}
      </Seccao>
      <Seccao titulo="Notificações e som" id="titulo-notificacoes">
        <PreferenciasNotificacoes />
      </Seccao>
    </div>
  );
}
