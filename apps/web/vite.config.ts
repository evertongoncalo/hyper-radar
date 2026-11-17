import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    proxy: {
      // Em desenvolvimento, os pedidos a /api seguem para a API local.
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/test/**', 'src/**/*.test.{ts,tsx}'],
      reporter: ['text-summary', 'text', 'html'],
      thresholds: {
        // Global (inclui componentes visuais) e mais exigente na lógica.
        lines: 80,
        statements: 80,
        functions: 75,
        branches: 70,
        'src/api/**': { lines: 90, statements: 90, functions: 90, branches: 85 },
        'src/lib/**': { lines: 90, statements: 90, functions: 90, branches: 80 },
        'src/hooks/**': { lines: 85, statements: 85, functions: 85, branches: 75 },
      },
    },
  },
});
