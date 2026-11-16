import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Desmonta os componentes entre testes para evitar fugas de DOM.
afterEach(() => {
  cleanup();
});
