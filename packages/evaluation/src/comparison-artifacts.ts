import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const prefix = 'fsa-dsh-experiment-';
const marker = '.fsa-comparison-owner';

export interface ComparisonScratch {
  directory: string;
  token: string;
}

export interface ComparisonEvidenceArchive {
  schemaVersion: '0.1.0';
  files: { path: string; base64: string; sha256: string; bytes: number }[];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function ownedDirectory(scratch: ComparisonScratch): string {
  const directory = resolve(scratch.directory);
  if (!isAbsolute(scratch.directory) || !basename(directory).startsWith(prefix)
    || realpathSync(dirname(directory)) !== realpathSync(tmpdir())) throw new Error('实验临时目录清理路径越界。');
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('实验临时根目录不是自有普通目录。');
  const owner = join(directory, marker);
  if (!lstatSync(owner).isFile() || lstatSync(owner).isSymbolicLink()
    || scratch.token.length === 0 || readFileSync(owner, 'utf8') !== scratch.token) throw new Error('实验临时目录所有权标记不匹配。');
  return directory;
}

/** 不跟随符号链接或 Windows junction；清理前先检查完整树，拒绝后保留现场。 */
function regularFiles(root: string): string[] {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('实验目录包含符号链接或 junction，拒绝归档或递归清理。');
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) pending.push(join(current, child));
    } else if (stat.isFile()) files.push(current);
    else throw new Error('实验目录包含特殊文件，拒绝归档或递归清理。');
  }
  return files.sort();
}

export function createComparisonScratch(): ComparisonScratch {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  const token = randomUUID();
  writeFileSync(join(directory, marker), token, { flag: 'wx', mode: 0o600 });
  mkdirSync(join(directory, 'evidence'));
  return { directory, token };
}

/**
 * 仅归档调用方显式放入 evidence/ 的材料，绝不收集 DSH home 或运行时配置。
 *
 * `merge` 供**续跑**使用：目标目录里已有一份本实验的归档时，把旧文件合并进来而不是覆盖。
 * 为什么不能直接覆盖：落定行的 evidenceRefs 指向旧 scratch 的 `runs/<uuid>/…`，
 * 覆盖会让这些引用悬空——报告引用不存在的证据。合并后两侧都在，历史不丢。
 * 非续跑路径仍用独占创建（wx），保证既有报告绝不被新实验覆盖。
 */
export function archiveComparisonEvidence(scratch: ComparisonScratch, outputDirectory: string, options: { merge?: boolean } = {}): {
  filename: 'evidence.json.gz'; sha256: string; fileCount: number;
} {
  const directory = ownedDirectory(scratch);
  const output = realpathSync(outputDirectory);
  const scope = relative(realpathSync(directory), output);
  if (scope === '' || (!isAbsolute(scope) && scope !== '..' && !scope.startsWith('..' + sep))) throw new Error('报告目录不得位于待清理实验目录内。');
  if (!lstatSync(outputDirectory).isDirectory() || lstatSync(outputDirectory).isSymbolicLink()) throw new Error('报告输出路径必须是普通目录。');
  const evidence = join(directory, 'evidence');
  if (!lstatSync(evidence).isDirectory()) throw new Error('缺少实验 evidence 目录。');
  const collected: ComparisonEvidenceArchive['files'] = regularFiles(evidence).map(path => {
    const bytes = readFileSync(path);
    return { path: relative(evidence, path).split(sep).join('/'), base64: bytes.toString('base64'), sha256: sha256(bytes), bytes: bytes.byteLength };
  });
  const filename = 'evidence.json.gz';
  const destination = join(output, filename);
  // 续跑：读回既有归档，把本次新文件并进去。同路径以本次为准（本轮重新采集过）。
  const merged: ComparisonEvidenceArchive['files'] = [...collected];
  if (options.merge === true && existsSync(destination)) {
    const previous = JSON.parse(gunzipSync(readFileSync(destination)).toString('utf8')) as ComparisonEvidenceArchive;
    const fresh = new Set(collected.map(file => file.path));
    for (const file of previous.files) if (!fresh.has(file.path)) merged.push(file);
  }
  const archive: ComparisonEvidenceArchive = { schemaVersion: '0.1.0', files: merged };
  const compressed = gzipSync(Buffer.from(JSON.stringify(archive)));
  if (options.merge === true) writeFileSync(destination, compressed, { mode: 0o600 });
  // wx 独占创建：非续跑时既有报告无论是否有效都不能被本次覆盖。
  else writeFileSync(destination, compressed, { flag: 'wx', mode: 0o600 });
  const recorded = readFileSync(destination);
  if (sha256(recorded) !== sha256(compressed)) throw new Error('报告证据写入后摘要不匹配；保留实验临时目录。');
  const restored = JSON.parse(gunzipSync(recorded).toString('utf8')) as ComparisonEvidenceArchive;
  if (restored.schemaVersion !== archive.schemaVersion || restored.files.length !== archive.files.length
    || restored.files.some((file, index) => {
      const expected = archive.files[index]!;
      const bytes = Buffer.from(file.base64, 'base64');
      return file.path !== expected.path || file.base64 !== expected.base64 || file.sha256 !== expected.sha256
        || file.bytes !== expected.bytes || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256;
    })) throw new Error('报告证据回读校验失败；保留实验临时目录。');
  return { filename, sha256: sha256(recorded), fileCount: archive.files.length };
}

/**
 * 续跑用：把既有归档解回本次 scratch 的 evidence/，让 run store 能看到历史作答。
 *
 * 为什么必须做：续跑只为**新跑的行**创建 run 记录，而复用的行其 run/attempt 数据
 * 仍在上一次运行的 scratch 里（已随清理删除）。但报告末尾的汇总会按报告里
 * 全部带 evaluation 的行去 `summarizeRuns`，其中第一条复用行读不到作答即抛
 * 「未找到作答」，整次续跑被判 failed——实测 9 条全部修好、55/55 已落定，
 * 实验状态却是 failed，就是这一条。
 * 解回后再汇总，历史与新增都在，且证据校验（sha256/bytes）沿用同一套。
 */
export function restoreComparisonEvidence(scratch: ComparisonScratch, outputDirectory: string): { fileCount: number } {
  const directory = ownedDirectory(scratch);
  const source = join(realpathSync(outputDirectory), 'evidence.json.gz');
  if (!existsSync(source)) return { fileCount: 0 };
  const archive = JSON.parse(gunzipSync(readFileSync(source)).toString('utf8')) as ComparisonEvidenceArchive;
  if (archive.schemaVersion !== '0.1.0' || !Array.isArray(archive.files)) throw new Error('既有证据归档不是可续跑的 0.1.0 格式。');
  const evidence = join(directory, 'evidence');
  let restored = 0;
  let skipped = 0;
  for (const file of archive.files) {
    // 路径越界或摘要不符一律拒绝：归档被动手脚时不能悄悄注入数据。
    const target = resolve(evidence, file.path);
    const scope = relative(evidence, target);
    if (isAbsolute(scope) || scope === '' || scope.startsWith('..' + sep) || scope === '..') throw new Error('既有证据归档含越界路径：' + file.path);
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('既有证据归档经校验不一致：' + file.path);
    // 本次新跑的行已经写了同名文件：以本次为准，不覆盖。
    if (existsSync(target)) { skipped++; continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    restored++;
  }
  return { fileCount: restored + skipped };
}

/** 只清理本次创建且标记匹配的完整临时树；调用方须先确认报告与归档落盘。 */
export function cleanupComparisonScratch(scratch: ComparisonScratch): void {
  const directory = ownedDirectory(scratch);
  regularFiles(directory);
  rmSync(directory, { recursive: true, force: false });
}
