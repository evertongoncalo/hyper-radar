import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { reiniciarPreferencias } from '../lib/preferencias';
import { EventSourceFalso } from './eventSourceFalso';

beforeEach(() => {
  // Nada de rede real: EventSource falso e `fetch` que falha se não for mockado.
  EventSourceFalso.instancias = [];
  vi.stubGlobal('EventSource', EventSourceFalso);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('fetch não mockado neste teste');
    }),
  );
  try {
    localStorage.clear();
  } catch {
    // jsdom sem armazenamento: ignora.
  }
  reiniciarPreferencias();
});

// Desmonta os componentes entre testes para evitar fugas de DOM.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
