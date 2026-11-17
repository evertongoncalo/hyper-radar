import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { relatorioValido } from './__testes__/auxiliares';
import { JSON_SCHEMA_RELATORIO, relatorioIaSchema } from './schema';

type No = Record<string, unknown>;

/** Percorre todos os subschemas (properties, items, anyOf). */
function* nos(s: No, caminho = '$'): Generator<[string, No]> {
  yield [caminho, s];
  for (const [k, v] of Object.entries((s['properties'] as Record<string, No>) ?? {})) {
    yield* nos(v, `${caminho}.${k}`);
  }
  if (s['items']) yield* nos(s['items'] as No, `${caminho}[]`);
  for (const [i, v] of ((s['anyOf'] as No[]) ?? []).entries()) yield* nos(v, `${caminho}|${i}`);
}

/** Chaves de objeto por caminho (normalizando o nulável `anyOf[obj, null]`). */
function chavesJson(s: No, caminho = '$', mapa = new Map<string, string[]>()) {
  const alvo = s['anyOf'] ? ((s['anyOf'] as No[]).find((x) => x['type'] === 'object') ?? s) : s;
  if (alvo['type'] === 'object') {
    const props = alvo['properties'] as Record<string, No>;
    mapa.set(caminho, Object.keys(props).sort());
    for (const [k, v] of Object.entries(props)) chavesJson(v, `${caminho}.${k}`, mapa);
  }
  if (alvo['type'] === 'array') chavesJson(alvo['items'] as No, `${caminho}[]`, mapa);
  return mapa;
}

describe('JSON Schema do relatório (Structured Outputs, strict)', () => {
  it('raiz é objeto sem anyOf; todos os objetos com todos os campos required e sem extras', () => {
    expect(JSON_SCHEMA_RELATORIO['type']).toBe('object');
    expect(JSON_SCHEMA_RELATORIO['anyOf']).toBeUndefined();
    let objetos = 0;
    for (const [caminho, s] of nos(JSON_SCHEMA_RELATORIO)) {
      if (s['type'] !== 'object') continue;
      objetos++;
      expect(s['additionalProperties'], caminho).toBe(false);
      expect([...(s['required'] as string[])].sort(), caminho).toEqual(
        Object.keys(s['properties'] as object).sort(),
      );
    }
    // Raiz, alinhamento, nível-chave, cenário e cenário de entrada.
    expect(objetos).toBe(5);
  });

  it('só usa palavras-chave suportadas e respeita os limites de profundidade', () => {
    const proibidas = ['allOf', 'not', 'if', 'then', 'else', 'oneOf', 'dependentRequired', '$ref'];
    for (const [caminho, s] of nos(JSON_SCHEMA_RELATORIO)) {
      for (const p of proibidas) expect(s[p], `${caminho}.${p}`).toBeUndefined();
      expect(caminho.split(/[.[|]/).length, caminho).toBeLessThanOrEqual(10);
    }
  });

  it('coerente com o zod: mesmas chaves em todos os níveis e mesmos enums', () => {
    const doZod = z.toJSONSchema(relatorioIaSchema) as No;
    expect(chavesJson(JSON_SCHEMA_RELATORIO)).toEqual(chavesJson(doZod));
    const enums = (s: No) =>
      [...nos(s)].flatMap(([, n]) => (n['enum'] ? [JSON.stringify(n['enum'])] : [])).sort();
    expect(enums(JSON_SCHEMA_RELATORIO)).toEqual(enums(doZod));
  });

  it('zod: aceita um relatório válido e o cenário nulo; rejeita extras, faltas e fora de intervalo', () => {
    expect(relatorioIaSchema.safeParse(relatorioValido()).success).toBe(true);
    expect(
      relatorioIaSchema.safeParse(relatorioValido({ cenario_entrada_sugerido: null })).success,
    ).toBe(true);
    const invalidos: unknown[] = [
      { ...relatorioValido(), extra: 1 },
      { ...relatorioValido(), confianca: 1.5 },
      { ...relatorioValido(), vies: 'subida' },
      { ...relatorioValido(), avisos: [] },
      Object.fromEntries(Object.entries(relatorioValido()).filter(([k]) => k !== 'resumo')),
    ];
    for (const v of invalidos) expect(relatorioIaSchema.safeParse(v).success).toBe(false);
  });
});
