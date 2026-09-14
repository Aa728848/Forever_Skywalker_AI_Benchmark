import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionResult, TaskManifest } from '@fsa/contracts';
import { scoreExecution } from '@fsa/core';
import { createScriptedJudge, sampleVerdict, type ReviewRequest } from '@fsa/judge';
import { analyzeWorkspace, defaultPolicy, staticRuleVersion, type StaticPolicy } from './index.ts';

const policy: StaticPolicy = {
  language: 'typescript',
  maxDecisionPointsPerFunction: 3,
  maxFunctionLines: 8,
  forbiddenImports: ['node:child_process'],
  evidenceId: 'static-report',
};

function workspace(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-static-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(directory, name.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  return directory;
}

describe('静态客观分', () => {
  it('干净实现得满分并带上规则版本与证据 id', () => {
    const directory = workspace({ 'src/clean.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' });
    try {
      const report = analyzeWorkspace(directory, policy);
      expect(report.ruleVersion).toBe(staticRuleVersion);
      expect(report.evidenceId).toBe('static-report');
      expect(report.violations).toEqual([]);
      expect(report.scores).toEqual({ simplicity: 100, maintainability: 100, decoupling: 100 });
      expect(report.files[0]?.path).toBe('src/clean.ts');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('决策点过多的函数扣简洁度并留下违规说明', () => {
    const body = 'export function branchy(value: number): number {\n  if (value > 1 && value < 10 || value === 3) return 1;\n  if (value > 20) return 2;\n  if (value > 30) return 3;\n  return 0;\n}\n';
    const directory = workspace({ 'src/branchy.ts': body });
    try {
      const report = analyzeWorkspace(directory, policy);
      expect(report.scores.simplicity).toBe(90);
      expect(report.violations.join(' ')).toContain('决策点');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('过长的函数扣可维护性，禁止导入扣解耦', () => {
    const long = 'export function verbose(): number {\n' + '  const x = 1;\n'.repeat(10) + '  return x;\n}\n';
    const forbidden = 'import { spawn } from \'node:child_process\';\nexport function run(): void { spawn(\'ls\'); }\n';
    const directory = workspace({ 'src/long.ts': long, 'src/host.ts': forbidden });
    try {
      const report = analyzeWorkspace(directory, policy);
      expect(report.scores.maintainability).toBe(95);
      expect(report.scores.decoupling).toBe(75);
      expect(report.violations.join(' ')).toContain('node:child_process');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('拒绝不支持的语言规则', () => {
    const directory = workspace({});
    try {
      expect(() => analyzeWorkspace(directory, { ...policy, language: 'rust' as 'typescript' })).toThrow(RangeError);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('空工作区拒绝产出虚构满分', () => {
    const directory = workspace({});
    try {
      expect(() => analyzeWorkspace(directory, policy)).toThrow(/没有可分析/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('按AST测量箭头、方法、嵌套函数，字符串和注释不会制造决策点', () => {
    const directory = workspace({ 'src/view.tsx': `
      const arrow = value => value ? 1 : 0;
      class Subject { test(value: boolean) { return value && true; } }
      function outer() { const inner = () => { if (true) return "if || ? }"; }; return inner; }
      const view = () => <span title="if && || ?">test</span>;
    ` });
    try {
      const report = analyzeWorkspace(directory, policy);
      expect(report.files[0]?.functions.map(fn => [fn.name, fn.decisionPoints])).toEqual([
        ['arrow', 1], ['test', 1], ['outer', 0], ['inner', 1], ['view', 0],
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('禁止导入覆盖side-effect、require及node别名，不扫描注释与平台检查', () => {
    const directory = workspace({ 'src/x.ts': `import 'child_process';\nconst module = require('node:child_process');\n// import 'node:child_process';`,
      'public-tests/check.ts': `import 'node:child_process';` });
    try {
      const report = analyzeWorkspace(directory, policy);
      expect(report.files).toHaveLength(1);
      expect(report.scores.decoupling).toBe(50);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('冻结分析范围不能越出工作区，语法损坏不能自动得到满分', () => {
    const directory = workspace({ 'src/x.ts': 'export function broken( {' });
    try {
      expect(() => analyzeWorkspace(directory, policy)).toThrow(/语法错误/);
      expect(() => analyzeWorkspace(directory, { ...policy, includeFiles: ['../outside.ts'] })).toThrow(/范围无效/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('Python 与 F# 语法树证据', () => {
  it('Python只解析源码，函数内决策不混入字符串，候选顶层副作用不会运行', () => {
    const directory = workspace({ 'src/source.py': `
from pathlib import Path
import subprocess
Path(__file__).with_suffix('.executed').write_text('must not run')
def outer(value):
    def inner():
        return 1 if value else 0
    if value and value > 1:
        return 'if while or and'
    return inner()
` });
    try {
      const report = analyzeWorkspace(directory, { ...defaultPolicy('python'), forbiddenImports: ['subprocess'] });
      expect(report.files[0]?.functions.map(fn => [fn.name, fn.decisionPoints])).toEqual([['outer', 2], ['inner', 1]]);
      expect(report.scores.decoupling).toBe(75);
      expect(existsSync(join(directory, 'src/source.executed'))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('F#使用SDK解析函数、方法与open依赖，不执行候选文件', () => {
    const directory = workspace({ 'src/Source.fsx': `
open System.IO
File.WriteAllText(__SOURCE_DIRECTORY__ + "/source.executed", "must not run")
let outer value =
    let inner () = if value then 1 else 0
    let branch = if value then 1 else 0
    if value && branch > 0 then "if while" else "x"
type Subject() =
    member _.Run(value) = if value then 1 else 0
` });
    try {
      const report = analyzeWorkspace(directory, { ...defaultPolicy('fsharp'), forbiddenImports: ['System.IO'] });
      expect(report.files[0]?.functions.map(fn => [fn.name, fn.decisionPoints])).toEqual([['outer', 3], ['inner', 1], ['_.Run', 1]]);
      expect(report.scores.decoupling).toBe(75);
      expect(existsSync(join(directory, 'src/source.executed'))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it.each([['python', 'broken.py', 'def broken(:'], ['fsharp', 'Broken.fsx', 'let broken = (']] as const)('%s语法错误不产生质量满分', (language, file, source) => {
    const directory = workspace({ [file]: source });
    try { expect(() => analyzeWorkspace(directory, defaultPolicy(language))).toThrow(/解析失败/); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});

describe('静态客观分接入评分桥', () => {
  it('静态客观分 + 评审分能算出质量分与总分', async () => {
    const directory = workspace({ 'src/clean.ts': 'export const value = 1;\n' });
    try {
      const report = analyzeWorkspace(directory, policy);
      const request: ReviewRequest = { runId: 'run-1', attemptId: 'attempt-1', taskId: 'CACHE-02', promptVersion: 'review-v1', materials: [{ id: 'candidate-1', kind: 'candidate', text: 'export const value = 1;' }] };
      const judge = createScriptedJudge([JSON.stringify(sampleVerdict(request, { simplicity: 80, maintainability: 80, decoupling: 80, performance: 80 }, ['candidate-1']))]);
      const outcome = await judge.review(request);
      expect(outcome.verdict.dimensions.simplicity.score).toBe(80);
      const manifest = {
        schemaVersion: '0.1.0', taskId: 'CACHE-02', taskVersion: '0.1.0', title: 'T', runtime: 'typescript', runtimeRange: 'node >=24',
        workspace: { entries: [{ from: 'task.md', to: 'TASK.md' }] },
        commands: { public: ['node', 'x'], hidden: ['node', 'y'] },
        grader: { checks: 'graders/CACHE-02/checks', referencePatch: 'graders/CACHE-02/reference.patch', alternative: 'graders/CACHE-02/alternative', defectDetectors: ['public/behavior'] },
        limits: { timeoutMs: 60000, memoryMb: 512, cpus: 1, network: false },
        checks: [
          { id: 'public/behavior', kind: 'public', group: 'behavior', weight: 1, critical: true, summary: 'x' },
          { id: 'public/boundary', kind: 'public', group: 'boundary', weight: 1, critical: false, summary: 'x' },
          { id: 'public/state', kind: 'public', group: 'state', weight: 1, critical: false, summary: 'x' },
          { id: 'public/regression', kind: 'public', group: 'regression', weight: 1, critical: false, summary: 'x' },
          { id: 'public/resources', kind: 'public', group: 'resources', weight: 1, critical: false, summary: 'x' },
        ],
      } as TaskManifest;
      const execution = {
        schemaVersion: '0.1.0', runId: 'run-1', attemptId: 'attempt-1', taskId: 'CACHE-02', taskVersion: '0.1.0',
        candidateTreeHash: 'a'.repeat(64), classification: 'passed', isolation: 'none',
        startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', durationMs: 1,
        environment: { profile: 'local', image: null, imageDigest: null, platform: 'test', platformVersion: 'v24', candidateRuntimes: ['node'], containerRuntime: null, cpus: 1, totalMemoryMb: 1, network: false },
        phases: [], artifacts: [], evidenceRefs: [], notes: [],
        checks: [
          { id: 'public/behavior', kind: 'public', group: 'behavior', critical: true, status: 'passed', durationMs: 1 },
          { id: 'public/boundary', kind: 'public', group: 'boundary', critical: false, status: 'passed', durationMs: 1 },
          { id: 'public/state', kind: 'public', group: 'state', critical: false, status: 'passed', durationMs: 1 },
          { id: 'public/regression', kind: 'public', group: 'regression', critical: false, status: 'passed', durationMs: 1 },
          { id: 'public/resources', kind: 'public', group: 'resources', critical: false, status: 'passed', durationMs: 1 },
        ],
      } as unknown as ExecutionResult;
      const score = scoreExecution(execution, manifest, {
        objective: {
          simplicity: { score: report.scores.simplicity, evidence: [report.evidenceId], kind: 'static' },
          maintainability: { score: report.scores.maintainability, evidence: [report.evidenceId], kind: 'static' },
          decoupling: { score: report.scores.decoupling, evidence: [report.evidenceId], kind: 'static' },
          performance: { score: 100, evidence: ['benchmark-1'], kind: 'benchmark' },
        },
        review: {
          simplicity: { score: 80, evidence: ['review-1'] }, maintainability: { score: 80, evidence: ['review-1'] },
          decoupling: { score: 80, evidence: ['review-1'] }, performance: { score: 80, evidence: ['review-1'] },
        },
      });
      expect(score.functional).toBe(50);
      expect(score.dimensions).toEqual({ simplicity: 88, maintainability: 86, decoupling: 90, performance: 96 });
      expect(score.quality).toBeGreaterThan(0);
      expect(score.total).toBe((score.functional ?? 0) + (score.quality ?? 0));
      expect(score.thresholdMet).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
