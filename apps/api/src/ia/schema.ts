import { relatorioIaSchema, type RelatorioIa } from '@hyper-radar/shared';

/*
 * Schema do relatório IA: o zod (partilhado com a web) valida SEMPRE a resposta antes de gravar;
 * o JSON Schema abaixo é o equivalente enviado à OpenAI (Structured Outputs, `strict: true`):
 * todos os campos em `required`, `additionalProperties: false` em todos os objetos, raiz objeto
 * sem `anyOf`, opcionalidade só via união com `null`. Os testes garantem a coerência entre os dois.
 */

export { relatorioIaSchema, type RelatorioIa };

/** Nome do schema no pedido (`text.format.name`). */
export const NOME_SCHEMA_RELATORIO = 'relatorio_ia_hyperradar';

type JsonSchema = Record<string, unknown>;

const texto = (descricao: string): JsonSchema => ({ type: 'string', description: descricao });
const prob = (descricao: string): JsonSchema => ({
  type: 'number',
  minimum: 0,
  maximum: 1,
  description: descricao,
});
const objeto = (propriedades: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties: propriedades,
  required: Object.keys(propriedades),
  additionalProperties: false,
});
const lista = (itens: JsonSchema, max: number, min = 0): JsonSchema => ({
  type: 'array',
  items: itens,
  ...(min > 0 ? { minItems: min } : {}),
  maxItems: max,
});

export const JSON_SCHEMA_RELATORIO: JsonSchema = objeto({
  resumo: texto('Resumo curto da situação, em português de Portugal.'),
  vies: {
    type: 'string',
    enum: ['alta', 'baixa', 'neutro', 'misto'],
    description: 'Viés agregado sugerido pelos dados.',
  },
  confianca: prob('Confiança na leitura, de 0 a 1.'),
  alinhamento_baleias: objeto({
    nivel: { type: 'string', enum: ['forte', 'moderado', 'fraco', 'divergente', 'sem_dados'] },
    descricao: texto('Até que ponto as carteiras estão alinhadas no mesmo lado.'),
  }),
  riscos: lista(texto('Risco identificado.'), 20),
  niveis_chave: lista(
    objeto({ preco: { type: 'number' }, descricao: texto('Porque é relevante.') }),
    20,
  ),
  cenarios: lista(
    objeto({
      nome: texto('Nome curto do cenário.'),
      probabilidade: prob('Probabilidade estimada, de 0 a 1.'),
      descricao: texto('Descrição condicional do cenário.'),
      gatilho: texto('O que confirmaria o cenário.'),
    }),
    10,
  ),
  cenario_entrada_sugerido: {
    anyOf: [
      objeto({
        lado: { type: 'string', enum: ['long', 'short'] },
        entrada: { type: 'number' },
        stop_loss: { type: 'number' },
        take_profit: { type: 'number' },
        justificacao: texto('Justificação condicional, sem garantias.'),
      }),
      { type: 'null' },
    ],
    description: 'Cenário hipotético de entrada, ou null se não fizer sentido.',
  },
  avisos: lista(texto('Aviso ou limitação.'), 20, 1),
});
