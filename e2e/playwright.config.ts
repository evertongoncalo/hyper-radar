import { defineConfig, devices } from '@playwright/test';
import { URL_API } from './configuracao';

// E2E de fumo (secção 11): app compilada + base `*_e2e` + servidor falso (Hyperliquid/OpenAI).
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  // Um ciclo de polling (mínimo 15 s) cabe com folga.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // Uma só API e uma só base: testes em série.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  outputDir: '../test-results',
  reporter: [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  use: {
    baseURL: URL_API,
    headless: true,
    locale: 'pt-PT',
    timezoneId: 'Europe/Lisbon',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
