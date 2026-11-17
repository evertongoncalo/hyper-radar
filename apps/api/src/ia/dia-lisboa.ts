/*
 * Dia civil em `Europe/Lisbon` (limites diários da IA). Lisboa está em UTC+0 (inverno) ou UTC+1
 * (verão); as mudanças de hora são à 01:00 UTC, nunca à meia-noite local.
 */

export const FUSO_LISBOA = 'Europe/Lisbon';

const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_LISBOA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface Partes {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

function partes(ms: number): Partes {
  const p = Object.fromEntries(formatador.formatToParts(ms).map((x) => [x.type, x.value]));
  return {
    ano: Number(p['year']),
    mes: Number(p['month']),
    dia: Number(p['day']),
    hora: Number(p['hour']),
    minuto: Number(p['minute']),
    segundo: Number(p['second']),
  };
}

/** Desvio de Lisboa face a UTC no instante `ms`, em ms. */
function desvio(ms: number): number {
  const p = partes(ms);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUtc - Math.floor(ms / 1000) * 1000;
}

/** Meia-noite local (Lisboa) do dia civil `ano-mes-dia`, como instante UTC. */
function meiaNoite(ano: number, mes: number, dia: number): number {
  const base = Date.UTC(ano, mes - 1, dia);
  return base - desvio(base);
}

export interface DiaLisboa {
  /** `AAAA-MM-DD`. */
  dia: string;
  inicio: Date;
  /** Exclusivo (meia-noite do dia seguinte). */
  fim: Date;
}

/** Dia civil de Lisboa que contém o instante `ms`. */
export function diaLisboa(ms: number): DiaLisboa {
  const p = partes(ms);
  const dia = `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
  return {
    dia,
    inicio: new Date(meiaNoite(p.ano, p.mes, p.dia)),
    // `Date.UTC` normaliza o dia 32 → dia 1 do mês seguinte.
    fim: new Date(meiaNoite(p.ano, p.mes, p.dia + 1)),
  };
}
