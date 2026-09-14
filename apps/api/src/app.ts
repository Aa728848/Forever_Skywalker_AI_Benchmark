import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { tasks, requireTask } from '@fsa/catalog';
import { AssessmentSchema, RunSubmissionSchema, type Assessment, type PreviewReport, type RunSubmission } from '@fsa/contracts';
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
  const app = Fastify({ bodyLimit: 262144, ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } } });
  const store = openStore(databasePath);
  const runToken = options.runToken ?? process.env.BENCH_RUN_TOKEN ?? null;
  const profile = options.profile ?? (process.env.BENCH_PROFILE === 'linux-container' ? 'linux-container' : 'local');
  const runs = openRunEntry({
    ...(options.runRoot === undefined ? {} : { runRoot: options.runRoot }),
    submissionsRoot: options.submissionsRoot ?? process.env.BENCH_SUBMISSIONS_DIR ?? null,
    token: runToken,
    profile,
    image: options.image ?? process.env.BENCH_IMAGE ?? null,
    imageDigest: options.imageDigest ?? process.env.BENCH_IMAGE_DIGEST ?? null,
  });
  app.addHook('onClose', () => store.close());

  app.get('/api/health', () => ({
    status: 'ok',
    phase: 'm1',
    previewScoring: true,
    runEntry: runs.enabled,
    runProfile: profile,
    isolatedExecution: profile === 'linux-container',
    judgeConnected: false,
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
    if (typeof provided !== 'string' || runToken === null || provided !== runToken) {
      return reply.code(401).send({ error: '正式提交入口需要有效的 x-bench-token 头。' });
    }
    try {
      return reply.code(201).send(await runs.submit(request.body));
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : '提交失败。';
      return reply.code(name === 'IdempotencyConflictError' || name === 'AttemptExistsError' ? 409 : 400).send({ error: message });
    }
  });
  app.get('/api/runs', () => runs.list());
  app.get<{ Params: { runId: string; attemptId: string } }>('/api/runs/:runId/:attemptId', (request, reply) => {
    try {
      return runs.status(request.params.runId, request.params.attemptId);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : '未找到运行记录。' });
    }
  });
  return app;
}
