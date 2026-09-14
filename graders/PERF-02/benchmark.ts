import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Row, RenderedRange, RenderWindow } from '../../tasks/core/PERF-02/starter/src/window.ts';

/** Trusted workload; run only inside the same controlled execution boundary as the candidate. */
const workspace = process.argv[2];
if (workspace === undefined) throw new Error('需要候选工作区路径。');
const now = process.hrtime.bigint.bind(process.hrtime);
const { updateRows } = await import(pathToFileURL(resolve(workspace, 'starter/src/window.ts')).href) as {
  updateRows(rows: readonly Row[], patch: Row, window: RenderWindow): RenderedRange;
};
const count = 80_000;
const size = 20;
const iterations = 4000;
const rows = Array.from({ length: count }, (_, index) => Object.freeze({ id: 'row-' + index, value: index }));
Object.freeze(rows);
const invoke = (iteration: number) => {
  const offset = (iteration * 97) % (count - size);
  const patch = { id: 'row-' + (offset + 7), value: -iteration - 1 };
  const result = updateRows(rows, patch, { offset, size });
  assert.equal(result.start, offset);
  assert.equal(result.end, offset + size);
  assert.equal(result.items.length, size);
  for (let index = 0; index < size; index += 1) {
    assert.equal(result.items[index]?.id, rows[offset + index]!.id);
    assert.equal(result.items[index]?.value, index === 7 ? patch.value : offset + index);
  }
};
for (let iteration = 0; iteration < 2; iteration += 1) invoke(iteration);
const started = now();
for (let iteration = 0; iteration < iterations; iteration += 1) invoke(iteration);
const durationMs = Number(now() - started) / 1e6;
console.log(JSON.stringify({ schemaVersion: '0.1.0', taskId: 'PERF-02', workloadVersion: '0.2.0',
  durationMs, peakRssBytes: process.resourceUsage().maxRSS * 1024, correctnessPassed: true,
  inputRows: count, windowSize: size, iterations, internalWarmups: 2,
  operationsPerSecond: iterations / (durationMs / 1000), includesStartupAndAssertions: false,
  includesSemanticAssertions: true, measurementTrust: 'in-process-diagnostic',
  note: '同进程计时与RSS为诊断；正式分数需要外部受信计时/资源采样及同机参考配对。此工作负载测窗口算法，真实DOM由浏览器检查另行验证。' }));
