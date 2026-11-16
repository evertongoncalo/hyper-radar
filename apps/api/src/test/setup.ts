import { vi } from 'vitest';

// Nenhum teste pode contactar a rede: qualquer `fetch` não injetado por mock falha de imediato.
vi.stubGlobal('fetch', (entrada: unknown) => {
  throw new Error(`fetch real bloqueado nos testes (pedido a ${String(entrada)}); injete um mock.`);
});
