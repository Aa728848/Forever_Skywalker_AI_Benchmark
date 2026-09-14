import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { tasks } from '@fsa/catalog';
import {
  declaredCheckIds, exportWorkspace, listFiles, parseTap, readManifest,
  repositoryRoot, taskPackageDir, verifyTaskPackage,
} from './index.ts';

const taskId = 'CACHE-02';

function testNames(source: string): string[] {
  return [...source.matchAll(/^test\('([^']+)'/gm)].map(match => match[1] ?? '').sort();
}

describe('题目包 manifest 与题库一致', () => {
  const manifest = readManifest(taskId);

  it('核对题目、运行时与版本，并要求关键验收项', () => {
    expect(manifest.taskId).toBe(taskId);
    expect(manifest.runtime).toBe('typescript');
    expect(manifest.checks.some(check => check.critical)).toBe(true);
    expect(manifest.checks.filter(check => check.kind === 'public')).toHaveLength(8);
    expect(manifest.checks.filter(check => check.kind === 'hidden')).toHaveLength(9);
  });

  it('五个可用验证组都有对应检查', () => {
    const groups = new Set(manifest.checks.map(check => check.group));
    expect([...groups].sort()).toEqual(['behavior', 'boundary', 'regression', 'resources', 'state']);
  });

  it('声明的检查 ID 与检查文件中的测试名完全一致', () => {
    const publicSource = readFileSync(join(taskPackageDir(taskId), 'public-tests', 'keyed-loader.test.ts'), 'utf8');
    const hiddenSource = readFileSync(join(repositoryRoot, manifest.grader.checks, 'keyed-loader.hidden.test.ts'), 'utf8');
    expect(testNames(publicSource)).toEqual(declaredCheckIds(manifest, 'public').sort());
    expect(testNames(hiddenSource)).toEqual(declaredCheckIds(manifest, 'hidden').sort());
  });

  it('隐藏资产位于题目包之外', () => {
    for (const path of [manifest.grader.checks, manifest.grader.referencePatch, manifest.grader.alternative]) {
      expect(join(repositoryRoot, path).startsWith(taskPackageDir(taskId))).toBe(false);
    }
  });
});

describe('候选工作区导出', () => {
  it('只导出白名单资产，隐藏检查与参考补丁不出现', () => {
    const destination = mkdtempSync(join(tmpdir(), 'fsa-export-'));
    try {
      const record = exportWorkspace(taskId, destination);
      const files = listFiles(destination);
      expect(files).toEqual(record.files);
      expect(files).toContain('TASK.md');
      expect(files).toContain('starter/src/keyed-loader.ts');
      expect(files).toContain('public-tests/keyed-loader.test.ts');
      expect(files.some(file => file.includes('__checks__'))).toBe(false);
      expect(files.some(file => file.includes('reference.patch'))).toBe(false);
      expect(files.some(file => file.includes('graders/'))).toBe(false);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('拒绝非空目标目录，避免残留上一次候选', () => {
    const destination = mkdtempSync(join(tmpdir(), 'fsa-export-'));
    try {
      exportWorkspace(taskId, destination);
      expect(() => exportWorkspace(taskId, destination)).toThrow(/必须为空/);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});

describe('TAP 解析', () => {
  it('区分为通过、失败与跳过', () => {
    const output = [
      'TAP version 13',
      'ok 1 - public/first',
      'not ok 2 - public/second',
      'ok 3 - public/third # SKIP',
      '1..3',
    ].join('\n');
    expect(parseTap(output)).toEqual([
      { id: 'public/first', ok: true, skipped: false, durationMs: null },
      { id: 'public/second', ok: false, skipped: false, durationMs: null },
      { id: 'public/third', ok: false, skipped: true, durationMs: null },
    ]);
  });

  it('读取测试行后的 duration_ms 诊断块', () => {
    const output = [
      'TAP version 13',
      'ok 1 - public/first',
      '  ---',
      '  duration_ms: 1.25',
      '  type: \'test\'',
      '  ...',
      'not ok 2 - public/second',
      '  ---',
      '  duration_ms: 2.5',
      '  ...',
    ].join('\n');
    expect(parseTap(output)).toEqual([
      { id: 'public/first', ok: true, skipped: false, durationMs: 1.25 },
      { id: 'public/second', ok: false, skipped: false, durationMs: 2.5 },
    ]);
  });
});

describe('三向验证', () => {
  it('缺陷起始版本只被声明的检出项判失败，参考补丁与替代实现全部通过', async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'fsa-verify-'));
    try {
      const report = verifyTaskPackage({ taskId, artifactDir });
      expect(report.hiddenAssetsExcluded).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.phases.map(phase => phase.name)).toEqual([
        'starter-public', 'starter-hidden', 'reference-public', 'reference-hidden', 'alternative-public', 'alternative-hidden',
      ]);
      expect(report.phases.every(phase => phase.missing.length === 0)).toBe(true);
      expect(report.phases.find(phase => phase.name === 'starter-public')?.actualFailed)
        .toEqual(['public/retry-after-failure', 'public/sync-throw-becomes-rejection']);
      expect(report.phases.find(phase => phase.name === 'starter-hidden')?.actualFailed)
        .toEqual(['hidden/no-cache-of-rejected-attempt', 'hidden/retry-then-coalesce-again']);
      for (const name of ['reference-public', 'reference-hidden', 'alternative-public', 'alternative-hidden']) {
        expect(report.phases.find(phase => phase.name === name)).toMatchObject({ actualFailed: [], exitCode: 0 });
      }
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('题目状态与题目包资产一致', () => {
  it('非 designed 的题目必须有可校验的题目包，designed 的题目不得有 manifest', () => {
    // 状态必须与磁盘上的题目包一一对应，避免“加了夹具没更新状态”或反之。
    const ready = tasks.filter(task => task.status !== 'designed');
    const packaged = readdirSync(join(repositoryRoot, 'tasks', 'core'))
      .filter(name => existsSync(join(repositoryRoot, 'tasks', 'core', name, 'manifest.json')));
    expect(ready.map(task => task.id).sort()).toEqual(packaged.sort());
    for (const task of ready) {
      const manifest = readManifest(task.id);
      expect(manifest.taskId).toBe(task.id);
      expect(manifest.taskVersion).toBe(task.version);
      expect(manifest.runtime).toBe(task.runtime);
    }
    for (const task of tasks.filter(item => item.status === 'designed')) {
      expect(existsSync(join(taskPackageDir(task.id), 'manifest.json'))).toBe(false);
    }
  });
});
