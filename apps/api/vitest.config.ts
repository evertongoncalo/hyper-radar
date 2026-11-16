import { defineConfig } from 'vitest/config';

const limiar = { lines: 90, functions: 90, branches: 90, statements: 90 };

export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test/**',
        'src/**/__fixtures__/**',
        'src/**/__testes__/**',
        // Pontos de entrada, reexportações e scripts de linha de comando.
        'src/index.ts',
        'src/**/index.ts',
        'src/db/migrate.ts',
        'src/db/seed.ts',
      ],
      // Limiar mínimo aplicado ao cliente Hyperliquid, ao motor e ao serviço de análise.
      thresholds: {
        'src/hyperliquid/**': limiar,
        'src/motor/**': limiar,
        'src/analise/**': limiar,
      },
    },
  },
});
