import { z } from 'zod';

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
