import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import Fastify, { type FastifyReply } from 'fastify';
import { tasks, requireTask } from '@fsa/catalog';
import { AssessmentSchema, HumanReviewSchema, RunSelectionSchema, RunSubmissionSchema, type Assessment, type HumanReview, type PreviewReport, type RunSelection, type RunSubmission } from '@fsa/contracts';
import { AttemptExistsError, IdempotencyConflictError } from '@fsa/runs';

import { createRunStore, defaultRunRoot } from '@fsa/runs';
import { createQualityProvider, discoverDshPresets, dshJudgeOptionsFromEnvironment, summarizeRuns } from '@fsa/evaluation';
import { probeContainerRuntime, requirePinnedImage } from '@fsa/executor';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scoreAssessment } from '@fsa/core';
import { openStore } from './store.ts';
import { openRunEntry } from './runs.ts';
import { ReportAccessError, defaultReportsRoot, openReports } from './reports.ts';
import { CleanupError } from './cleanup.ts';
import { ConfigValidationError, EnvironmentFileConflictError, apiRepositoryRoot, createConfigProvider, type ConfigFieldError } from './config.ts';
import { LaunchError, createLaunches, listSubmissionCandidates, type LaunchRequest } from './launches.ts';

export interface AppOptions {
  runRoot?: string;
  submissionsRoot?: string | null;
  runToken?: string | null;
  profile?: 'local' | 'linux-container';
  image?: string | null;
  imageDigest?: string | null;
  reportsRoot?: string;
  /** 项目根（.env 所在目录）；缺省为仓库根。测试指向系统临时目录。 */
  configRoot?: string;
  /** 配置的继承环境；缺省 process.env。测试注入以构造「被 OS 环境变量遮蔽」的场景。 */
  configEnv?: NodeJS.ProcessEnv;
  /** 预设目录发现实现；测试注入以覆盖「探测实现抛错」的降级路径，缺省读本地 DSH。 */
  configPresetDiscover?: typeof discoverDshPresets;
  /** 启动记录目录（<仓库根>/data/launches）；测试指向系统临时目录。 */
  launchesRoot?: string;
  /** supervisor 脚本路径；测试注入假脚本，绝不调用真实模型。 */
  supervisorScript?: string;
  /** 作答子进程脚本路径；测试注入假脚本。 */
  childScript?: string;
  /** supervisor 的 node 前置参数；测试注入假脚本时传 []。 */
  supervisorPrefix?: readonly string[];
  /** 托管轮询/等待的步进；测试可缩短。 */
  launchesPollMs?: number;
  /** 租约 TTL；测试可缩短以覆盖租约过期路径。 */
  launchesLeaseTtlMs?: number;
  /** 心跳间隔；测试可拉长，使「GET 前后账本字节不变」在确定性的时间窗内成立。 */
  launchesHeartbeatMs?: number;
  /** 取消后等待退出事实的时长；测试可缩短。 */
  launchesConfirmMs?: number;
  /** 启动后等待自登记握手的时长；测试可缩短。 */
  launchesRegistrationWaitMs?: number;
  /**
   * 对账 sweeper 的定时间隔（毫秒，默认 10000）。它只做对账、不由 GET 触发；
   * 测试把它调长，才能让「两次 GET 之间没有其它写者」成为确定性事实而不是运气。
   */
  launchesSweepMs?: number;
}

export function buildApp(databasePath = ':memory:', options: AppOptions = {}) {
  // 配置提供者：启动时读取一次 .env，之后每次保存成功后重算，因此改配置无需重启。
  const config = createConfigProvider({
    root: options.configRoot ?? apiRepositoryRoot, env: options.configEnv ?? process.env,
    ...(options.configPresetDiscover === undefined ? {} : { discoverPresets: options.configPresetDiscover }),
  });
  // runRoot 保持启动时固定：它决定既有 run 记录的物理位置，随配置改动会让历史记录消失。
  // 空白值按未配置处理（与改动前的 process.env.BENCH_RUN_DIR || defaultRunRoot 语义一致）。
  const configuredRunDir = config.current().BENCH_RUN_DIR;
  const runRoot = options.runRoot ?? (configuredRunDir !== undefined && configuredRunDir.trim() !== '' ? configuredRunDir : defaultRunRoot);
  // 报告标识是不透明 base64url，长度随报告根路径增长，默认 100 字符的路由参数上限会误判为过长。
  const app = Fastify({ bodyLimit: 262144, routerOptions: { maxParamLength: 512 }, ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } } });
  const store = openStore(databasePath);
  // 单次提交的 measure 覆盖：提交是操作者驱动的低频动作，用串行链保证覆盖不会串到并发请求上。
  let measureOverride: boolean | undefined;
  let submissionChain: Promise<unknown> = Promise.resolve();
  const runs = openRunEntry({
    runRoot,
    config,
    qualityProvider: env => createQualityProvider({ env, ...(measureOverride === undefined ? {} : { measurePerformance: measureOverride }) }),
    ...(options.submissionsRoot === undefined ? {} : { submissionsRoot: options.submissionsRoot }),
    ...(options.runToken === undefined ? {} : { token: options.runToken }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.image === undefined ? {} : { image: options.image }),
    ...(options.imageDigest === undefined ? {} : { imageDigest: options.imageDigest }),
  });
  // 报告中心只读：列出、读取与下载 CLI 已落盘的实验报告产物，不写入任何文件。
  // 报告根按操作取值，BENCH_DSH_REPORT_DIR 保存后立即生效。
  const reports = () => openReports({ root: options.reportsRoot ?? config.current().BENCH_DSH_REPORT_DIR ?? defaultReportsRoot });
  // 自动测评：API 只与受控 supervisor 打交道（API --spawn(detached)--> supervisor --spawn--> dsh-compare），
  // 绝不直接持有实验子进程。启动记录目录可注入，缺省 <仓库根>/data/launches。
  const launches = createLaunches({
    config,
    repositoryRoot: apiRepositoryRoot,
    ...(options.launchesRoot === undefined ? {} : { launchesRoot: options.launchesRoot }),
    ...(options.supervisorScript === undefined ? {} : { supervisorScript: options.supervisorScript }),
    ...(options.childScript === undefined ? {} : { childScript: options.childScript }),
    ...(options.supervisorPrefix === undefined ? {} : { supervisorPrefix: options.supervisorPrefix }),
    ...(options.launchesPollMs === undefined ? {} : { pollMs: options.launchesPollMs }),
    ...(options.launchesLeaseTtlMs === undefined ? {} : { leaseTtlMs: options.launchesLeaseTtlMs }),
    ...(options.launchesHeartbeatMs === undefined ? {} : { heartbeatMs: options.launchesHeartbeatMs }),
    ...(options.launchesConfirmMs === undefined ? {} : { confirmMs: options.launchesConfirmMs }),
    ...(options.launchesRegistrationWaitMs === undefined ? {} : { registrationWaitMs: options.launchesRegistrationWaitMs }),
  });
  // 对账 sweeper：API 启动时先跑一次，之后按固定间隔对账。GET /api/experiments 绝不触发它。
  launches.sweep();
  const sweeper = setInterval(() => { launches.sweep(); }, options.launchesSweepMs ?? 10000);
  sweeper.unref();
  app.addHook('onClose', async () => { clearInterval(sweeper); launches.close(); await runs.close(); store.close(); });
  // 令牌按操作取值：BENCH_RUN_TOKEN 保存后立即生效，不需重启。
  const authorized = (provided: unknown): boolean => {
    const runToken = runs.token();
    if (typeof provided !== 'string' || runToken === null || runToken.trim() === '') return false;
    const actual = Buffer.from(provided);
    const expected = Buffer.from(runToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const judgeConfigured = (): boolean => {
    try { dshJudgeOptionsFromEnvironment(config.current()); return true; } catch { return false; }
  };
  let isolationProbe = { available: false, reason: '未请求 Linux 容器档案。', checkedAt: 0, profile: 'local' };
  const probeIsolation = () => {
    const profile = runs.profile();
    if (profile !== 'linux-container') return { available: false, reason: '未请求 Linux 容器档案。', checkedAt: isolationProbe.checkedAt };
    if (isolationProbe.profile === profile && Date.now() - isolationProbe.checkedAt < 30000) return isolationProbe;
    try {
      const image = runs.image();
      const digest = runs.imageDigest();
      if (!image || !digest) throw new Error('未配置固定运行镜像。');
      const captureDir = join(runRoot, 'runtime-probe');
      const runtime = probeContainerRuntime({ captureDir, timeoutMs: 3000 });
      requirePinnedImage(runtime, image, digest, { captureDir, timeoutMs: 3000 });
      isolationProbe = { available: true, reason: '容器守护进程与固定镜像已验证。', checkedAt: Date.now(), profile };
    } catch (error) { isolationProbe = { available: false, reason: error instanceof Error ? error.message : '容器不可用。', checkedAt: Date.now(), profile }; }
    return isolationProbe;
  };

  app.get('/api/health', () => ({
    status: 'ok',
    phase: 'implementation',
    previewScoring: true,
    runEntry: runs.enabled(),
    runProfile: runs.profile(),
    isolatedExecution: probeIsolation().available,
    isolationStatus: probeIsolation().reason,
    judgeConnected: false,
    judgeConfigured: judgeConfigured(),
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

  // 配置：读取掩码视图、读取本地模型目录、写入 .env。
  // GET 只读不要求令牌；写操作一律要求 x-bench-token（复用 authorized）。
  app.get('/api/config', () => config.view());
  app.get('/api/config/models', async () => {
    // 预设目录与模型目录同源但相互独立：任一方失败都只影响自己的字段，不让整条路由 500。
    let presets: ReturnType<typeof config.presets>;
    try { presets = config.presets(); }
    catch (error) {
      presets = { presets: [], warning: '无法读取本地 DSH 预设目录：' + (error instanceof Error ? error.message : '未知原因') + '；请沿用内置的 standard、ptc、minimal、cordis。' };
    }
    try {
      const catalog = await config.models();
      return { providers: catalog.providers, warning: catalog.warning, presets: presets.presets, presetsWarning: presets.warning };
    } catch (error) {
      // 目录发现失败返回空目录与原因，而不是 500：前端保留手工输入入口。
      return { providers: [], warning: '无法读取本地 DSH 模型目录：' + (error instanceof Error ? error.message : '未知原因') + '；请手工填写供应商 ID 和模型 ID。', presets: presets.presets, presetsWarning: presets.warning };
    }
  });
  app.post<{ Body: { patch?: unknown; confirm?: unknown } }>('/api/config', (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '修改配置需要有效的 x-bench-token 头。' });
    const body = request.body;
    const raw = typeof body === 'object' && body !== null ? (body as { patch?: unknown }).patch : undefined;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reply.code(400).send({ error: '请求体必须形如 { patch: { KEY: "值" }, confirm: true }。' });
    const patch: Record<string, string | undefined> = {};
    const typeErrors: ConfigFieldError[] = [];
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      // JSON 无法表达 undefined：null 与缺省一律表示「不设置」；空字符串会被校验层按「清空」拒绝。
      if (value === undefined || value === null) patch[field] = undefined;
      else if (typeof value === 'string') patch[field] = value;
      else typeErrors.push({ field, message: '值必须是字符串。' });
    }
    if (typeErrors.length > 0) return reply.code(400).send({ error: '配置补丁未通过校验。', errors: typeErrors });
    try {
      const errors = config.validate(patch);
      if (errors.length > 0) return reply.code(400).send({ error: '配置补丁未通过校验。', errors });
      const plan = config.plan(patch);
      if ((body as { confirm?: unknown }).confirm !== true) {
        // 密钥键只回传名字与「已填写」：值本身从不进入响应正文。
        return { confirmRequired: true, plan: { fields: plan.fields, secrets: plan.secrets.map(secret => ({ field: secret.field, text: '已填写' })) }, view: config.view() };
      }
      const result = config.save(patch);
      return { saved: true, changedKeys: result.changedKeys, view: result.view };
    } catch (error) {
      if (error instanceof ConfigValidationError) return reply.code(400).send({ error: error.message, errors: error.errors });
      // 冲突不重试、不覆盖：提示操作者重新读取配置。
      if (error instanceof EnvironmentFileConflictError) return reply.code(409).send({ error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : '配置保存失败。' });
    }
  });

  // 正式运行入口：冻结候选快照并自动触发受控验证，需要来源令牌且只接受提交根目录内的候选。
  app.post<{ Body: RunSubmission }>('/api/runs', { schema: { body: RunSubmissionSchema } }, async (request, reply) => {
    const disabled = runs.disabledReason();
    if (disabled !== null) return reply.code(503).send({ error: disabled });
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
  // 清理运行记录：移进回收目录；正在执行的 attempt 会被拒绝。
  app.delete<{ Params: { runId: string; attemptId: string } }>('/api/runs/:runId/:attemptId', (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '清理运行记录需要有效的 x-bench-token 头。' });
    try { return runs.clean(request.params.runId, request.params.attemptId); }
    catch (error) {
      if (error instanceof CleanupError) return reply.code(error.status).send({ error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : '清理失败。' });
    }
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

  // 报告中心：不接受裸目录名，只按不透明 reportId 寻址；unreadable 报告在明细返回 422 与原因。
  const reportFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ReportAccessError) return reply.code(error.status).send({ error: error.message });
    throw error;
  };
  app.get('/api/reports', () => reports().list());
  // 清理报告：移进报告根下的回收目录，可手动恢复。写操作，要求令牌。
  app.delete<{ Params: { reportId: string } }>('/api/reports/:reportId', (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '清理报告需要有效的 x-bench-token 头。' });
    try { return reports().clean(request.params.reportId); }
    catch (error) {
      if (error instanceof CleanupError) return reply.code(error.status).send({ error: error.message });
      return reportFailure(reply, error);
    }
  });
  // 自动测评：发起、纯读进度、取消。写操作一律要求 x-bench-token。
  app.post<{ Body: unknown }>('/api/experiments', async (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '发起测评需要有效的 x-bench-token 头。' });
    const body = request.body;
    const raw = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const arrayOf = (value: unknown): string[] | undefined =>
      value === undefined ? undefined : Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null as unknown as string[];
    const taskIds = arrayOf(raw.taskIds);
    const presets = arrayOf(raw.presets);
    const modes = arrayOf(raw.modes);
    if (taskIds === undefined && raw.taskIds !== undefined) return reply.code(400).send({ error: 'taskIds 必须是字符串数组。' });
    if (presets === undefined && raw.presets !== undefined) return reply.code(400).send({ error: 'presets 必须是字符串数组。' });
    if (modes === undefined && raw.modes !== undefined) return reply.code(400).send({ error: 'modes 必须是字符串数组。' });
    const number = (value: unknown, label: string): number | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new LaunchError(400, label + ' 必须是整数。');
      return value;
    };
    try {
      const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
      const launchRequest: LaunchRequest = {
        check: raw.check === true,
        ...(text(raw.scope) === undefined ? {} : { scope: text(raw.scope)! }),
        ...(text(raw.difficulty) === undefined ? {} : { difficulty: text(raw.difficulty)! }),
        ...(text(raw.provider) === undefined ? {} : { provider: text(raw.provider)! }),
        ...(text(raw.model) === undefined ? {} : { model: text(raw.model)! }),
        ...(text(raw.outputRoot) === undefined || text(raw.outputRoot) === '' ? {} : { outputRoot: text(raw.outputRoot)! }),
        ...(number(raw.repeats, 'repeats') === undefined ? {} : { repeats: number(raw.repeats, 'repeats')! }),
        ...(number(raw.timeoutMinutes, 'timeoutMinutes') === undefined ? {} : { timeoutMinutes: number(raw.timeoutMinutes, 'timeoutMinutes')! }),
        ...(number(raw.maxTokens, 'maxTokens') === undefined ? {} : { maxTokens: number(raw.maxTokens, 'maxTokens')! }),
        ...(raw.measurePerformance === undefined ? {} : { measurePerformance: raw.measurePerformance === true }),
        ...(taskIds === undefined ? {} : { taskIds }), ...(presets === undefined ? {} : { presets }), ...(modes === undefined ? {} : { modes }),
      };
      // 先算计划总作答次数（校验的一部分），再冻结配置快照并 spawn supervisor。
      const plan = launches.planOf(launchRequest);
      const view = await launches.launch(launchRequest);
      return reply.code(201).send({ plannedAnswers: plan.answers, plan, launch: view });
    } catch (error) {
      if (error instanceof LaunchError) return reply.code(error.status).send({ error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : '发起测评失败。' });
    }
  });
  // 纯读：不写账本、不触发对账。GET 前后启动记录字节必须不变。
  app.get('/api/experiments', () => ({ launches: launches.list() }));
  // 清理启动记录：移进回收目录；未落定（进行中/状态未知）的记录会被拒绝。
  app.delete<{ Params: { launchId: string } }>('/api/experiments/:launchId', (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '清理启动记录需要有效的 x-bench-token 头。' });
    try { return launches.clean(request.params.launchId); }
    catch (error) {
      if (error instanceof CleanupError) return reply.code(error.status).send({ error: error.message });
      if (error instanceof LaunchError) return reply.code(error.status).send({ error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : '清理失败。' });
    }
  });
  app.post<{ Params: { launchId: string } }>('/api/experiments/:launchId/cancel', async (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '取消操作需要有效令牌。' });
    try { return await launches.cancel(request.params.launchId); }
    catch (error) {
      if (error instanceof LaunchError) return reply.code(error.status).send({ error: error.message });
      return reply.code(400).send({ error: error instanceof Error ? error.message : '取消失败。' });
    }
  });

  // 外部作答提交：候选只列提交根下一层；提交复用既有 /api/runs 的冻结与验证链路，不再写一套。
  const candidateScope = (candidate: string): { ok: true; value: string } | { ok: false; status: 400 | 503; error: string } => {
    const configured = runs.disabledReason() === null ? (options.submissionsRoot !== undefined ? options.submissionsRoot : config.current().BENCH_SUBMISSIONS_DIR) : null;
    if (configured === null || configured === undefined || configured.trim() === '') return { ok: false, status: 503, error: '提交入口未启用：未配置 BENCH_SUBMISSIONS_DIR。' };
    let root: string;
    try { root = realpathSync(resolve(configured)); } catch { return { ok: false, status: 503, error: '提交根目录不可读。' }; }
    const requested = resolve(root, candidate);
    if (!existsSync(requested)) return { ok: false, status: 400, error: '候选目录不存在：' + candidate };
    // realpath 防 junction/符号链接逃逸：候选必须仍停在提交根之内。
    const target = realpathSync(requested);
    const scope = relative(root, target);
    if (scope === '' || scope === '..' || scope.startsWith('..' + sep) || scope.startsWith('../') || isAbsolute(scope)) return { ok: false, status: 400, error: '候选目录必须位于提交根目录内：' + candidate };
    if (!statSync(target).isDirectory()) return { ok: false, status: 400, error: '候选目录不是目录：' + candidate };
    return { ok: true, value: candidate };
  };
  app.get('/api/submissions', () => {
    const configured = options.submissionsRoot !== undefined ? options.submissionsRoot : (config.current().BENCH_SUBMISSIONS_DIR ?? null);
    return listSubmissionCandidates(configured ?? null);
  });
  app.post<{ Body: { taskId?: unknown; candidateDirectory?: unknown; idempotencyKey?: unknown; submittedBy?: unknown; reason?: unknown; measure?: unknown } }>('/api/submissions', async (request, reply) => {
    if (!authorized(request.headers['x-bench-token'])) return reply.code(401).send({ error: '提交外部作答需要有效的 x-bench-token 头。' });
    const body = request.body ?? {};
    const submission = { taskId: body.taskId, candidateDirectory: body.candidateDirectory, idempotencyKey: body.idempotencyKey,
      submittedBy: body.submittedBy ?? 'external-submission', reason: body.reason ?? 'agent-completed' };
    // 形状校验：给出精确的 400，而不是把畸形请求透传到冻结链路。
    const textField = (value: unknown, maximum: number): string | null =>
      typeof value === 'string' && value.length >= 1 && value.length <= maximum ? value : null;
    const taskId = textField(submission.taskId, 100);
    const candidate = textField(submission.candidateDirectory, 2000);
    const idempotency = textField(submission.idempotencyKey, 200);
    const submittedBy = textField(submission.submittedBy, 2000);
    const reasons = ['agent-completed', 'operator-submit', 'patch-import'] as const;
    const reason = reasons.find(value => value === submission.reason) ?? null;
    if (taskId === null || candidate === null || idempotency === null || submittedBy === null || reason === null || !/^[A-Za-z0-9_.:-]{8,200}$/.test(idempotency)) {
      return reply.code(400).send({ error: '提交内容不符合协议：需要 taskId、candidateDirectory、idempotencyKey（8–200 位字母数字与 _ . : -）与 reason（agent-completed / operator-submit / patch-import）。' });
    }
    const accepted: RunSubmission = { taskId, candidateDirectory: candidate, idempotencyKey: idempotency, submittedBy, reason };
    const scoped = candidateScope(submission.candidateDirectory as string);
    if (!scoped.ok) return reply.code(scoped.status).send({ error: scoped.error });
    const disabled = runs.disabledReason();
    if (disabled !== null) return reply.code(503).send({ error: disabled });
    const measure = body.measure;
    if (measure !== undefined && typeof measure !== 'boolean') return reply.code(400).send({ error: 'measure 必须是布尔值。' });
    // 复用既有 runs 提交能力；measure 只覆盖本次提交，结束后立刻还原。
    const run = async () => {
      measureOverride = measure;
      try { return await runs.submit({ ...accepted, candidateDirectory: scoped.value }); }
      finally { measureOverride = undefined; }
    };
    const queued = submissionChain.then(run, run);
    submissionChain = queued.then(() => undefined, () => undefined);
    try { return reply.code(201).send(await queued); }
    catch (error) {
      const message = error instanceof Error ? error.message : '提交失败。';
      return reply.code(error instanceof IdempotencyConflictError || error instanceof AttemptExistsError ? 409 : 400).send({ error: message });
    }
  });

  app.get<{ Params: { reportId: string } }>('/api/reports/:reportId', (request, reply) => {
    try { return reports().detail(request.params.reportId); }
    catch (error) { return reportFailure(reply, error); }
  });
  app.get<{ Params: { reportId: string; artifactId: string } }>('/api/reports/:reportId/artifacts/:artifactId', (request, reply) => {
    let artifact: ReturnType<ReturnType<typeof openReports>['artifact']>;
    try { artifact = reports().artifact(request.params.reportId, request.params.artifactId); }
    catch (error) { return reportFailure(reply, error); }
    return reply.type(artifact.contentType).header('content-disposition', `attachment; filename="${artifact.filename}"`).send(artifact.bytes);
  });
  return app;
}
