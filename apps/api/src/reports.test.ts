import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@fsa/runs';
import { readRunStatus, verifySubmission } from '@fsa/executor';
import { inspectRunSelection } from '../../../packages/evaluation/src/suite.ts';
import { type DshRunOptions, type DshRunResult } from '../../../packages/evaluation/src/dsh.ts';
import { runDshComparison, type DshComparisonOptions } from '../../../packages/evaluation/src/dsh-comparison.ts';
import { buildApp } from './app.ts';

const scratchRoots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-api-reports-'));
  scratchRoots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratchRoots.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-api-reports-')) throw new Error('测试清理越界。');
    rmSync(target, { recursive: true, force: true });
  }
});

/** 与 @fsa/evaluation 落盘的 experiment.json 同形；进度、逐条记录与证据摘要都可裁剪用于边界用例。 */
function experimentJson(options: { version?: string; progress?: unknown; rows?: Record<string, unknown>[]; evidenceSha?: string | null; presets?: string[] } = {}): string {
  const version = options.version ?? '0.3.0';
  const rows = options.rows ?? [{
    taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'standard', mode: 'off', repetition: 1, sessionId: 'session-fixture', phase: 'done',
    solver: { finishReason: 'completed', durationMs: 1234 },
    evaluation: { status: { classification: 'passed', runId: 'run-fixture', attemptId: 'attempt-fixture', scoring: { total: 100 } } },
    error: null,
  }];
  const report: Record<string, unknown> = {
    schemaVersion: version, id: 'fixture-experiment-id',
    startedAt: '2026-09-14T00:00:00.000Z', finishedAt: '2026-09-14T00:10:00.000Z', state: 'completed',
    settings: { provider: 'fixture-provider', model: 'fixture-model', presets: options.presets ?? ['standard'], modes: ['off'], taskIds: ['CACHE-02'] },
    prompt: 'fixture prompt', rows, issues: [],
    evidence: options.evidenceSha === null ? null : { filename: 'evidence.json.gz', sha256: options.evidenceSha ?? '', fileCount: 1 },
    cleanup: { state: 'complete', directory: null, reason: null },
  };
  if (options.version !== '0.2.0') report.progress = options.progress ?? [{ at: '2026-09-14T00:00:00.000Z', message: 'fixture progress' }];
  return JSON.stringify(report, null, 2) + '\n';
}

function writeExperiment(root: string, directoryName: string, options: Parameters<typeof experimentJson>[0] = {}, evidence: Buffer | null = Buffer.from('fixture-evidence')): void {
  const directory = join(root, directoryName);
  mkdirSync(directory, { recursive: true });
  const registered = options.evidenceSha === null ? null : options.evidenceSha ?? (evidence === null ? 'f'.repeat(64) : createHash('sha256').update(evidence).digest('hex'));
  writeFileSync(join(directory, 'experiment.json'), experimentJson({ ...options, ...(registered === null ? { evidenceSha: null } : { evidenceSha: registered }) }));
  writeFileSync(join(directory, 'report.md'), '# DSH 模式对比\n\nfixture report\n');
  if (evidence !== null) writeFileSync(join(directory, 'evidence.json.gz'), evidence);
}

async function openApp(root: string) {
  return buildApp(':memory:', { reportsRoot: root });
}

/** 与 @fsa/evaluation 测试相同的脚本化作答：不调用真实模型，只验证落盘产物能被出口读取。 */
function solverResult(options: DshRunOptions): DshRunResult {
  return { finishReason: 'completed', durationMs: 1, finalResponse: '模拟作答，仅测试只读出口', usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort === 'default' ? null : options.reasoningEffort, maxTokens: options.maxTokens },
    requestedPreset: options.agentPreset ?? 'standard', observedPresets: [options.agentPreset ?? 'standard'], presetFingerprint: 'f'.repeat(64),
    observedRoutes: [], responseModels: [], dshVersion: 'scripted-test-only', runtimeClosed: true, cleanupScope: 'sdk-runtime' };
}

describe('报告中心（只读出口）', () => {
  it('列出实验报告，空目录返回空列表，明细给出逐条记录与进度', async () => {
    const root = scratch();
    writeExperiment(root, '2026-09-14T00-00-00-000Z-aaaaaaaa');
    writeExperiment(root, '2026-09-14T00-10-00-000Z-bbbbbbbb');
    const app = await openApp(root);
    try {
      const listed = await app.inject('/api/reports');
      expect(listed.statusCode).toBe(200);
      const list = listed.json();
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ directoryName: '2026-09-14T00-10-00-000Z-bbbbbbbb', status: 'ok', error: null,
        id: 'fixture-experiment-id', provider: 'fixture-provider', model: 'fixture-model', presets: ['standard'], modes: ['off'],
        taskCount: 1, planned: 1, startedAt: '2026-09-14T00:00:00.000Z', finishedAt: '2026-09-14T00:10:00.000Z', state: 'completed' });
      expect(list[0].phaseCounts).toEqual({ pending: 0, solving: 0, grading: 0, done: 1, solverStopped: 0, error: 0 });
      expect(list[0].evidence).toMatchObject({ filename: 'evidence.json.gz', fileCount: 1 });
      expect(list[0].cleanup).toEqual({ state: 'complete', directory: null, reason: null });
      expect(list[0].reportId).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(JSON.stringify(list[0])).not.toContain('fixture report');

      const detail = await app.inject(`/api/reports/${list[0].reportId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ settings: { provider: 'fixture-provider', modes: ['off'] }, issues: [],
        progress: [{ at: '2026-09-14T00:00:00.000Z', message: 'fixture progress' }] });
      expect(detail.json().rows[0]).toMatchObject({ taskId: 'CACHE-02', mode: 'off', phase: 'done', finishReason: 'completed',
        durationMs: 1234, classification: 'passed', runId: 'run-fixture', attemptId: 'attempt-fixture', total: 100 });
      // 明细不暴露磁盘路径，只暴露不透明标识与目录名。
      expect(detail.json().root).toBe(list[0].root);
    } finally { await app.close(); }
  });

  it('报告根不存在时返回空列表而不是错误', async () => {
    const root = join(scratch(), 'missing');
    const app = await openApp(root);
    try {
      const listed = await app.inject('/api/reports');
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual([]);
    } finally { await app.close(); }
  });

  it('损坏的 experiment.json 仍出现在列表里并带 unreadable 与原因，明细返回 422', async () => {
    const root = scratch();
    writeExperiment(root, '2026-09-14T00-00-00-000Z-good1');
    const broken = join(root, '2026-09-14T00-05-00-000Z-broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'experiment.json'), '{ "schemaVersion": "0.3.0", oops');
    expect(existsSync(join(broken, 'experiment.json'))).toBe(true);
    const app = await openApp(root);
    try {
      const list = (await app.inject('/api/reports')).json();
      expect(list).toHaveLength(2);
      const unreadable = list.find((entry: { directoryName: string }) => entry.directoryName.endsWith('-broken'));
      expect(unreadable).toMatchObject({ status: 'unreadable', id: null, planned: 0, presets: [], modes: [] });
      expect(unreadable.error).toContain('不是有效 JSON');
      expect(unreadable.phaseCounts).toEqual({ pending: 0, solving: 0, grading: 0, done: 0, solverStopped: 0, error: 0 });
      const detail = await app.inject(`/api/reports/${unreadable.reportId}`);
      expect(detail.statusCode).toBe(422);
      expect(detail.json().error).toContain('不是有效 JSON');
      // 损坏的报告不因详情失败而消失。
      expect((await app.inject('/api/reports')).json()).toHaveLength(2);
    } finally { await app.close(); }
  });

  it('0.2.0 报告（无 progress 字段）按空进度读取，0.3.0 的进度逐条校验', async () => {
    const root = scratch();
    writeExperiment(root, '2026-09-14T00-00-00-000Z-legacy0', { version: '0.2.0' });
    const app = await openApp(root);
    try {
      const list = (await app.inject('/api/reports')).json();
      expect(list[0]).toMatchObject({ status: 'ok', planned: 1 });
      const detail = (await app.inject(`/api/reports/${list[0].reportId}`)).json();
      expect(detail.progress).toEqual([]);
      expect(detail.rows[0]).toMatchObject({ taskId: 'CACHE-02', classification: 'passed', total: 100 });
    } finally { await app.close(); }

    // 超出 500 条上限的 progress 说明落盘已被破坏，必须显式报错而不是静默截断。
    const overflow = Array.from({ length: 501 }, (_, index) => ({ at: '2026-09-14T00:00:00.000Z', message: `progress #${index}` }));
    writeExperiment(root, '2026-09-14T00-10-00-000Z-badprog', { progress: overflow });
    // 投影不出的字段（schema 上限）同样要让报告以 unreadable 出现，而不是被静默跳过。
    writeExperiment(root, '2026-09-14T00-15-00-000Z-badfield', { presets: Array.from({ length: 17 }, (_, index) => `preset-${index}`) });
    const second = await openApp(root);
    try {
      const list = (await second.inject('/api/reports')).json();
      const bad = list.find((entry: { directoryName: string }) => entry.directoryName.endsWith('-badprog'));
      expect(bad.status).toBe('unreadable');
      expect(bad.error).toContain('500 条上限');
      const field = list.find((entry: { directoryName: string }) => entry.directoryName.endsWith('-badfield'));
      expect(field.status).toBe('unreadable');
      expect(field.error).toContain('不符合报告协议');
      expect((await second.inject(`/api/reports/${bad.reportId}`)).statusCode).toBe(422);
    } finally { await second.close(); }
  });

  it('伪造或跨根的 reportId、路径穿越目录名一律 404', async () => {
    const root = scratch();
    writeExperiment(root, '2026-09-14T00-00-00-000Z-good1');
    const app = await openApp(root);
    try {
      const reportId = (await app.inject('/api/reports')).json()[0].reportId;
      const foreign = Buffer.from(JSON.stringify([join(root, 'other'), '2026-09-14T00-00-00-000Z-good1'])).toString('base64url');
      const traversal = Buffer.from(JSON.stringify([JSON.parse(Buffer.from(reportId, 'base64url').toString())[0], '../outside'])).toString('base64url');
      const nested = Buffer.from(JSON.stringify([JSON.parse(Buffer.from(reportId, 'base64url').toString())[0], 'a/b'])).toString('base64url');
      for (const id of ['not-base64-json', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('["only-root"]').toString('base64url'), foreign, traversal, nested, '2026-09-14T00-00-00-000Z-good1']) {
        expect((await app.inject(`/api/reports/${encodeURIComponent(id)}`)).statusCode).toBe(404);
        expect((await app.inject(`/api/reports/${encodeURIComponent(id)}/artifacts/report`)).statusCode).toBe(404);
      }
      // URL 层的穿越尝试不能退化成对裸目录名的寻址。
      for (const url of ['/api/reports/..', '/api/reports/../package.json', '/api/reports/..%2Fpackage.json', '/api/reports/%2e%2e%2fexperiment.json',
        '/api/reports/2026-09-14T00-00-00-000Z-good1/../../package.json']) {
        const response = await app.inject(url);
        expect([404, 400]).toContain(response.statusCode);
        expect(response.body).not.toContain('"private": true');
      }
      expect((await app.inject(`/api/reports/${reportId}`)).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('实验目录或产物是指向根外的符号链接时 404，不跟随链接读取', async () => {
    const root = scratch();
    const outside = scratch();
    writeExperiment(outside, 'secret', { });
    writeFileSync(join(outside, 'secret', 'report.md'), '# 根外内容\n');
    writeExperiment(root, '2026-09-14T00-00-00-000Z-good1');
    symlinkSync(join(outside, 'secret'), join(root, '2026-09-14T00-05-00-000Z-linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const app = await openApp(root);
    try {
      const list = (await app.inject('/api/reports')).json();
      const linked = list.find((entry: { directoryName: string }) => entry.directoryName.endsWith('-linked'));
      expect(linked).toMatchObject({ status: 'unreadable' });
      expect(linked.error).toContain('不是普通目录');

      // 目录本身合法，但目录内的 report.md 是指向根外的符号链接：必须逐产物拒绝。
      const escape = join(root, '2026-09-14T00-10-00-000Z-escape');
      writeExperiment(root, '2026-09-14T00-10-00-000Z-escape');
      rmSync(join(escape, 'report.md'));
      symlinkSync(join(outside, 'secret', 'report.md'), join(escape, 'report.md'), 'file');
      const escaped = (await app.inject('/api/reports')).json().find((entry: { directoryName: string }) => entry.directoryName.endsWith('-escape'));
      expect(escaped.status).toBe('ok');
      const leaked = await app.inject(`/api/reports/${escaped.reportId}/artifacts/report`);
      expect(leaked.statusCode).toBe(404);
      expect(leaked.json().error).toContain('符号链接');
      expect(leaked.body).not.toContain('根外内容');
    } finally { await app.close(); }
  });

  it('校验和不符时拒绝下载 experiment.json 与 evidence.json.gz，未登记摘要同样拒绝', async () => {
    const root = scratch();
    writeExperiment(root, '2026-09-14T00-00-00-000Z-good1');
    const app = await openApp(root);
    try {
      let reportId = (await app.inject('/api/reports')).json()[0].reportId;
      const ok = await app.inject(`/api/reports/${reportId}/artifacts/evidence`);
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toBe('application/gzip');
      expect(ok.headers['content-disposition']).toContain('fixture-experiment-id-evidence.gz');
      expect(ok.rawPayload.equals(Buffer.from('fixture-evidence'))).toBe(true);

      // 证据字节被替换：与 experiment.json 登记的摘要不符，拒绝下载。
      writeFileSync(join(root, '2026-09-14T00-00-00-000Z-good1', 'evidence.json.gz'), Buffer.from('tampered-evidence'));
      const tampered = await app.inject(`/api/reports/${reportId}/artifacts/evidence`);
      expect(tampered.statusCode).toBe(404);
      expect(tampered.json().error).toContain('拒绝下载');
      // experiment.json 没有为自己登记摘要，证据被换掉不影响它的字节，仍可下载。
      const experiment = await app.inject(`/api/reports/${reportId}/artifacts/experiment`);
      expect(experiment.statusCode).toBe(200);
      expect(experiment.rawPayload.equals(readFileSync(join(root, '2026-09-14T00-00-00-000Z-good1', 'experiment.json')))).toBe(true);

      // 未登记 evidence.sha256 的报告没有可核对的依据，同样拒绝下载。
      writeExperiment(root, '2026-09-14T00-05-00-000Z-nohash', { evidenceSha: null });
      const nohash = (await app.inject('/api/reports')).json().find((entry: { directoryName: string }) => entry.directoryName.endsWith('-nohash'));
      expect(nohash.status).toBe('ok');
      const refused = await app.inject(`/api/reports/${nohash.reportId}/artifacts/evidence`);
      expect(refused.statusCode).toBe(404);
      expect(refused.json().error).toContain('未登记');

      // 未登记 evidence.sha256 时，压缩证据没有可核对的依据而拒绝；报告正文没有登记摘要，按其字节原样提供。
      const hashless = await app.inject(`/api/reports/${nohash.reportId}/artifacts/experiment`);
      expect(hashless.statusCode).toBe(200);
      expect((await app.inject(`/api/reports/${reportId}/artifacts/experiment`)).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('CLI 真实写入的 0.3.0 产物可直接列出、读取，并按登记摘要拒绝被篡改的证据', async () => {
    const root = scratch();
    const options: DshComparisonOptions = {
      dshRoot: join(root, 'unused-sdk'), dshHome: join(root, 'unused-home'), profile: 'sdk', workspacePermission: 'workspace-write',
      provider: 'scripted', model: 'fixture-test-only', presets: ['standard'], modes: ['off'], taskIds: ['CACHE-02'], repeats: 1,
      maxTokens: 1024, timeoutMs: 1000, outputDirectory: join(root, '2026-09-14T00-00-00-000Z-real0001'),
      image: 'unused-test-image', imageDigest: 'sha256:' + '0'.repeat(64), measurePerformance: false,
    };
    const written = await runDshComparison(options, {
      env: {},
      async solve(runOptions) { return solverResult(runOptions); },
      async evaluate(taskId, workspace, _row, store) {
        const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
          envelope: createEnvelope(taskId, workspace), submittedBy: 'reports-test', profile: 'local' });
        const { runId, attemptId } = outcome.submission.attempt;
        const identity = inspectRunSelection(store, [{ runId, attemptId }]);
        return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
      },
    });
    expect(written.schemaVersion).toBe('0.3.0');

    const app = await openApp(root);
    try {
      const list = (await app.inject('/api/reports')).json();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ directoryName: '2026-09-14T00-00-00-000Z-real0001', status: 'ok', error: null,
        id: written.id, state: 'completed', provider: 'scripted', model: 'fixture-test-only', presets: ['standard'], modes: ['off'],
        taskCount: 1, planned: 1 });
      expect(list[0].phaseCounts).toMatchObject({ done: 1 });
      expect(list[0].evidence).toMatchObject({ filename: 'evidence.json.gz' });
      const detail = (await app.inject(`/api/reports/${list[0].reportId}`)).json();
      expect(detail.rows).toHaveLength(1);
      // 脚本化作答没有修改起始代码，验证失败、质量分待定；出口必须原样保留 null，不补分。
      expect(detail.rows[0]).toMatchObject({ taskId: 'CACHE-02', phase: 'done', finishReason: 'completed', classification: 'check-failed', total: null });
      expect(detail.progress.map((entry: { message: string }) => entry.message)).toHaveLength(2);
      expect(detail.settings).toMatchObject({ provider: 'scripted', taskIds: ['CACHE-02'] });
      expect((await app.inject(`/api/reports/${list[0].reportId}/artifacts/report`)).body).toContain('# DSH 模式对比');

      const archive = await app.inject(`/api/reports/${list[0].reportId}/artifacts/evidence`);
      expect(archive.statusCode).toBe(200);
      expect(archive.rawPayload.length).toBeGreaterThan(0);
      // 真实归档被改动一个字节后必须与 experiment.json 登记的摘要不符而拒绝下载。
      writeFileSync(join(options.outputDirectory, 'evidence.json.gz'), Buffer.concat([archive.rawPayload, Buffer.from('x')]));
      const tampered = await app.inject(`/api/reports/${list[0].reportId}/artifacts/evidence`);
      expect(tampered.statusCode).toBe(404);
      expect(tampered.json().error).toContain('拒绝下载');
    } finally { await app.close(); }
  }, 60_000);

  it('产物下载只读：GET 前后 experiment.json 字节不变，且 launch.log 明确不适用', async () => {
    const root = scratch();
    writeExperiment(root, '2026-09-14T00-00-00-000Z-good1');
    const target = join(root, '2026-09-14T00-00-00-000Z-good1', 'experiment.json');
    const before = readFileSync(target);
    const mtimeBefore = lstatSync(target).mtimeMs;
    const app = await openApp(root);
    try {
      const reportId = (await app.inject('/api/reports')).json()[0].reportId;
      expect((await app.inject('/api/reports')).statusCode).toBe(200);
      expect((await app.inject(`/api/reports/${reportId}`)).statusCode).toBe(200);
      const markdown = await app.inject(`/api/reports/${reportId}/artifacts/report`);
      expect(markdown.statusCode).toBe(200);
      expect(markdown.headers['content-type']).toContain('text/markdown');
      expect(markdown.headers['content-disposition']).toContain('fixture-experiment-id-report.md');
      expect(markdown.body).toContain('fixture report');
      const json = await app.inject(`/api/reports/${reportId}/artifacts/experiment`);
      expect(json.statusCode).toBe(200);
      expect(json.headers['content-type']).toBe('application/octet-stream');
      expect(json.rawPayload.equals(before)).toBe(true);

      const log = await app.inject(`/api/reports/${reportId}/artifacts/log`);
      expect(log.statusCode).toBe(404);
      expect(log.json().error).toContain('不适用');
      expect((await app.inject(`/api/reports/${reportId}/artifacts/unknown`)).statusCode).toBe(404);
    } finally { await app.close(); }

    expect(readFileSync(target).equals(before)).toBe(true);
    expect(lstatSync(target).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(join(root, '2026-09-14T00-00-00-000Z-good1', 'report.md'), 'utf8')).toBe('# DSH 模式对比\n\nfixture report\n');
  });
});
