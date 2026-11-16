import { criarSchemaIsolado, prepararBaseTeste } from '../../db/teste-pg';
import { resolverUrlTeste } from '../../db/url-teste';

/** Ambiente comum aos testes de integração dos repositórios (schema isolado; skip sem Postgres). */
export const urlTeste = resolverUrlTeste();
export const disponivel = await prepararBaseTeste(urlTeste);

export const criarAmbiente = () => criarSchemaIsolado(urlTeste);

/** Endereço fictício óbvio: `0x` + zeros + o número em hexadecimal. */
export const enderecoFicticio = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
