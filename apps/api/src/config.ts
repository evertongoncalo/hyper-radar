import { z } from 'zod';
import { MODELO_IA_OMISSAO } from './ia/custos';

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
