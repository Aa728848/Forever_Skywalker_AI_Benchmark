import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('./.cache/playwright', import.meta.url));

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4317', viewport: { width: 1440, height: 1080 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'node --import tsx apps/api/src/server.ts', url: 'http://127.0.0.1:4318/api/health', env: { BENCH_DB: ':memory:' }, reuseExistingServer: false },
    { command: 'node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 4317 --strictPort', url: 'http://127.0.0.1:4317', reuseExistingServer: false },
  ],
});
