import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import sample from '../../../examples/assessment.json';
import { exportWorkspace } from '../../../packages/tasks/src/index.ts';
import { buildApp } from './app.ts';

describe('API 与报告持久化', () => {
  it('保存计算后的预览，关闭后重新打开保留相同结果', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fsa-api-test-'));
    const path = join(directory, 'reports.sqlite');
    let app = buildApp(path);
    try {
      const created = await app.inject({ method: 'POST', url: '/api/previews', payload: sample });
      expect(created.statusCode).toBe(201);
      const report = created.json();
      expect(report.result).toMatchObject({ mode: 'preview', total: 85, functional: 45, quality: 40 });
      await app.close();
      app = buildApp(path);
      expect((await app.inject('/api/previews')).json()).toEqual([report]);
    } finally {
      await app.close();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-api-test-')) throw new Error('临时目录不在测试范围内。');
      rmSync(target, { recursive: true });
    }
  });
  it('拒绝未知题目、未知字段和数字字符串，并且不产生记录', async () => {
    const app = buildApp();
    try {
      for (const payload of [
        { ...sample, taskId: 'unknown' },
        { ...sample, official: true },
        { ...sample, functional: { ...sample.functional, behavior: { score: '100', evidence: ['demo-test'] } } },
      ]) expect((await app.inject({ method: 'POST', url: '/api/previews', payload })).statusCode).toBe(400);
      expect((await app.inject('/api/previews')).json()).toEqual([]);
    } finally { await app.close(); }
  });
});

describe('正式运行入口', () => {
  const submission = (candidateDirectory: string) => ({
    taskId: 'CACHE-02',
    candidateDirectory,
    idempotencyKey: `api-${Math.random().toString(16).slice(2, 12)}`,
    submittedBy: 'api-test',
    reason: 'operator-submit',
  });

  it('未配置提交根目录与令牌时不启用，并报告真实能力', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fsa-api-runs-off-'));
    const app = buildApp(':memory:', { runRoot: join(directory, 'runs') });
    try {
      expect((await app.inject('/api/health')).json()).toMatchObject({ runEntry: false, isolatedExecution: false, judgeConnected: false });
      expect((await app.inject({ method: 'POST', url: '/api/runs', payload: submission('candidate') })).statusCode).toBe(503);
      expect((await app.inject('/api/runs')).json()).toEqual([]);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('需要令牌、限制候选目录范围，并自动完成可用验证', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fsa-api-runs-'));
    const submissions = join(directory, 'submissions');
    const candidate = join(submissions, 'cache-02-defect');
    const app = buildApp(join(directory, 'reports.sqlite'), { runRoot: join(directory, 'runs'), submissionsRoot: submissions, runToken: 'secret-token' });
    try {
      exportWorkspace('CACHE-02', candidate);
      expect((await app.inject('/api/health')).json()).toMatchObject({ runEntry: true });

      expect((await app.inject({ method: 'POST', url: '/api/runs', payload: submission('cache-02-defect') })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/runs', headers: { 'x-bench-token': 'wrong' }, payload: submission('cache-02-defect') })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/runs', headers: { 'x-bench-token': 'secret-token' }, payload: submission('../outside') })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/runs', headers: { 'x-bench-token': 'secret-token' }, payload: submission('missing-directory') })).statusCode).toBe(400);

      const body = submission('cache-02-defect');
      const created = await app.inject({ method: 'POST', url: '/api/runs', headers: { 'x-bench-token': 'secret-token' }, payload: body });
      expect(created.statusCode).toBe(201);
      const status = created.json();
      expect(status).toMatchObject({ taskId: 'CACHE-02', phase: 'verified', classification: 'check-failed' });
      expect(status.scoring.mode).toBe('pending');
      expect(status.knownFailures.map((item: { id: string }) => item.id).sort()).toEqual([
        'public/retry-after-failure', 'public/sync-throw-becomes-rejection',
        'hidden/no-cache-of-rejected-attempt', 'hidden/retry-then-coalesce-again',
      ].sort());

      const queried = await app.inject(`/api/runs/${status.runId}/${status.attemptId}`);
      expect(queried.statusCode).toBe(200);
      expect(queried.json()).toEqual(status);
      expect((await app.inject('/api/runs')).json()).toHaveLength(1);
      expect((await app.inject('/api/runs/run-missing/attempt-missing')).statusCode).toBe(404);

      // 重复完成事件：同键同快照复用同一次冻结，不产生第二条记录
      const repeated = await app.inject({ method: 'POST', url: '/api/runs', headers: { 'x-bench-token': 'secret-token' }, payload: body });
      expect(repeated.json()).toMatchObject({ runId: status.runId, attemptId: status.attemptId, verifiedAt: status.verifiedAt });
      expect((await app.inject('/api/runs')).json()).toHaveLength(1);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
