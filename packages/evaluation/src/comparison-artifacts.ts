import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/** 仅归档调用方显式放入 evidence/ 的材料，绝不收集 DSH home 或运行时配置。 */
export function archiveComparisonEvidence(scratch: ComparisonScratch, outputDirectory: string): {
  filename: 'evidence.json.gz'; sha256: string; fileCount: number;
} {
  const directory = ownedDirectory(scratch);
  const output = realpathSync(outputDirectory);
  const scope = relative(realpathSync(directory), output);
  if (scope === '' || (!isAbsolute(scope) && scope !== '..' && !scope.startsWith('..' + sep))) throw new Error('报告目录不得位于待清理实验目录内。');
  if (!lstatSync(outputDirectory).isDirectory() || lstatSync(outputDirectory).isSymbolicLink()) throw new Error('报告输出路径必须是普通目录。');
  const evidence = join(directory, 'evidence');
  if (!lstatSync(evidence).isDirectory()) throw new Error('缺少实验 evidence 目录。');
  const archive: ComparisonEvidenceArchive = { schemaVersion: '0.1.0', files: regularFiles(evidence).map(path => {
    const bytes = readFileSync(path);
    return { path: relative(evidence, path).split(sep).join('/'), base64: bytes.toString('base64'), sha256: sha256(bytes), bytes: bytes.byteLength };
  }) };
  const compressed = gzipSync(Buffer.from(JSON.stringify(archive)));
  const filename = 'evidence.json.gz';
  const destination = join(output, filename);
  // wx 独占创建：既有报告无论是否有效都不能被本次覆盖。
  writeFileSync(destination, compressed, { flag: 'wx', mode: 0o600 });
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

/** 只清理本次创建且标记匹配的完整临时树；调用方须先确认报告与归档落盘。 */
export function cleanupComparisonScratch(scratch: ComparisonScratch): void {
  const directory = ownedDirectory(scratch);
  regularFiles(directory);
  rmSync(directory, { recursive: true, force: false });
}
