import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { tasks, requireTask } from '@fsa/catalog';
import { AssessmentSchema, HumanReviewSchema, RunSelectionSchema, RunSubmissionSchema, type Assessment, type HumanReview, type PreviewReport, type RunSelection, type RunSubmission } from '@fsa/contracts';
import { AttemptExistsError, IdempotencyConflictError } from '@fsa/runs';
import { createRunStore, defaultRunRoot } from '@fsa/runs';
import { dshJudgeOptionsFromEnvironment, summarizeRuns } from '@fsa/evaluation';
import { probeContainerRuntime, requirePinnedImage } from '@fsa/executor';
import { join } from 'node:path';
import { scoreAssessment } from '@fsa/core';
import { openStore } from './store.ts';
import { openRunEntry } from './runs.ts';

export interface AppOptions {
  runRoot?: string;
  submissionsRoot?: string | null;
  runToken?: string | null;
  profile?: 'local' | 'linux-container';
  image?: string | null;
  imageDigest?: string | null;
}

export function buildApp(databasePath = ':memory:', options: AppOptions = {}) {
  const runRoot = options.runRoot ?? (process.env.BENCH_RUN_DIR || defaultRunRoot);
  const app = Fastify({ bodyLimit: 262144, ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } } });
  const store = openStore(databasePath);
  const runToken = options.runToken ?? process.env.BENCH_RUN_TOKEN ?? null;
  const profile = options.profile ?? (process.env.BENCH_PROFILE === 'linux-container' ? 'linux-container' : 'local');
  const runs = openRunEntry({
    runRoot,
    submissionsRoot: options.submissionsRoot ?? process.env.BENCH_SUBMISSIONS_DIR ?? null,
    token: runToken,
    profile,
    image: options.image ?? process.env.BENCH_IMAGE ?? null,
    imageDigest: options.imageDigest ?? process.env.BENCH_IMAGE_DIGEST ?? null,
  });
  app.addHook('onClose', async () => { await runs.close(); store.close(); });
  const authorized = (provided: unknown): boolean => {
    if (typeof provided !== 'string' || runToken === null || runToken.trim() === '') return false;
    const actual = Buffer.from(provided);
    const expected = Buffer.from(runToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  let judgeConfigured = false;
  try { dshJudgeOptionsFromEnvironment(); judgeConfigured = true; } catch { /* 配置缺失由每次实际评审记录，不在 health 中暴露凭据。 */ }
  let isolationProbe = { available: false, reason: '未请求 Linux 容器档案。', checkedAt: 0 };
  const probeIsolation = () => {
    if (profile !== 'linux-container' || Date.now() - isolationProbe.checkedAt < 30000) return isolationProbe;
    try {
      const image = options.image ?? process.env.BENCH_IMAGE;
      const digest = options.imageDigest ?? process.env.BENCH_IMAGE_DIGEST;
      if (!image || !digest) throw new Error('未配置固定运行镜像。');
      const captureDir = join(runRoot, 'runtime-probe');
      const runtime = probeContainerRuntime({ captureDir, timeoutMs: 3000 });
      requirePinnedImage(runtime, image, digest, { captureDir, timeoutMs: 3000 });
      isolationProbe = { available: true, reason: '容器守护进程与固定镜像已验证。', checkedAt: Date.now() };
    } catch (error) { isolationProbe = { available: false, reason: error instanceof Error ? error.message : '容器不可用。', checkedAt: Date.now() }; }
    return isolationProbe;
  };

  app.get('/api/health', () => ({
    status: 'ok',
    phase: 'implementation',
    previewScoring: true,
    runEntry: runs.enabled,
    runProfile: profile,
    isolatedExecution: probeIsolation().available,
    isolationStatus: probeIsolation().reason,
    judgeConnected: false,
    judgeConfigured,
  }));
  app.get('/api/tasks', () => tasks);
  app.get('/api/previews', () => store.list());
  app.post<{ Body: Assessment }>('/api/previews', { schema: { body: AssessmentSchema } }, (request, reply) => {
    let report: PreviewReport;
    try {
      requireTask(request.body.taskId);
      report = { id: randomUUID(), createdAt: new Date().toISOString(), assessment: request.body, result: scoreAssessment(request.body) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '评分输入无效。' });
    }
    store.add(report);
    return reply.code(201).send(report);
  });

  // 正式运行入口：冻结候选快照并自动触发受控验证，需要来源令牌且只接受提交根目录内的候选。
  app.post<{ Body: RunSubmission }>('/api/runs', { schema: { body: RunSubmissionSchema } }, async (request, reply) => {
    if (!runs.enabled) return reply.code(503).send({ error: runs.disabledReason });
    const provided = request.headers['x-bench-token'];
    if (!authorized(provided)) {
      return reply.code(401).send({ error: '正式提交入口需要有效的 x-bench-token 头。' });
    }
    try {
      return reply.code(201).send(await runs.submit(request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : '提交失败。';
      return reply.code(error instanceof IdempotencyConflictError || error instanceof AttemptExistsError ? 409 : 400).send({ error: message });
    }
  });
  app.get('/api/runs', () => runs.list());
  app.post<{ Body: RunSelection }>('/api/summaries', { schema: { body: RunSelectionSchema } }, (request, reply) => {
    try { return summarizeRuns(createRunStore(runRoot), request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '无法汇总所选作答。' }); }
  });
  app.get<{ Params: { runId: string; attemptId: string } }>('/api/runs/:runId/:attemptId/detail', (request, reply) => {
    try { return runs.detail(request.params.runId, request.params.attemptId); }
    catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : '未找到运行详情。' }); }
  });
  app.get<{ Params: { runId: string; attemptId: string; artifactId: string } }>('/api/runs/:runId/:attemptId/artifacts/:artifactId', (request, reply) => {
    try {
      const bytes = runs.artifact(request.params.runId, request.params.attemptId, request.params.artifactId);
      return reply.type('application/octet-stream').header('content-disposition', 'attachment').send(bytes);
    } catch (error) { return reply.code(404).send({ error: error instanceof Error ? error.message : '未找到证据。' }); }
  });
  app.post<{ Params: { runId: string; attemptId: string } }>('/api/runs/:runId/:attemptId/cancel', (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '取消操作需要有效令牌。' });
    return { cancelled: runs.cancel(request.params.runId, request.params.attemptId) };
  });
  app.post<{ Params: { runId: string; attemptId: string } }>('/api/runs/:runId/:attemptId/retry', async (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '重试操作需要有效令牌。' });
    try { return await runs.retry(request.params.runId, request.params.attemptId); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '重试失败。' }); }
  });
  app.post<{ Params: { runId: string; attemptId: string } }>('/api/runs/:runId/:attemptId/review', async (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '重新评审需要有效令牌。' });
    try { return await runs.review(request.params.runId, request.params.attemptId); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '评审失败。' }); }
  });
  app.post<{ Params: { runId: string; attemptId: string }; Body: HumanReview }>('/api/runs/:runId/:attemptId/human-review', { schema: { body: HumanReviewSchema } }, async (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '人工复核需要有效令牌。' });
    try { return await runs.review(request.params.runId, request.params.attemptId, request.body); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '复核失败。' }); }
  });
  app.get<{ Params: { runId: string; attemptId: string } }>('/api/runs/:runId/:attemptId/report', (request, reply) => {
    let body: string;
    try {
      // 先取到内容再设置 content-type：出错时才能按 JSON 返回错误。
      body = runs.report(request.params.runId, request.params.attemptId);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : '未找到运行记录。' });
    }
    return reply.type('text/markdown; charset=utf-8').send(body);
  });
  app.get<{ Params: { runId: string; attemptId: string } }>('/api/runs/:runId/:attemptId', (request, reply) => {
    try {
      return runs.status(request.params.runId, request.params.attemptId);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : '未找到运行记录。' });
    }
  });
  return app;
}
