import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('./.cache/playwright', import.meta.url));
process.env.BENCH_E2E_ROOT ??= mkdtempSync(join(tmpdir(), 'fsa-e2e-'));
process.env.BENCH_E2E_TOKEN ??= randomUUID();

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  globalTeardown: './tests/e2e/teardown.ts',
  use: { baseURL: 'http://127.0.0.1:4317', viewport: { width: 1440, height: 1080 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'node --import tsx apps/api/src/server.ts', url: 'http://127.0.0.1:4318/api/health', env: { BENCH_DB: ':memory:', BENCH_RUN_DIR: join(process.env.BENCH_E2E_ROOT, 'runs'), BENCH_SUBMISSIONS_DIR: process.env.BENCH_E2E_ROOT, BENCH_RUN_TOKEN: process.env.BENCH_E2E_TOKEN, BENCH_PROFILE: 'local', BENCH_JUDGE_ENDPOINT: '', BENCH_JUDGE_TOKEN: '', BENCH_MEASURE_PERFORMANCE: '0' }, reuseExistingServer: false },
    { command: 'node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 4317 --strictPort', url: 'http://127.0.0.1:4317', reuseExistingServer: false },
  ],
});
