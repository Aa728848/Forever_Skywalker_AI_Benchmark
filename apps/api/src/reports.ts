import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  explainExperimentDetail, explainExperimentSummary,
  type ExperimentDetail, type ExperimentList, type ExperimentPhaseCounts, type ExperimentRow, type ExperimentSummary,
} from '@fsa/contracts';

/** 报告根默认位置与 CLI 的 BENCH_DSH_REPORT_DIR 缺省值一致：<仓库根>/data/experiments。 */
export const defaultReportsRoot = fileURLToPath(new URL('../../../data/experiments', import.meta.url));

export const reportArtifactIds = ['report', 'experiment', 'evidence', 'log'] as const;
export type ReportArtifactId = (typeof reportArtifactIds)[number];

export interface ReportArtifact {
  id: ReportArtifactId;
  /** 下载文件名固定为 <experimentId>-<artifactId>.<ext>。 */
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface ReportsOptions {
  /** 报告根：其下一层目录各自是一个实验报告。 */
  root?: string;
}

export interface Reports {
  readonly root: string;
  list(): ExperimentList;
  detail(reportId: string): ExperimentDetail;
  artifact(reportId: string, artifactId: string): ReportArtifact;
}

/** 路由层据此选择 HTTP 状态；404 是"这里没有这个东西"，422 是"有，但读不出内容"。 */
export class ReportAccessError extends Error {
  readonly status: 404 | 422;
  constructor(status: 404 | 422, message: string) {
    super(message);
    this.name = 'ReportAccessError';
    this.status = status;
  }
}

interface ArtifactSpec {
  fileName: string;
  extension: string;
  contentType: string;
  /**
   * 用 experiment.json 内登记的 evidence.sha256 核对字节。
   * 只有压缩证据本身登记了摘要；experiment.json 没有为自己登记摘要（evidence.sha256 是证据包的哈希），
   * 拿它去比对 experiment.json 的字节在任何报告上都不成立，所以这里不做比对——其内容一旦被改动，
   * 会先以 unreadable 或字段不符暴露出来，而不是被当成有效报告下载。
   */
  verified: boolean;
}

const artifactSpecs: Record<ReportArtifactId, ArtifactSpec> = {
  report: { fileName: 'report.md', extension: 'md', contentType: 'text/markdown; charset=utf-8', verified: false },
  experiment: { fileName: 'experiment.json', extension: 'json', contentType: 'application/octet-stream', verified: false },
  evidence: { fileName: 'evidence.json.gz', extension: 'gz', contentType: 'application/gzip', verified: true },
  // 本阶段比较入口不产出启动日志；保留标识以便未来接入，当前明确回答"不适用"。
  log: { fileName: 'launch.log', extension: 'log', contentType: 'text/plain; charset=utf-8', verified: false },
};

const phases = ['pending', 'solving', 'grading', 'done', 'solver-stopped', 'error'] as const;
const zeroPhaseCounts: ExperimentPhaseCounts = { pending: 0, solving: 0, grading: 0, done: 0, solverStopped: 0, error: 0 };
/** 进度落盘上限与 @fsa/evaluation 保持一致；超出即说明 experiment.json 不符合协议。 */
const progressLimit = 500;
const supportedVersions = ['0.2.0', '0.3.0'];

interface EntryMeta {
  reportId: string;
  root: string;
  directoryName: string;
  modifiedAt: string;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}必须是非空字符串。`);
  return value;
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串或 null。`);
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 分数与报告协议一样允许缺失（null 表示待定）；越界值说明报告已经损坏。 */
function optionalScore(value: unknown, label: string): number | null {
  const number = optionalNumber(value);
  if (number === null) return null;
  if (number < 0 || number > 100) throw new Error(`${label}超出 0–100：${number}。`);
  return number;
}

/** 去重后的非空字符串数组；CLI 的 presets/modes/taskIds 都是这个形状。 */
function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) throw new Error(`${label}必须是非空字符串数组。`);
  return [...new Set(value as string[])];
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(item => typeof item !== 'string')) throw new Error(`${label}必须是字符串数组。`);
  return value as string[];
}

/** 逐条记录只投影出口需要的字段；缺字段或类型不符一律视为报告损坏，不做静默补值。 */
function projectRow(value: unknown, index: number): ExperimentRow {
  const label = `第 ${index + 1} 条作答记录`;
  const row = requireRecord(value, label);
  const phase = requireText(row.phase, `${label}的 phase`);
  if (!(phases as readonly string[]).includes(phase)) throw new Error(`${label}的 phase 无法识别：${phase}。`);
  const repetition = row.repetition;
  if (typeof repetition !== 'number' || !Number.isSafeInteger(repetition) || repetition < 1) throw new Error(`${label}的 repetition 必须是正整数。`);
  const solver = optionalRecord(row.solver);
  const evaluation = optionalRecord(row.evaluation);
  const status = optionalRecord(evaluation?.status);
  const scoring = optionalRecord(status?.scoring);
  return {
    taskId: requireText(row.taskId, `${label}的 taskId`),
    taskVersion: requireText(row.taskVersion, `${label}的 taskVersion`),
    preset: requireText(row.preset, `${label}的 preset`),
    mode: requireText(row.mode, `${label}的 mode`),
    repetition,
    sessionId: requireText(row.sessionId, `${label}的 sessionId`),
    phase: phase as ExperimentRow['phase'],
    solver: row.solver ?? null,
    evaluation: row.evaluation ?? null,
    finishReason: solver === null ? null : optionalText(solver.finishReason, `${label}的 finishReason`),
    durationMs: solver === null ? null : optionalNumber(solver.durationMs),
    classification: status === null ? null : optionalText(status.classification, `${label}的 classification`),
    runId: status === null ? null : optionalText(status.runId, `${label}的 runId`),
    attemptId: status === null ? null : optionalText(status.attemptId, `${label}的 attemptId`),
    total: scoring === null ? null : optionalScore(scoring.total, `${label}的 total`),
  };
}

function phaseCounts(rows: ExperimentRow[]): ExperimentPhaseCounts {
  const counts = { ...zeroPhaseCounts };
  for (const row of rows) {
    if (row.phase === 'solver-stopped') counts.solverStopped += 1;
    else counts[row.phase] += 1;
  }
  return counts;
}

/** 进度条目逐条给出时间与消息；0.2.0 没有该字段，按空数组处理。 */
function projectProgress(value: unknown, version: string): ExperimentDetail['progress'] {
  if (value === undefined && version === '0.2.0') return [];
  if (!Array.isArray(value)) throw new Error('progress 必须是数组。');
  if (value.length > progressLimit) throw new Error(`progress 超过 ${progressLimit} 条上限，报告已不符合协议（版本 ${version}）。`);
  return value.map((entry, index) => {
    const record = requireRecord(entry, `第 ${index + 1} 条进度`);
    return {
      at: requireText(record.at, `第 ${index + 1} 条进度的 at`),
      message: requireText(record.message, `第 ${index + 1} 条进度的 message`),
    };
  });
}

/**
 * experiment.json 解析为明细：0.2.0（无 progress）与 0.3.0 都接受。
 * 任何不符协议之处都抛错，由调用方转成 unreadable 并带上原因。
 */
function projectDetail(document: unknown, meta: EntryMeta): ExperimentDetail {
  const report = requireRecord(document, 'experiment.json');
  const version = requireText(report.schemaVersion, 'schemaVersion');
  if (!supportedVersions.includes(version)) throw new Error(`不支持的 experiment.json 版本：${version}（仅支持 ${supportedVersions.join(' 与 ')}）。`);
  const settings = requireRecord(report.settings, 'settings');
  if (!Array.isArray(report.rows)) throw new Error('rows 必须是数组。');
  const rows = report.rows.map((row, index) => projectRow(row, index));
  const issues = stringArray(report.issues, 'issues');
  const progress = projectProgress(report.progress, version);
  const evidence = optionalRecord(report.evidence);
  const cleanup = optionalRecord(report.cleanup);
  return {
    ...meta,
    status: 'ok',
    error: null,
    id: requireText(report.id, 'id'),
    startedAt: requireText(report.startedAt, 'startedAt'),
    finishedAt: optionalText(report.finishedAt, 'finishedAt'),
    state: requireText(report.state, 'state'),
    provider: optionalText(settings.provider, 'settings.provider'),
    model: optionalText(settings.model, 'settings.model'),
    presets: textArray(settings.presets, 'settings.presets'),
    modes: textArray(settings.modes, 'settings.modes'),
    taskCount: textArray(settings.taskIds, 'settings.taskIds').length,
    planned: rows.length,
    phaseCounts: phaseCounts(rows),
    evidence: evidence === null ? null : {
      filename: requireText(evidence.filename, 'evidence.filename'),
      sha256: requireText(evidence.sha256, 'evidence.sha256'),
      fileCount: optionalNumber(evidence.fileCount) ?? 0,
    },
    cleanup: cleanup === null ? null : {
      state: requireText(cleanup.state, 'cleanup.state'),
      directory: optionalText(cleanup.directory, 'cleanup.directory'),
      reason: optionalText(cleanup.reason, 'cleanup.reason'),
    },
    settings,
    rows,
    issues,
    progress,
  };
}

function summaryOf(detail: ExperimentDetail): ExperimentSummary {
  const { settings, rows, issues, progress, ...summary } = detail;
  void settings; void rows; void issues; void progress;
  return summary;
}

function unreadable(meta: EntryMeta, error: string): ExperimentSummary {
  return {
    ...meta, status: 'unreadable', error, id: null, startedAt: null, finishedAt: null, state: null,
    provider: null, model: null, presets: [], modes: [], taskCount: 0, planned: 0,
    phaseCounts: { ...zeroPhaseCounts }, evidence: null, cleanup: null,
  };
}

/** 不透明标识：base64url(JSON.stringify([rootKey, directoryName]))，rootKey 是报告根的 realpath。 */
function encodeReportId(root: string, directoryName: string): string {
  return Buffer.from(JSON.stringify([root, directoryName]), 'utf8').toString('base64url');
}

function decodeReportId(reportId: string): [string, string] {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(reportId, 'base64url').toString('utf8')); }
  catch { throw new ReportAccessError(404, '无法识别的报告标识。'); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw new ReportAccessError(404, '无法识别的报告标识。');
  return [parsed[0], parsed[1]];
}

/** 目录名不得越出报告根一层：'.'、'..' 与任何分隔符都拒绝。 */
function isPlainDirectoryName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes(sep);
}

function downloadName(id: string, artifactId: ReportArtifactId): string {
  return `${id.replace(/[^A-Za-z0-9_.:-]/g, '_')}-${artifactId}.${artifactSpecs[artifactId].extension}`;
}

/**
 * 报告中心：只读地列出、读取与下载实验报告产物。
 * 本模块不写任何文件；损坏的报告仍以 unreadable 出现在列表里并带原因，不静默跳过。
 */
export function openReports(options: ReportsOptions = {}): Reports {
  const configured = resolve(options.root ?? defaultReportsRoot);
  const rootKey = (): string => { try { return realpathSync(configured); } catch { return configured; } };

  const readEntry = (directoryName: string): ExperimentSummary | ExperimentDetail => {
    const root = rootKey();
    const reportId = encodeReportId(root, directoryName);
    let modifiedAt = new Date(0).toISOString();
    try {
      const target = join(root, directoryName);
      // lstat 不跟随链接：指向根外的符号链接或 junction 在这里就被拒绝。
      const stat = lstatSync(target);
      if (!stat.isDirectory()) throw new Error('不是普通目录（可能是符号链接或 junction）。');
      modifiedAt = stat.mtime.toISOString();
      const directory = realpathSync(target);
      const scope = relative(root, directory);
      if (scope === '' || scope === '..' || scope.startsWith('..' + sep) || scope.startsWith('../') || isAbsolute(scope)) throw new Error('目录位于报告根之外。');
      const path = join(directory, 'experiment.json');
      if (!existsSync(path)) throw new Error('缺少 experiment.json。');
      const fileStat = lstatSync(path);
      if (fileStat.isSymbolicLink()) throw new Error('experiment.json 是符号链接，拒绝读取。');
      if (!fileStat.isFile()) throw new Error('experiment.json 不是普通文件。');
      const raw = readFileSync(path, 'utf8');
      let document: unknown;
      try { document = JSON.parse(raw); }
      catch (error) { throw new Error(`experiment.json 不是有效 JSON：${reason(error)}`); }
      const detail = projectDetail(document, { reportId, root, directoryName, modifiedAt });
      const issues = explainExperimentDetail(detail);
      if (issues.length > 0) throw new Error(`experiment.json 不符合报告协议：${issues.slice(0, 5).join('；')}`);
      return detail;
    } catch (error) {
      return unreadable({ reportId, root, directoryName, modifiedAt }, reason(error));
    }
  };

  const scan = (): ExperimentSummary[] => {
    const root = rootKey();
    // 报告根不存在或不可读时视为没有报告，不报错。
    let names: string[];
    try { names = readdirSync(root); } catch { return []; }
    const summaries = names.map(name => {
      const entry = readEntry(name);
      if (!('settings' in entry)) return entry;
      const summary = summaryOf(entry);
      const issues = explainExperimentSummary(summary);
      return issues.length === 0 ? summary : unreadable({ reportId: summary.reportId, root: summary.root, directoryName: summary.directoryName, modifiedAt: summary.modifiedAt }, `报告摘要不符合出口协议：${issues.slice(0, 3).join('；')}`);
    });
    // 目录名以时间戳开头，倒序即最新在前。目录名唯一，排序稳定。
    return summaries.sort((left, right) => right.directoryName.localeCompare(left.directoryName));
  };

  const find = (reportId: string): ExperimentSummary => {
    const [root, directoryName] = decodeReportId(reportId);
    if (root !== rootKey()) throw new ReportAccessError(404, '报告标识不属于当前报告根。');
    if (!isPlainDirectoryName(directoryName)) throw new ReportAccessError(404, '报告标识中的目录名无效。');
    const found = scan().find(entry => entry.directoryName === directoryName && entry.reportId === reportId);
    if (!found) throw new ReportAccessError(404, '未找到该实验报告。');
    return found;
  };

  /** 产物逐个校验：先拒绝符号链接，再确认 realpath 仍停在实验目录内。只校验目录是不够的。 */
  const artifactPath = (directory: string, fileName: string): string => {
    const candidate = join(directory, fileName);
    if (!existsSync(candidate)) throw new ReportAccessError(404, `报告缺少 ${fileName}。`);
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new ReportAccessError(404, `${fileName} 是符号链接，拒绝读取。`);
    if (!stat.isFile()) throw new ReportAccessError(404, `${fileName} 不是普通文件。`);
    const real = realpathSync(candidate);
    const scope = relative(directory, real);
    if (scope !== fileName) throw new ReportAccessError(404, `${fileName} 位于实验目录之外，拒绝读取。`);
    return real;
  };

  const findDetail = (reportId: string): ExperimentDetail => {
    const summary = find(reportId);
    if (summary.status !== 'ok') throw new ReportAccessError(422, summary.error ?? '报告不可读。');
    const detail = readEntry(summary.directoryName);
    if (!('settings' in detail)) throw new ReportAccessError(422, detail.error ?? '报告不可读。');
    return detail;
  };

  return {
    get root() { return rootKey(); },
    list(): ExperimentList {
      return scan();
    },
    detail(reportId: string): ExperimentDetail {
      return findDetail(reportId);
    },
    artifact(reportId: string, artifactId: string): ReportArtifact {
      if (!(reportArtifactIds as readonly string[]).includes(artifactId)) throw new ReportAccessError(404, `未知的产物标识：${artifactId}。`);
      const id = artifactId as ReportArtifactId;
      const summary = find(reportId);
      if (id === 'log') throw new ReportAccessError(404, 'launch.log 不适用于本阶段的实验报告：比较入口不产出该产物。');
      const spec = artifactSpecs[id];
      const directory = realpathSync(join(rootKey(), summary.directoryName));
      const path = artifactPath(directory, spec.fileName);
      const bytes = readFileSync(path);
      if (spec.verified) {
        // 摘要只取自 experiment.json 自己登记的值；报告损坏或没有登记，就没有可核对的依据，同样拒绝。
        const registered = summary.status === 'ok' ? findDetail(reportId).evidence?.sha256 ?? null : null;
        if (registered === null) throw new ReportAccessError(404, `报告未登记可核对的 evidence.sha256，拒绝下载 ${spec.fileName}。`);
        if (createHash('sha256').update(bytes).digest('hex') !== registered) throw new ReportAccessError(404, `${spec.fileName} 与 experiment.json 登记的摘要不符，拒绝下载。`);
      }
      return { id, filename: downloadName(summary.id ?? summary.directoryName, id), contentType: spec.contentType, bytes };
    },
  };
}
