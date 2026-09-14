import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    env: { BENCH_JUDGE_ENDPOINT: '', BENCH_JUDGE_MODEL: '', BENCH_JUDGE_TOKEN: '', BENCH_MEASURE_PERFORMANCE: '0', BENCH_RUN_TOKEN: '', BENCH_SUBMISSIONS_DIR: '', BENCH_PROFILE: 'local' },
  },
});
