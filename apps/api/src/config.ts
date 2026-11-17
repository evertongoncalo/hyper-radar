import { z } from 'zod';
import { URL_BASE_OFICIAL } from './hyperliquid/transporte';
import { URL_OPENAI_OMISSAO } from './ia/cliente-openai';
import { MODELO_IA_OMISSAO } from './ia/custos';

const HOSTS_LOCAIS = new Set(['127.0.0.1', 'localhost']);

/**
 * URL base de um serviço externo (vazio = oficial). Só `https://`, ou `http://` para
 * 127.0.0.1/localhost (servidores falsos dos testes E2E); nunca HTTP em claro para fora.
 */
const urlServicoExterno = (nome: string, omissao: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? omissao : v))
    .pipe(
      z.url({ protocol: /^https?$/, error: `${nome}: URL inválido.` }).refine(
        (v) => {
          // O refine corre mesmo quando `z.url` já falhou: proteger o `new URL`.
          if (!URL.canParse(v)) return false;
          const u = new URL(v);
          return u.protocol === 'https:' || HOSTS_LOCAIS.has(u.hostname);
        },
        { error: `${nome}: só https:// ou http://127.0.0.1 / http://localhost.` },
      ),
    );

/** Variáveis de ambiente usadas pela API, validadas no arranque. */
const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Obrigatório: URL de ligação ao Postgres (postgres:// ou postgresql://).
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: 'DATABASE_URL tem de ser um URL postgres:// ou postgresql://',
  }),
  // Dias de retenção dos snapshots (eventos e relatórios IA não são apagados).
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  // Origens extra aceites em pedidos mutáveis (lista separada por vírgulas; omissão: Vite dev).
  ALLOWED_ORIGINS: z
    .string()
    .default('http://127.0.0.1:5173,http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== ''),
    )
    .pipe(z.array(z.url({ protocol: /^https?$/, error: 'ALLOWED_ORIGINS: origem inválida' }))),
  // Opcional: sem chave, a Análise IA fica indisponível mas a aplicação arranca. Nunca registar.
  OPENAI_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : v))
    .pipe(
      z.string().regex(/^\S+$/, { error: 'OPENAI_API_KEY não pode conter espaços.' }).nullable(),
    ),
  // Vazio = modelo por omissão (validado na página oficial de preços da OpenAI).
  OPENAI_MODEL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? MODELO_IA_OMISSAO : v))
    .pipe(
      z
        .string()
        .regex(/^[A-Za-z0-9._:-]{1,100}$/, { error: 'OPENAI_MODEL: nome de modelo inválido.' }),
    ),
  // URLs base das APIs externas (omissão: oficiais). Só para testes E2E com servidores falsos.
  HYPERLIQUID_API_URL: urlServicoExterno('HYPERLIQUID_API_URL', URL_BASE_OFICIAL),
  OPENAI_BASE_URL: urlServicoExterno('OPENAI_BASE_URL', URL_OPENAI_OMISSAO),
});

export type Config = z.infer<typeof configSchema>;

/** Lê e valida a configuração; lança um erro legível se algum valor for inválido. */
export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const resultado = configSchema.safeParse(env);
  if (!resultado.success) {
    throw new Error(`Configuração inválida:\n${z.prettifyError(resultado.error)}`);
  }
  return resultado.data;
}
