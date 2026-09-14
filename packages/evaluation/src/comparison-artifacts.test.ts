import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { archiveComparisonEvidence, cleanupComparisonScratch, createComparisonScratch, type ComparisonEvidenceArchive } from './comparison-artifacts.ts';

function outputArea() {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-comparison-archive-test-'));
  return { directory, clean() {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-comparison-archive-test-')) throw new Error('测试清理越界。');
    rmSync(target, { recursive: true, force: true });
  } };
}

it('归档冻结代码与评分证据可独立复核，清理后不残留作答及 DSH 临时文件', () => {
  const scratch = createComparisonScratch();
  const output = outputArea();
  try {
    const code = Buffer.from('export const result = "已完成";\n');
    const binary = Buffer.from([0, 255, 128, 0, 8]);
    mkdirSync(join(scratch.directory, 'evidence', 'candidate'));
    writeFileSync(join(scratch.directory, 'evidence', 'candidate', 'index.ts'), code);
    writeFileSync(join(scratch.directory, 'evidence', 'resource.bin'), binary);
    mkdirSync(join(scratch.directory, 'dsh-runtime'));
    writeFileSync(join(scratch.directory, 'dsh-runtime', 'session.jsonl'), 'runtime history should not be archived');
    const summary = archiveComparisonEvidence(scratch, output.directory);
    const compressed = readFileSync(join(output.directory, summary.filename));
    expect(createHash('sha256').update(compressed).digest('hex')).toBe(summary.sha256);
    const archive = JSON.parse(gunzipSync(compressed).toString('utf8')) as ComparisonEvidenceArchive;
    expect(summary.fileCount).toBe(2);
    expect(archive.files.map(file => file.path)).toEqual(['candidate/index.ts', 'resource.bin']);
    for (const file of archive.files) {
      const expected = file.path.endsWith('.ts') ? code : binary;
      expect(Buffer.from(file.base64, 'base64')).toEqual(expected);
      expect(file.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
      expect(file.bytes).toBe(expected.byteLength);
    }
    cleanupComparisonScratch(scratch);
    expect(existsSync(scratch.directory)).toBe(false);
    expect(readFileSync(join(output.directory, summary.filename))).toEqual(compressed);
  } finally {
    if (existsSync(scratch.directory)) cleanupComparisonScratch(scratch);
    output.clean();
  }
});

it('报告写入失败或目标已有证据时保留原报告和临时数据，拒绝报告进入待清理目录', () => {
  const scratch = createComparisonScratch();
  const output = outputArea();
  try {
    const evidence = join(scratch.directory, 'evidence', 'score.json');
    writeFileSync(evidence, '{"functional":50}');
    expect(() => archiveComparisonEvidence(scratch, join(output.directory, 'missing'))).toThrow();
    expect(readFileSync(evidence, 'utf8')).toContain('50');
    writeFileSync(join(output.directory, 'evidence.json.gz'), 'previous report');
    expect(() => archiveComparisonEvidence(scratch, output.directory)).toThrow();
    expect(readFileSync(join(output.directory, 'evidence.json.gz'), 'utf8')).toBe('previous report');
    expect(() => archiveComparisonEvidence(scratch, join(scratch.directory, 'evidence'))).toThrow('待清理');
    expect(existsSync(evidence)).toBe(true);
  } finally { cleanupComparisonScratch(scratch); output.clean(); }
});

it('错误 token 或非自有根目录不能触发递归删除', () => {
  const scratch = createComparisonScratch();
  const other = outputArea();
  try {
    writeFileSync(join(other.directory, 'keep.txt'), 'user data');
    expect(() => cleanupComparisonScratch({ ...scratch, token: 'incorrect' })).toThrow('所有权');
    expect(() => cleanupComparisonScratch({ directory: other.directory, token: scratch.token })).toThrow('越界');
    expect(existsSync(scratch.directory)).toBe(true);
    expect(readFileSync(join(other.directory, 'keep.txt'), 'utf8')).toBe('user data');
  } finally { cleanupComparisonScratch(scratch); other.clean(); }
});

it('证据及运行时的外部目录链接均被拒绝，外部数据不被读取、打包或删除', () => {
  const scratch = createComparisonScratch();
  const external = outputArea();
  const pointer = join(scratch.directory, 'evidence', 'external');
  const runtimePointer = join(scratch.directory, 'runtime-external');
  try {
    writeFileSync(join(external.directory, 'keep.txt'), 'outside data');
    symlinkSync(external.directory, pointer, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => archiveComparisonEvidence(scratch, external.directory)).toThrow(/链接|junction/);
    expect(() => cleanupComparisonScratch(scratch)).toThrow(/链接|junction/);
    expect(existsSync(join(external.directory, 'evidence.json.gz'))).toBe(false);
    unlinkSync(pointer);
    symlinkSync(external.directory, runtimePointer, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => cleanupComparisonScratch(scratch)).toThrow(/链接|junction/);
    expect(readFileSync(join(external.directory, 'keep.txt'), 'utf8')).toBe('outside data');
    unlinkSync(runtimePointer);
  } finally {
    if (existsSync(pointer)) unlinkSync(pointer);
    if (existsSync(runtimePointer)) unlinkSync(runtimePointer);
    cleanupComparisonScratch(scratch); external.clean();
  }
});
