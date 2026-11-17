import { AVISO_IA_NAO_ACONSELHAMENTO, type MercadoAtivo } from '@hyper-radar/shared';
import { pino, type Logger } from 'pino';
import type { AgregadosAtivo } from '../analise';
import type { Db } from '../db/client';
import { relogioSistema, type Relogio } from '../hyperliquid/relogio';
import {
  ErroNaoEncontrado,
  gravarRelatorioIa,
  listarCarteirasDoAtivo,
  listarEventos,
  obterAtivoPorId,
  obterDefinicoes,
  obterRelatorioIaEmCache,
  obterRunAtivo,
  somarUsoIa,
  ultimosSnapshotsPorCarteira,
  type RelatorioIaGravado,
  type UsoIa,
} from '../repositorios';
import type { GeradorIa } from './cliente-openai';
import { estimarCusto, precoDoModelo, PRECOS_MODELOS } from './custos';
import { diaLisboa } from './dia-lisboa';
import { construirEntrada, hashEntrada, MAX_EVENTOS_OMISSAO, type EntradaIa } from './entrada';
import { ErroIa, erroNaoConfigurada } from './erros';
import { INSTRUCOES_SISTEMA, mensagemDados, VERSAO_PROMPT } from './prompt';
import { JSON_SCHEMA_RELATORIO, NOME_SCHEMA_RELATORIO, relatorioIaSchema } from './schema';

/*
 * Análise IA por ativo (secção 7.2). SÓ por pedido manual do utilizador (rota POST): nada no
 * polling, no arranque nem no SSE chama este serviço.
 */

/** Teto de tokens de saída por chamada (inclui tokens de raciocínio). */
export const MAX_TOKENS_SAIDA_OMISSAO = 16_000;
const DIA_MS = 86_400_000;

/** Fontes de dados de que o serviço precisa (o `ServicoAnalise` e o cliente Hyperliquid servem). */
export interface FonteAgregados {
  obterAgregados(assetId: number): Promise<AgregadosAtivo>;
}

export interface FonteContextoMercado {
  metaAndAssetCtxs(dex?: string | null): Promise<MercadoAtivo[]>;
}

export interface OpcoesServicoIa {
  db: Db;
  analise: FonteAgregados;
  gerador: GeradorIa;
  modelo: string;
  /** Contexto de mercado (preço, funding, OI, volume); sem fonte, o bloco `mk` vai a `null`. */
  mercado?: FonteContextoMercado | null;
  relogio?: Relogio;
  logger?: Logger;
  maxTokensSaida?: number;
}

export interface ResultadoAnaliseIa {
  relatorio: RelatorioIaGravado;
  daCache: boolean;
  /** Custo desta operação (0 na cache; `null` se o modelo não tiver preço). */
  custoEstimadoUsd: number | null;
}

export interface EstadoServicoIa {
  configurada: boolean;
  modelo: string;
  modeloComPreco: boolean;
  hoje: UsoIa & { dia: string; limiteChamadas: number; limiteTokens: number };
}

/** Estimativa grosseira (≈ 4 caracteres por token) para não começar uma chamada já acima do limite. */
const estimarTokens = (texto: string) => Math.ceil(texto.length / 4);

export class ServicoIa {
  private readonly db: Db;
  private readonly analise: FonteAgregados;
  private readonly gerador: GeradorIa;
  private readonly mercado: FonteContextoMercado | null;
  private readonly relogio: Relogio;
  private readonly logger: Logger;
  private readonly maxTokensSaida: number;
  readonly modelo: string;
  /** Pedidos em curso por ativo (pedidos concorrentes partilham a mesma promessa). */
  private readonly emCurso = new Map<number, Promise<ResultadoAnaliseIa>>();
  /** Serializa verificação de limites + chamada + gravação entre ativos (limites exatos). */
  private fila: Promise<unknown> = Promise.resolve();
  /** Tokens gastos em chamadas sem relatório gravado (recusa/resposta inválida), por dia. */
  private usoNaoGravado: { dia: string; chamadas: number; tokens: number } | null = null;

  constructor(opcoes: OpcoesServicoIa) {
    this.db = opcoes.db;
    this.analise = opcoes.analise;
    this.gerador = opcoes.gerador;
    this.modelo = opcoes.modelo;
    this.mercado = opcoes.mercado ?? null;
    this.relogio = opcoes.relogio ?? relogioSistema;
    this.logger = opcoes.logger ?? pino({ enabled: false });
    this.maxTokensSaida = opcoes.maxTokensSaida ?? MAX_TOKENS_SAIDA_OMISSAO;
  }

  get configurada(): boolean {
    return this.gerador.configurado;
  }

  /**
   * Analisa o ativo: input → hash → cache (mesmo hash e modelo, salvo `forcar`) → limites
   * diários → OpenAI → validação zod → gravação. Pedidos concorrentes para o mesmo ativo
   * partilham o resultado.
   */
  analisar(assetId: number, opcoes: { forcar?: boolean } = {}): Promise<ResultadoAnaliseIa> {
    if (!this.configurada) return Promise.reject(erroNaoConfigurada());
    const existente = this.emCurso.get(assetId);
    if (existente) return existente;
    const promessa = this.executar(assetId, opcoes.forcar === true).finally(() => {
      this.emCurso.delete(assetId);
    });
    this.emCurso.set(assetId, promessa);
    return promessa;
  }

  async estado(): Promise<EstadoServicoIa> {
    const [uso, definicoes] = await Promise.all([this.usoHoje(), obterDefinicoes(this.db)]);
    return {
      configurada: this.configurada,
      modelo: this.modelo,
      modeloComPreco: precoDoModelo(this.modelo) !== null,
      hoje: {
        ...uso,
        limiteChamadas: definicoes.limiteDiarioChamadasIa,
        limiteTokens: definicoes.limiteDiarioTokensIa,
      },
    };
  }

  precos() {
    return PRECOS_MODELOS;
  }

  // ------------------------------------------------------------------ interno

  private async executar(assetId: number, forcar: boolean): Promise<ResultadoAnaliseIa> {
    const entrada = await this.construir(assetId);
    const hash = hashEntrada(entrada, VERSAO_PROMPT);
    if (!forcar) {
      const anterior = await obterRelatorioIaEmCache(this.db, assetId, hash, this.modelo);
      if (anterior) {
        this.logger.info({ assetId, relatorioId: anterior.id }, 'Análise IA servida da cache');
        return { relatorio: anterior, daCache: true, custoEstimadoUsd: 0 };
      }
    }
    return this.emFila(() => this.chamar(assetId, entrada, hash));
  }

  private emFila<T>(tarefa: () => Promise<T>): Promise<T> {
    const resultado = this.fila.then(tarefa);
    this.fila = resultado.catch(() => undefined);
    return resultado;
  }

  private async construir(assetId: number): Promise<EntradaIa> {
    const ativo = await obterAtivoPorId(this.db, assetId);
    if (!ativo) throw new ErroNaoEncontrado('Ativo', assetId);
    const agora = this.relogio.agora();
    const run = await obterRunAtivo(this.db, assetId);
    const [agregados, carteiras, definicoes, eventos, mercado] = await Promise.all([
      this.analise.obterAgregados(assetId),
      listarCarteirasDoAtivo(this.db, assetId),
      obterDefinicoes(this.db),
      listarEventos(this.db, {
        assetId,
        desde: new Date(agora - DIA_MS),
        limite: MAX_EVENTOS_OMISSAO,
      }),
      this.contextoMercado(ativo.dex, ativo.ticker),
    ]);
    // Mesmo critério dos agregados: o run atual; sem run, o último snapshot disponível.
    let snapshots = run
      ? await ultimosSnapshotsPorCarteira(this.db, assetId, { runId: run.id })
      : [];
    if (snapshots.length === 0) snapshots = await ultimosSnapshotsPorCarteira(this.db, assetId);
    return construirEntrada({
      ticker: ativo.ticker,
      agregados,
      carteiras,
      snapshots,
      eventos: eventos.itens,
      mercado,
      definicoes,
    });
  }

  private async contextoMercado(dex: string | null, ticker: string): Promise<MercadoAtivo | null> {
    if (!this.mercado) return null;
    try {
      const lista = await this.mercado.metaAndAssetCtxs(dex);
      return lista.find((m) => m.coin === ticker) ?? null;
    } catch (erro) {
      // Sem contexto de mercado a análise continua (o prompt indica dados em falta).
      this.logger.warn({ err: erro, ticker }, 'Contexto de mercado indisponível para a IA');
      return null;
    }
  }

  private async chamar(
    assetId: number,
    entrada: EntradaIa,
    hash: string,
  ): Promise<ResultadoAnaliseIa> {
    const mensagem = mensagemDados(entrada);
    await this.verificarLimites(estimarTokens(INSTRUCOES_SISTEMA) + estimarTokens(mensagem));

    let resposta;
    try {
      resposta = await this.gerador.gerar({
        modelo: this.modelo,
        instrucoes: INSTRUCOES_SISTEMA,
        entrada: mensagem,
        schema: { nome: NOME_SCHEMA_RELATORIO, schema: JSON_SCHEMA_RELATORIO },
        maxTokensSaida: this.maxTokensSaida,
      });
    } catch (erro) {
      if (erro instanceof ErroIa && erro.uso) {
        this.registarNaoGravado(erro.uso.tokensEntrada + erro.uso.tokensSaida);
      }
      this.logger.warn(
        { assetId, codigo: erro instanceof ErroIa ? erro.codigo : null },
        'Falha na chamada à OpenAI',
      );
      throw erro;
    }

    const uso = { tokensEntrada: resposta.tokensEntrada, tokensSaida: resposta.tokensSaida };
    const validado = relatorioIaSchema.safeParse(resposta.dados);
    if (!validado.success) {
      this.registarNaoGravado(uso.tokensEntrada + uso.tokensSaida);
      this.logger.warn({ assetId }, 'Relatório da OpenAI não respeita o schema');
      throw new ErroIa(
        'RESPOSTA_INVALIDA',
        'A resposta da OpenAI não respeita o formato do relatório.',
        { uso },
      );
    }
    const relatorio = validado.data;
    // O aviso de não-aconselhamento é obrigatório, mesmo que o modelo o omita.
    if (!relatorio.avisos.some((a) => /aconselhamento financeiro/i.test(a))) {
      relatorio.avisos.unshift(AVISO_IA_NAO_ACONSELHAMENTO);
    }

    const custo = estimarCusto(this.modelo, uso);
    if (custo === null) {
      this.logger.warn({ modelo: this.modelo }, 'Modelo sem preço conhecido: custo por estimar');
    }
    const gravado = await gravarRelatorioIa(this.db, {
      assetId,
      modelo: this.modelo,
      hashInput: hash,
      resposta: relatorio,
      ...uso,
      custoEstimadoUsd: custo,
      criadoEm: new Date(this.relogio.agora()),
    });
    this.logger.info(
      { assetId, relatorioId: gravado.id, ...uso, custoEstimadoUsd: custo },
      'Análise IA gravada',
    );
    return { relatorio: gravado, daCache: false, custoEstimadoUsd: custo };
  }

  private async verificarLimites(tokensEstimados: number): Promise<void> {
    const [uso, d] = await Promise.all([this.usoHoje(), obterDefinicoes(this.db)]);
    const sufixo = 'O contador reinicia à meia-noite (hora de Lisboa).';
    if (d.limiteDiarioChamadasIa > 0 && uso.chamadas >= d.limiteDiarioChamadasIa) {
      throw new ErroIa(
        'LIMITE_DIARIO',
        `Limite diário de ${d.limiteDiarioChamadasIa} análises IA atingido. ${sufixo}`,
      );
    }
    if (d.limiteDiarioTokensIa > 0 && uso.tokens + tokensEstimados > d.limiteDiarioTokensIa) {
      throw new ErroIa(
        'LIMITE_DIARIO',
        `Limite diário de ${d.limiteDiarioTokensIa} tokens IA atingido (usados hoje: ${uso.tokens}). ${sufixo}`,
      );
    }
  }

  private async usoHoje(): Promise<UsoIa & { dia: string }> {
    const hoje = diaLisboa(this.relogio.agora());
    const gravado = await somarUsoIa(this.db, hoje.inicio, hoje.fim);
    const extra = this.usoNaoGravado?.dia === hoje.dia ? this.usoNaoGravado : null;
    return {
      dia: hoje.dia,
      chamadas: gravado.chamadas + (extra?.chamadas ?? 0),
      tokens: gravado.tokens + (extra?.tokens ?? 0),
      custoEstimadoUsd: gravado.custoEstimadoUsd,
    };
  }

  private registarNaoGravado(tokens: number): void {
    const dia = diaLisboa(this.relogio.agora()).dia;
    const atual =
      this.usoNaoGravado?.dia === dia ? this.usoNaoGravado : { dia, chamadas: 0, tokens: 0 };
    this.usoNaoGravado = { dia, chamadas: atual.chamadas + 1, tokens: atual.tokens + tokens };
  }
}
