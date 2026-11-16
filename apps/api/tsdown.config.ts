import { defineConfig } from 'tsdown';

// Gera um único bundle ESM para Node. O pacote `@hyper-radar/shared` é exportado
// como código-fonte TypeScript, por isso é incluído no bundle em vez de ficar externo.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  fixedExtension: false,
  deps: { alwaysBundle: ['@hyper-radar/shared'] },
});
