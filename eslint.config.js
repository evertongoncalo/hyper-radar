// Configuração ESLint (flat config) para todo o monorepo.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/build/',
      '**/coverage/',
      'playwright-report/',
      'test-results/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    ...reactHooks.configs.flat['recommended-latest'],
  },
  // Desativa regras que entram em conflito com o Prettier (tem de ser a última).
  prettier,
);
