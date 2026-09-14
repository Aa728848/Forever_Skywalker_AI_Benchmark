import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';

const app = buildApp(process.env.BENCH_DB ?? fileURLToPath(new URL('../../../data/benchmark.sqlite', import.meta.url)));
const port = Number(process.env.BENCH_API_PORT ?? 4318);
await app.listen({ host: '127.0.0.1', port });
console.log(`Benchmark API: http://127.0.0.1:${port}/api/health`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
