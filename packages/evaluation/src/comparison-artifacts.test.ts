import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { archiveComparisonEvidence, cleanupComparisonScratch, createComparisonScratch, restoreComparisonEvidence, type ComparisonEvidenceArchive } from './comparison-artifacts.ts';

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
it('续跑解回既有证据后，run store 能读到历史作答（否则汇总会报「未找到作答」）', () => {
  // 真实故障（2026-09-26 的续跑）：9 条目标全部修好、55/55 已落定，report.state 却是 failed，
  // issues 里一条「未找到作答：run-…/attempt-…」。
  // 原因：续跑只为新跑的行建 run 记录，复用行的 run 数据在上一次 scratch 里（已清理），
  // 而报告末尾的汇总会拿报告里**全部**带 evaluation 的行去 summarizeRuns。
  // 修复：续跑开始时把既有归档解回本次 scratch 的 evidence/。
  const first = createComparisonScratch();
  const output = outputArea();
  try {
    // 第一次运行的 run store：写一条真实作答记录。
    const historyFile = join(first.directory, 'evidence', 'runs', 'run-keep', 'attempt-keep', 'attempt.json');
    mkdirSync(dirname(historyFile), { recursive: true });
    writeFileSync(historyFile, JSON.stringify({ runId: 'run-keep', attemptId: 'attempt-keep', taskId: 'CACHE-02' }));
    const archived = archiveComparisonEvidence(first, output.directory);
    expect(archived.fileCount).toBe(1);
    cleanupComparisonScratch(first);

    // 第二次运行（续跑）：全新的 scratch，本地没有任何历史。
    const second = createComparisonScratch();
    try {
      const restored = restoreComparisonEvidence(second, output.directory);
      expect(restored.fileCount).toBe(1);
      // 关键断言：解回后本地文件真的回来了，且内容一致。
      const restoredFile = join(second.directory, 'evidence', 'runs', 'run-keep', 'attempt-keep', 'attempt.json');
      expect(existsSync(restoredFile)).toBe(true);
      expect(JSON.parse(readFileSync(restoredFile, 'utf8'))).toMatchObject({ runId: 'run-keep', attemptId: 'attempt-keep' });
    } finally { cleanupComparisonScratch(second); }
  } finally { output.clean(); }
});

it('解回既有证据时不覆盖本次新跑的同名文件', () => {
  const first = createComparisonScratch();
  const output = outputArea();
  try {
    const path = join(first.directory, 'evidence', 'runs', 'run-x', 'note.txt');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '历史内容');
    archiveComparisonEvidence(first, output.directory);
    cleanupComparisonScratch(first);
    const second = createComparisonScratch();
    try {
      // 本次新跑已经写了同名文件：必须保留本次的，不能被历史覆盖。
      const target = join(second.directory, 'evidence', 'runs', 'run-x', 'note.txt');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '本次内容');
      restoreComparisonEvidence(second, output.directory);
      expect(readFileSync(target, 'utf8')).toBe('本次内容');
    } finally { cleanupComparisonScratch(second); }
  } finally { output.clean(); }
});

it('解回既有证据时拒绝越界路径与摘要不符的归档', () => {
  const first = createComparisonScratch();
  const output = outputArea();
  try {
    const path = join(first.directory, 'evidence', 'runs', 'run-x', 'note.txt');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '内容');
    archiveComparisonEvidence(first, output.directory);
    cleanupComparisonScratch(first);
    const read = () => JSON.parse(gunzipSync(readFileSync(join(output.directory, 'evidence.json.gz'))).toString('utf8')) as ComparisonEvidenceArchive;
    const write = (archive: ComparisonEvidenceArchive) => writeFileSync(join(output.directory, 'evidence.json.gz'), gzipSync(Buffer.from(JSON.stringify(archive))));
    // 越界路径必须拒绝，不能悄悄写到 scratch 之外。
    const escaped = read();
    expect(escaped.files.length).toBeGreaterThan(0);
    escaped.files[0]!.path = '../escape.txt';
    write(escaped);
    const third = createComparisonScratch();
    try { expect(() => restoreComparisonEvidence(third, output.directory)).toThrow(/越界路径/); }
    finally { cleanupComparisonScratch(third); }
    // 摘要不符同样拒绝。
    const tampered = read();
    tampered.files[0]!.path = 'runs/run-x/note.txt';
    tampered.files[0]!.sha256 = 'f'.repeat(64);
    write(tampered);
    const fourth = createComparisonScratch();
    try { expect(() => restoreComparisonEvidence(fourth, output.directory)).toThrow(/校验不一致/); }
    finally { cleanupComparisonScratch(fourth); }
  } finally { output.clean(); }
});
