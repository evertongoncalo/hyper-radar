import type { EstadoAtivoDto, TipoEventoDto } from '@hyper-radar/shared';

/** Fuso horário de toda a UI (secção 12). */
export const FUSO_HORARIO = 'Europe/Lisbon';
const LOCALE = 'pt-PT';

const formatoDataHora = new Intl.DateTimeFormat(LOCALE, {
  timeZone: FUSO_HORARIO,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const formatoData = new Intl.DateTimeFormat(LOCALE, {
  timeZone: FUSO_HORARIO,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const formatoPartes = new Intl.DateTimeFormat('en-GB', {
  timeZone: FUSO_HORARIO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const relativo = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

function paraData(valor: string | number | Date): Date {
  return valor instanceof Date ? valor : new Date(valor);
}

/** Data e hora em Lisboa, ex.: `17/11/2026, 14:03:05`. */
export function formatarDataHora(valor: string | number | Date): string {
  const d = paraData(valor);
  return Number.isNaN(d.getTime()) ? '—' : formatoDataHora.format(d);
}

/** Só a data em Lisboa, ex.: `17/11/2026`. */
export function formatarData(valor: string | number | Date): string {
  const d = paraData(valor);
  return Number.isNaN(d.getTime()) ? '—' : formatoData.format(d);
}

/** Partes numéricas de um instante no calendário de Lisboa. */
function partesLisboa(instante: number): {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
} {
  const p = Object.fromEntries(
    formatoPartes.formatToParts(new Date(instante)).map((x) => [x.type, x.value]),
  );
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour),
    minuto: Number(p.minute),
    segundo: Number(p.second),
  };
}

/** Desvio (ms) de Lisboa face a UTC no instante dado (0 no inverno, +1 h no verão). */
function desvioLisboa(instante: number): number {
  const p = partesLisboa(instante);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUtc - Math.floor(instante / 1000) * 1000;
}

/** Data `AAAA-MM-DD` no calendário de Lisboa (ex.: nome do ficheiro exportado). */
export function dataIsoLisboa(valor: string | number | Date): string {
  const p = partesLisboa(paraData(valor).getTime());
  const dd = (n: number) => String(n).padStart(2, '0');
  return `${p.ano}-${dd(p.mes)}-${dd(p.dia)}`;
}

/**
 * Converte o valor de um `<input type="datetime-local">` (hora de Lisboa, sem fuso) em ISO UTC.
 * Nas horas ambíguas/inexistentes da mudança de hora usa o primeiro desvio válido. `null` se
 * o texto for inválido.
 */
export function lisboaParaIso(valorLocal: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(valorLocal);
  if (!m) return null;
  const [, a, me, d, h, mi, s] = m;
  const comoUtc = Date.UTC(
    Number(a),
    Number(me) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  if (Number.isNaN(comoUtc)) return null;
  // Duas iterações chegam: o desvio só pode ser 0 ou +1 h.
  let instante = comoUtc - desvioLisboa(comoUtc);
  instante = comoUtc - desvioLisboa(instante);
  return new Date(instante).toISOString();
}

/** Tempo relativo, ex.: `há 2 minutos`. */
export function formatarRelativo(valor: string | number | Date, agora: number): string {
  const d = paraData(valor).getTime();
  if (Number.isNaN(d)) return '—';
  const s = Math.round((d - agora) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return relativo.format(s, 'second');
  if (abs < 3600) return relativo.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return relativo.format(Math.round(s / 3600), 'hour');
  return relativo.format(Math.round(s / 86_400), 'day');
}

const cacheNumeros = new Map<string, Intl.NumberFormat>();
function formatoNumero(opcoes: Intl.NumberFormatOptions): Intl.NumberFormat {
  const chave = JSON.stringify(opcoes);
  let f = cacheNumeros.get(chave);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { useGrouping: 'always', ...opcoes });
    cacheNumeros.set(chave, f);
  }
  return f;
}

const valido = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n);

/** Número em pt-PT com separador de milhares e até `casas` decimais. */
export function formatarNumero(n: number | null | undefined, casas = 2, minimo = 0): string {
  if (!valido(n)) return '—';
  return formatoNumero({
    maximumFractionDigits: casas,
    minimumFractionDigits: Math.min(minimo, casas),
  }).format(n);
}

/** Valor em dólares, ex.: `1 234 567 US$`; `casas` por omissão: 0 acima de 1000, senão 2. */
export function formatarUsd(n: number | null | undefined, casas?: number): string {
  if (!valido(n)) return '—';
  const c = casas ?? (Math.abs(n) >= 1000 ? 0 : 2);
  return formatoNumero({
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: c,
    minimumFractionDigits: c,
  }).format(n);
}

/** USD com sinal explícito (variações, PnL), ex.: `+1 200 US$`. */
export function formatarUsdComSinal(n: number | null | undefined, casas?: number): string {
  if (!valido(n)) return '—';
  const texto = formatarUsd(Math.abs(n), casas);
  if (n > 0) return `+${texto}`;
  if (n < 0) return `−${texto}`;
  return texto;
}

/** Casas decimais de um preço: ~5 algarismos significativos, entre 2 e 8 casas. */
export function casasPreco(preco: number): number {
  const abs = Math.abs(preco);
  if (abs === 0 || !Number.isFinite(abs)) return 2;
  const digitosInteiros = Math.floor(Math.log10(abs)) + 1;
  return Math.min(8, Math.max(2, 5 - digitosInteiros));
}

/** Preço com casas decimais adequadas à grandeza (BTC 2 casas, moedas pequenas mais). */
export function formatarPreco(n: number | null | undefined): string {
  if (!valido(n)) return '—';
  const c = casasPreco(n);
  return formatoNumero({ maximumFractionDigits: c, minimumFractionDigits: c }).format(n);
}

/** Tamanho em unidades do ativo (até 6 casas, sem zeros à direita). */
export function formatarTamanho(n: number | null | undefined): string {
  return formatarNumero(n, Math.abs(n ?? 0) >= 1000 ? 2 : 6);
}

/** Percentagem já em pontos percentuais, ex.: `12,35 %`. */
export function formatarPct(n: number | null | undefined, casas = 2): string {
  if (!valido(n)) return '—';
  return `${formatarNumero(n, casas)} %`;
}

/** Endereço abreviado, ex.: `0x1234…abcd`. */
export function abreviarEndereco(endereco: string): string {
  return endereco.length > 12 ? `${endereco.slice(0, 6)}…${endereco.slice(-4)}` : endereco;
}

/** Nome a mostrar de uma carteira: alias ou endereço curto. */
export function nomeCarteira(c: { alias: string | null; endereco: string }): string {
  return c.alias?.trim() ? c.alias : abreviarEndereco(c.endereco);
}

/** Tipos de evento traduzidos (notificações e feed). */
export const TIPOS_EVENTO_PT: Record<TipoEventoDto, string> = {
  OPENED: 'Abriu posição',
  CLOSED: 'Fechou',
  INCREASED: 'Aumentou',
  REDUCED: 'Reduziu',
  FLIPPED: 'Inverteu',
  SLTP_CHANGED: 'SL/TP alterado',
  LIQ_NEAR: 'Perto da liquidação',
};

export const ESTADOS_ATIVO_PT: Record<EstadoAtivoDto, string> = {
  idle: 'Inativo',
  running: 'Em análise',
  stopped: 'Parado',
  restarting: 'A reiniciar',
};

export const LADO_PT = { long: 'Long', short: 'Short' } as const;
