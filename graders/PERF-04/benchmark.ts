import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SessionEvent, SessionSummary } from '../../tasks/core/PERF-04/starter/src/replay.ts';

/** Trusted workload; the frozen reference and candidate run in separate, identical environments. */
const workspace = process.argv[2];
if (workspace === undefined) throw new Error('需要候选工作区路径。');
const now = process.hrtime.bigint.bind(process.hrtime);
const { replaySession } = await import(pathToFileURL(resolve(workspace, 'starter/src/replay.ts')).href) as {
  replaySession(events: readonly SessionEvent[]): SessionSummary;
};
const count = 32_000;
const sessionCount = 2000;
const iterations = 12;
const payload = '重放🙂';
const events: readonly SessionEvent[] = Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
  id: 'event-' + index, at: index - count, kind: 'message' as const, session: 'session-' + String(index % sessionCount).padStart(4, '0'), payload,
})));
const expected: SessionSummary = { sessions: sessionCount, messages: count, bytes: count * Buffer.byteLength(payload),
  lastAt: -1, longestSession: { id: 'session-0000', messages: count / sessionCount } };
for (let iteration = 0; iteration < 2; iteration += 1) assert.deepEqual(replaySession(events), expected);
const started = now();
for (let iteration = 0; iteration < iterations; iteration += 1) assert.deepEqual(replaySession(events), expected);
const durationMs = Number(now() - started) / 1e6;
console.log(JSON.stringify({ schemaVersion: '0.1.0', taskId: 'PERF-04', workloadVersion: '0.2.0',
  durationMs, peakRssBytes: process.resourceUsage().maxRSS * 1024, correctnessPassed: true,
  inputEvents: count, sessionCount, iterations, internalWarmups: 2,
  eventsPerSecond: count * iterations / (durationMs / 1000), includesStartupAndAssertions: false,
  includesSemanticAssertions: true, measurementTrust: 'in-process-diagnostic',
  note: '同进程计时与RSS只能诊断；外部受信计时/资源采样与同机参考配对才可用于正式性能分。所有迭代必须满足完整摘要语义。' }));
