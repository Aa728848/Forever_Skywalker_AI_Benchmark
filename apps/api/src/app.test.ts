import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      expect(status.scoring).toMatchObject({ mode: 'local', quality: null, total: null });
      expect(status.scoring.functional).toBeGreaterThan(0);
      expect(status.knownFailures.map((item: { id: string }) => item.id).sort()).toEqual([
        'public/retry-after-failure', 'public/sync-throw-becomes-rejection',
        'hidden/no-cache-of-rejected-attempt', 'hidden/retry-then-coalesce-again',
      ].sort());

      const queried = await app.inject(`/api/runs/${status.runId}/${status.attemptId}`);
      expect(queried.statusCode).toBe(200);

      // 报告导出：Markdown 出口带检查结论、评分与证据
      const report = await app.inject(`/api/runs/${status.runId}/${status.attemptId}/report`);
      expect(report.statusCode).toBe(200);
      expect(report.headers['content-type']).toContain('text/markdown');
      expect(report.body).toContain('# 运行报告 CACHE-02');
      expect(report.body).toContain('public/retry-after-failure');
      expect(report.body).toContain('代码质量：待定');
      expect(report.body).toContain('`public.stdout`');
      expect((await app.inject('/api/runs/run-missing/attempt-missing/report')).statusCode).toBe(404);
      expect(queried.json()).toEqual(status);
      const detail = await app.inject(`/api/runs/${status.runId}/${status.attemptId}/detail`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().execution).toMatchObject({ isolation: 'none', environment: { profile: 'local', network: true } });
      expect(detail.json().events.some((event: { type: string }) => event.type === 'score.finalized')).toBe(true);
      expect((await app.inject(`/api/runs/${status.runId}/${status.attemptId}/artifacts/public.stdout`)).statusCode).toBe(200);
      expect((await app.inject(`/api/runs/${status.runId}/${status.attemptId}/artifacts/unknown`)).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/runs/${status.runId}/${status.attemptId}/review` })).statusCode).toBe(401);
      expect((await app.inject('/api/runs')).json()).toHaveLength(1);

      const sourcePath = join(candidate, 'starter', 'src', 'keyed-loader.ts');
      const source = readFileSync(sourcePath, 'utf8');
      writeFileSync(sourcePath, source + '\n// changed after first submission\n');
      expect((await app.inject({ method: 'POST', url: '/api/runs', headers: { 'x-bench-token': 'secret-token' }, payload: body })).statusCode).toBe(409);
      writeFileSync(sourcePath, source);

      const outside = join(directory, 'outside');
      exportWorkspace('CACHE-02', outside);
      symlinkSync(outside, join(submissions, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      expect((await app.inject({ method: 'POST', url: '/api/runs', headers: { 'x-bench-token': 'secret-token' }, payload: submission('escape') })).statusCode).toBe(400);
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
