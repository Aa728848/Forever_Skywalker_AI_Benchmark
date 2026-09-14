import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * 静态客观分：规则与阈值由题目/语言冻结后以数据传入，本模块只负责测量。
 * 规则刻意保持简单且公开：词法级函数体识别 + 决策点计数 + 禁止导入计数。
 * 已知限制：不解析 AST，只剥离块注释、行注释与模板字符串；升级规则必须提升规则版本并重新校准阈值。
 */
export const staticRuleVersion = '0.1.0';

export interface StaticPolicy {
  readonly language: 'typescript';
  readonly maxDecisionPointsPerFunction: number;
  readonly maxFunctionLines: number;
  readonly forbiddenImports: readonly string[];
  readonly evidenceId: string;
}

export interface FunctionFacts {
  readonly name: string;
  readonly lines: number;
  readonly decisionPoints: number;
}

export interface FileFacts {
  readonly path: string;
  readonly lines: number;
  readonly functions: readonly FunctionFacts[];
  readonly imports: readonly string[];
}

export interface StaticReport {
  readonly ruleVersion: string;
  readonly evidenceId: string;
  readonly files: readonly FileFacts[];
  readonly violations: readonly string[];
  readonly scores: { readonly simplicity: number; readonly maintainability: number; readonly decoupling: number };
}

const decisionTokens = ['if', 'while', 'for', 'case', 'catch'];
const symbolicTokens = ['&&', '||', '?'];

function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`[^`]*`/g, '``');
}

function countDecisions(body: string): number {
  let count = 0;
  for (const token of decisionTokens) {
    const pattern = new RegExp('\\b' + token + '\\b', 'g');
    count += (body.match(pattern) ?? []).length;
  }
  for (const token of symbolicTokens) count += body.split(token).length - 1;
  return count;
}

function importsOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*)['\"]([^'\"]+)['\"]/g;
  for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  return found;
}

function functionsOf(source: string): FunctionFacts[] {
  const facts: FunctionFacts[] = [];
  const pattern = /(?:function\s+([A-Za-z0-9_$]+)?\s*\([^)]*\)|([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/g;
  for (const match of source.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const brace = source.indexOf('{', start);
    if (brace < 0) continue;
    let depth = 0;
    let end = brace;
    for (let index = brace; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    const body = source.slice(brace, end + 1);
    facts.push({ name: match[1] ?? match[2] ?? 'anonymous', lines: body.split('\n').length, decisionPoints: countDecisions(body) });
  }
  return facts;
}

function sourceFiles(root: string, current = root, acc: string[] = []): string[] {
  for (const entry of readdirSync(current).sort()) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const absolute = join(current, entry);
    if (statSync(absolute).isDirectory()) sourceFiles(root, absolute, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) acc.push(relative(root, absolute).split(sep).join('/'));
  }
  return acc;
}

const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

/**
 * TypeScript 起步策略：阈值是**未经校准**的初始值，只用于把链路跑通；
 * 正式发布前必须按题族用真实作答分布校准并提升规则版本。
 */
export function defaultTypeScriptPolicy(evidenceId = 'static-report'): StaticPolicy {
  return {
    language: 'typescript',
    maxDecisionPointsPerFunction: 12,
    maxFunctionLines: 60,
    forbiddenImports: ['node:child_process', 'node:worker_threads'],
    evidenceId,
  };
}

export function analyzeWorkspace(root: string, policy: StaticPolicy): StaticReport {
  if (policy.language !== 'typescript') throw new RangeError('当前静态规则只支持 typescript。');
  const files: FileFacts[] = [];
  const violations: string[] = [];
  let overComplex = 0;
  let overLong = 0;
  let forbiddenHits = 0;
  for (const path of sourceFiles(root)) {
    const source = readFileSync(join(root, path), 'utf8');
    const functions = functionsOf(stripNoise(source));
    const imports = importsOf(source);
    files.push({ path, lines: source.split('\n').length, functions, imports });
    for (const fn of functions) {
      if (fn.decisionPoints > policy.maxDecisionPointsPerFunction) {
        overComplex += 1;
        violations.push(path + ':' + fn.name + ' 决策点 ' + fn.decisionPoints + ' 超过阈值 ' + policy.maxDecisionPointsPerFunction);
      }
      if (fn.lines > policy.maxFunctionLines) {
        overLong += 1;
        violations.push(path + ':' + fn.name + ' 长度 ' + fn.lines + ' 行超过阈值 ' + policy.maxFunctionLines);
      }
    }
    for (const specifier of imports) {
      if (policy.forbiddenImports.some(rule => specifier === rule || specifier.startsWith(rule + '/'))) {
        forbiddenHits += 1;
        violations.push(path + ' 导入了禁止的模块 ' + specifier);
      }
    }
  }
  return {
    ruleVersion: staticRuleVersion,
    evidenceId: policy.evidenceId,
    files,
    violations,
    scores: {
      simplicity: clamp(100 - 10 * overComplex),
      maintainability: clamp(100 - 5 * overLong),
      decoupling: clamp(100 - 25 * forbiddenHits),
    },
  };
}
