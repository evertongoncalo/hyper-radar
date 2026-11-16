import { eq } from 'drizzle-orm';
import { settings, type NovasSettings, type Settings } from '../db/schema';
import { decimalParaNumero, numeroParaDecimal, type Executor } from './comum';
import { comTraducao } from './erros';

export interface Definicoes {
  /** Capital disponível para a sugestão proporcional, em USD. */
  capitalUsd: number;
  alavancagemMaxima: number;
  /** Risco máximo por operação, em % do capital (ex.: 1 = 1 %). */
  riscoPorOperacaoPct: number;
  intervaloRecolhaSegundos: number;
  limiteDiarioChamadasIa: number;
  limiteDiarioTokensIa: number;
  atualizadoEm: Date;
}

export type AlteracaoDefinicoes = Partial<Omit<Definicoes, 'atualizadoEm'>>;

/** Linha única das definições (`settings_single_row`). */
const ID = 1;

function paraDefinicoes(l: Settings): Definicoes {
  return {
    capitalUsd: decimalParaNumero(l.capitalUsd),
    alavancagemMaxima: l.maxLeverage,
    riscoPorOperacaoPct: decimalParaNumero(l.riskPerTradePct),
    intervaloRecolhaSegundos: l.pollIntervalSeconds,
    limiteDiarioChamadasIa: l.aiDailyCallLimit,
    limiteDiarioTokensIa: l.aiDailyTokenLimit,
    atualizadoEm: l.updatedAt,
  };
}

/** Devolve as definições, criando a linha única com as omissões se ainda não existir. */
export async function obterDefinicoes(db: Executor): Promise<Definicoes> {
  await db.insert(settings).values({ id: ID }).onConflictDoNothing();
  const [linha] = await db.select().from(settings).where(eq(settings.id, ID));
  return paraDefinicoes(linha!);
}

/** Atualiza parcialmente as definições; valores fora dos limites dão `ErroRestricaoViolada`. */
export async function atualizarDefinicoes(
  db: Executor,
  alteracao: AlteracaoDefinicoes,
): Promise<Definicoes> {
  const v: Partial<NovasSettings> = {};
  if (alteracao.capitalUsd !== undefined) v.capitalUsd = numeroParaDecimal(alteracao.capitalUsd);
  if (alteracao.alavancagemMaxima !== undefined) v.maxLeverage = alteracao.alavancagemMaxima;
  if (alteracao.riscoPorOperacaoPct !== undefined)
    v.riskPerTradePct = numeroParaDecimal(alteracao.riscoPorOperacaoPct);
  if (alteracao.intervaloRecolhaSegundos !== undefined)
    v.pollIntervalSeconds = alteracao.intervaloRecolhaSegundos;
  if (alteracao.limiteDiarioChamadasIa !== undefined)
    v.aiDailyCallLimit = alteracao.limiteDiarioChamadasIa;
  if (alteracao.limiteDiarioTokensIa !== undefined)
    v.aiDailyTokenLimit = alteracao.limiteDiarioTokensIa;

  if (Object.keys(v).length === 0) return obterDefinicoes(db);
  // Upsert: cria a linha com as omissões + alterações, ou atualiza só os campos indicados.
  const [linha] = await comTraducao(() =>
    db
      .insert(settings)
      .values({ id: ID, ...v })
      .onConflictDoUpdate({ target: settings.id, set: { ...v, updatedAt: new Date() } })
      .returning(),
  );
  return paraDefinicoes(linha!);
}
