import { registerHooks } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export { setCompletion, completion } from './transport.mjs';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './caller.ts' && context.parentURL?.endsWith('/upstream/src/engine.ts')) return { shortCircuit: true, url: new URL('./transport.mjs', import.meta.url).href };
  return next(specifier, context);
} });
export const auto = await import(new URL('../starter/upstream/src/auto.ts', import.meta.url));
export const core = await import(new URL('../starter/upstream/src/core.ts', import.meta.url));
export const replay = await import(new URL('../starter/upstream/src/replay.ts', import.meta.url));
export const { VerifierEngine, partialStats } = await import(new URL('../starter/upstream/src/engine.ts', import.meta.url));
export const { ScoreCache, SingleFlight } = await import(new URL('../starter/upstream/src/cache.ts', import.meta.url));
export const policy = { mode: 'strict', minToolCalls: 1, maxPerTask: 2, maxPerSession: 8, threshold: 0.65 };
export function events() {
  return [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement and verify current snapshot' }] } },
    { seq: 2, type: 'tool/call', data: { callId: 'write-1', name: 'write', arguments: '{}' } },
    { seq: 3, type: 'tool/result', data: { message: { source: { callId: 'write-1' }, content: [{ type: 'text', text: 'written' }] } } },
  ];
}
export function reviewed(log, overrides = {}) {
  const verdict = { sessionId: 'session-local', fromSeq: 1, toSeq: 3, winner: 'A', score: 1, criteria: [{ id: 'correctness', score: 1 }], ...overrides };
  return [...log, { seq: 4, type: 'tool/call', data: { callId: 'judge-1', name: 'verifier_current_session', arguments: '{}' } },
    { seq: 5, type: 'tool/result', data: { message: { source: { callId: 'judge-1' }, content: [{ type: 'text', text: JSON.stringify(verdict) }] } } }];
}
export function editAfter(log, failed = false) {
  return [...log, { seq: 6, type: 'tool/call', data: { callId: 'write-2', name: 'write', arguments: '{}' } },
    { seq: 7, type: 'tool/result', data: { ...(failed ? { error: 'compile failed after write' } : {}), message: { source: { callId: 'write-2' }, content: [{ type: 'text', text: 'changed', isError: failed }] } } }];
}
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-int-verifier-'));
  const cache = new ScoreCache(join(directory, 'scores.json'), 8);
  const client = model => ({ provider: 'synthetic-local', model, maxTokens: 200, temperature: 0, timeoutMs: 1000, maxRetries: 0 });
  const compare = { problem: 'Review the exact current snapshot', candidateA: 'working implementation', candidateB: 'empty baseline', criteria: [{ id: 'correctness', name: 'Correctness', description: 'Matches current task', weight: 1 }], repeats: 1 };
  return { directory, cache, client, compare, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
