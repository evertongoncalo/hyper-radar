import { and, count, desc, eq, gte, lt, sql, sum, type SQL } from 'drizzle-orm';
import { aiReports, type AiReport } from '../db/schema';
import { decimalOuNuloParaNumero, numeroOuNuloParaDecimal, type Executor } from './comum';
import { comTraducao, ErroValorInvalido } from './erros';

export interface RelatorioIaGravado {
  id: number;
  assetId: number;
  modelo: string;
  hashInput: string;
  /** Relatório já validado com zod antes de gravar. */
  resposta: Record<string, unknown>;
  tokensEntrada: number;
  tokensSaida: number;
  /** `null` = modelo sem preço conhecido. */
  custoEstimadoUsd: number | null;
  criadoEm: Date;
}

export interface NovoRelatorioIa {
  assetId: number;
  modelo: string;
  hashInput: string;
  resposta: Record<string, unknown>;
  tokensEntrada: number;
  tokensSaida: number;
  custoEstimadoUsd: number | null;
  criadoEm?: Date;
}

export interface UsoIa {
  chamadas: number;
  tokens: number;
  custoEstimadoUsd: number;
}

export const LIMITE_RELATORIOS_OMISSAO = 20;
export const LIMITE_RELATORIOS_MAXIMO = 100;

function paraRelatorio(l: AiReport): RelatorioIaGravado {
  return {
    id: l.id,
    assetId: l.assetId,
    modelo: l.model,
    hashInput: l.inputHash,
    resposta: l.response,
    tokensEntrada: l.inputTokens,
    tokensSaida: l.outputTokens,
    custoEstimadoUsd: decimalOuNuloParaNumero(l.estimatedCostUsd),
    criadoEm: l.createdAt,
  };
}

export async function gravarRelatorioIa(
  db: Executor,
  novo: NovoRelatorioIa,
): Promise<RelatorioIaGravado> {
  const [linha] = await comTraducao(() =>
    db
      .insert(aiReports)
      .values({
        assetId: novo.assetId,
        model: novo.modelo,
        inputHash: novo.hashInput,
        response: novo.resposta,
        inputTokens: novo.tokensEntrada,
        outputTokens: novo.tokensSaida,
        estimatedCostUsd: numeroOuNuloParaDecimal(novo.custoEstimadoUsd),
        ...(novo.criadoEm ? { createdAt: novo.criadoEm } : {}),
      })
      .returning(),
  );
  return paraRelatorio(linha!);
}

export async function obterRelatorioIa(
  db: Executor,
  id: number,
): Promise<RelatorioIaGravado | null> {
  const [linha] = await db.select().from(aiReports).where(eq(aiReports.id, id));
  return linha ? paraRelatorio(linha) : null;
}

/** Relatório mais recente do ativo com o mesmo hash de input e modelo (cache). */
export async function obterRelatorioIaEmCache(
  db: Executor,
  assetId: number,
  hashInput: string,
  modelo: string,
): Promise<RelatorioIaGravado | null> {
  const [linha] = await db
    .select()
    .from(aiReports)
    .where(
      and(
        eq(aiReports.assetId, assetId),
        eq(aiReports.inputHash, hashInput),
        eq(aiReports.model, modelo),
      ),
    )
    .orderBy(desc(aiReports.id))
    .limit(1);
  return linha ? paraRelatorio(linha) : null;
}

/** Histórico do ativo, do mais recente para o mais antigo, com cursor sobre o `id`. */
export async function listarRelatoriosIa(
  db: Executor,
  assetId: number,
  opcoes: { cursor?: number | null; limite?: number } = {},
): Promise<{ itens: RelatorioIaGravado[]; proximoCursor: number | null }> {
  const limite = opcoes.limite ?? LIMITE_RELATORIOS_OMISSAO;
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_RELATORIOS_MAXIMO) {
    throw new ErroValorInvalido(
      `o limite da página tem de ser um inteiro entre 1 e ${LIMITE_RELATORIOS_MAXIMO}.`,
    );
  }
  const cond: SQL[] = [eq(aiReports.assetId, assetId)];
  if (opcoes.cursor !== undefined && opcoes.cursor !== null) {
    cond.push(lt(aiReports.id, opcoes.cursor));
  }
  const linhas = await db
    .select()
    .from(aiReports)
    .where(and(...cond))
    .orderBy(desc(aiReports.id))
    .limit(limite + 1);
  const itens = linhas.slice(0, limite).map(paraRelatorio);
  return {
    itens,
    proximoCursor: linhas.length > limite ? (itens.at(-1)?.id ?? null) : null,
  };
}

/** Uso agregado (todos os ativos) no intervalo `[desde, ate)`: limites diários e estado. */
export async function somarUsoIa(db: Executor, desde: Date, ate: Date): Promise<UsoIa> {
  const [linha] = await db
    .select({
      chamadas: count(),
      tokens: sql<string | null>`sum(${aiReports.inputTokens} + ${aiReports.outputTokens})`,
      custo: sum(aiReports.estimatedCostUsd),
    })
    .from(aiReports)
    .where(and(gte(aiReports.createdAt, desde), lt(aiReports.createdAt, ate)));
  return {
    chamadas: linha?.chamadas ?? 0,
    tokens: Number(linha?.tokens ?? 0),
    custoEstimadoUsd: Number(linha?.custo ?? 0),
  };
}
