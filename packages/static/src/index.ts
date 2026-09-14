import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 静态客观分：规则与阈值由题目/语言冻结后以数据传入，本模块只负责测量。
 * 规则保持公开：通过 TypeScript AST 识别函数、真实决策节点与模块导入，排除字符串和注释。
 * 0.2.0 修复词法规则漏报；阈值仍须按题族校准，不能把未经校准的分数当成正式成绩。
 */
export const staticRuleVersion = '0.2.0';

export interface StaticPolicy {
  readonly language: 'typescript' | 'python' | 'fsharp';
  readonly maxDecisionPointsPerFunction: number;
  readonly maxFunctionLines: number;
  readonly forbiddenImports: readonly string[];
  readonly evidenceId: string;
  /** 平台冻结的改动范围；不传时分析工作区源文件，排除平台检查与依赖。 */
  readonly includeFiles?: readonly string[];
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
  readonly policy: StaticPolicy;
  readonly files: readonly FileFacts[];
  readonly violations: readonly string[];
  readonly scores: { readonly simplicity: number; readonly maintainability: number; readonly decoupling: number };
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
}

function factsOf(source: ts.SourceFile): Pick<FileFacts, 'functions' | 'imports'> {
  const functions: FunctionFacts[] = [];
  const imports: string[] = [];
  const countDecisions = (root: ts.Node): number => {
    let count = 0;
    const visit = (node: ts.Node) => {
      if (node !== root && isFunction(node)) return;
      if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)
        || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCaseClause(node) || ts.isCatchClause(node)
        || ts.isConditionalExpression(node) || (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))) count += 1;
      ts.forEachChild(node, visit);
    };
    visit(root);
    return count;
  };
  const addModule = (node: ts.Node | undefined) => {
    if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) imports.push(node.text);
  };
  const visit = (node: ts.Node) => {
    if (isFunction(node) && node.body !== undefined) {
      const parentName = ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined;
      const name = node.name?.getText(source) ?? parentName?.getText(source) ?? 'anonymous';
      const first = source.getLineAndCharacterOfPosition(node.body.getStart(source)).line;
      const last = source.getLineAndCharacterOfPosition(node.body.getEnd()).line;
      functions.push({ name, lines: last - first + 1, decisionPoints: countDecisions(node.body) });
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addModule(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) addModule(node.moduleReference.expression);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) addModule(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { functions, imports };
}

function sourceFiles(root: string, language: StaticPolicy['language'], current = root, acc: string[] = []): string[] {
  for (const entry of readdirSync(current).sort()) {
    if (['node_modules', '.git', 'public-tests', '__checks__', '__pycache__', '.venv', 'bin', 'obj'].includes(entry)) continue;
    const absolute = join(current, entry);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('静态分析不接受符号链接：' + relative(root, absolute));
    if (stat.isDirectory()) sourceFiles(root, language, absolute, acc);
    else if (language === 'typescript' ? /\.[cm]?tsx?$/.test(entry) && !/\.d\.[cm]?ts$/.test(entry)
      : language === 'python' ? entry.endsWith('.py') : /\.fsx?$/.test(entry)) acc.push(relative(root, absolute).split(sep).join('/'));
  }
  return acc;
}

const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

/**
 * TypeScript 起步策略：阈值是**未经校准**的初始值，只用于把链路跑通；
 * 正式发布前必须按题族用真实作答分布校准并提升规则版本。
 */
export function defaultTypeScriptPolicy(evidenceId = 'static-report'): StaticPolicy {
  return defaultPolicy('typescript', evidenceId);
}

/** 各语言共享初始阈值只是可执行的测量策略，发布时必须各自校准并冻结。 */
export function defaultPolicy(language: StaticPolicy['language'], evidenceId = 'static-report'): StaticPolicy {
  return {
    language,
    maxDecisionPointsPerFunction: 12,
    maxFunctionLines: 60,
    forbiddenImports: [],
    evidenceId,
  };
}

function parseExternal(path: string, language: 'python' | 'fsharp'): Pick<FileFacts, 'functions' | 'imports'> {
  let command: string;
  let args: string[];
  if (language === 'python') {
    command = 'python';
    args = ['-I', '-B', fileURLToPath(new URL('./python-ast.py', import.meta.url)), path];
  } else {
    command = 'dotnet';
    const sdk = spawnSync(command, ['--list-sdks'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (sdk.error !== undefined || sdk.status !== 0) throw new Error('F# 静态分析需要可用的 .NET SDK。');
    const last = sdk.stdout.trim().split(/\r?\n/).at(-1)?.match(/^(\S+) \[(.+)\]$/);
    if (last === undefined || last === null) throw new Error('未发现 FSharp.Compiler.Service 所属的 SDK。');
    const reference = join(last[2]!, last[1]!, 'FSharp', 'FSharp.Compiler.Service.dll');
    args = ['fsi', '--nologo', '--readline-', '--reference:' + reference, '--exec', fileURLToPath(new URL('./fsharp-ast.fsx', import.meta.url)), path];
  }
  const parsed = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (parsed.error !== undefined || parsed.status !== 0) throw new Error(language + ' 静态解析失败（不执行候选代码）：' + (parsed.error?.message ?? parsed.stderr.trim()));
  return JSON.parse(parsed.stdout) as Pick<FileFacts, 'functions' | 'imports'>;
}

export function analyzeWorkspace(root: string, policy: StaticPolicy): StaticReport {
  if (!['typescript', 'python', 'fsharp'].includes(policy.language)) throw new RangeError('静态规则只支持 typescript、python 与 fsharp。');
  if (!Number.isInteger(policy.maxDecisionPointsPerFunction) || policy.maxDecisionPointsPerFunction < 0
    || !Number.isInteger(policy.maxFunctionLines) || policy.maxFunctionLines < 1 || policy.evidenceId.trim() === '') {
    throw new RangeError('静态策略的阈值或证据 ID 不合法。');
  }
  const files: FileFacts[] = [];
  const violations: string[] = [];
  let overComplex = 0;
  let overLong = 0;
  let forbiddenHits = 0;
  const available = sourceFiles(root, policy.language);
  const paths = policy.includeFiles === undefined ? available : [...new Set(policy.includeFiles)];
  if (paths.length === 0) throw new Error('没有可分析的 ' + policy.language + ' 源文件，静态分保持待定。');
  for (const path of paths) {
    const local = relative(resolve(root), resolve(root, path));
    if (isAbsolute(path) || local.startsWith('..' + sep) || local === '..' || !available.includes(path)) throw new Error('静态分析范围无效：' + path);
    const source = readFileSync(join(root, path), 'utf8');
    let measured: Pick<FileFacts, 'functions' | 'imports'>;
    if (policy.language === 'typescript') {
      const syntax = ts.transpileModule(source, { fileName: path, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve } }).diagnostics ?? [];
      if (syntax.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error('源文件存在语法错误，静态分保持待定：' + path);
      measured = factsOf(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true));
    } else measured = parseExternal(resolve(root, path), policy.language);
    const { functions, imports } = measured;
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
      const module = specifier.replace(/^node:/, '');
      if (policy.forbiddenImports.some(rule => module === rule.replace(/^node:/, '') || module.startsWith(rule.replace(/^node:/, '') + (policy.language === 'typescript' ? '/' : '.')))) {
        forbiddenHits += 1;
        violations.push(path + ' 导入了禁止的模块 ' + specifier);
      }
    }
  }
  return {
    ruleVersion: staticRuleVersion,
    evidenceId: policy.evidenceId,
    policy: structuredClone(policy),
    files,
    violations,
    scores: {
      simplicity: clamp(100 - 10 * overComplex),
      maintainability: clamp(100 - 5 * overLong),
      decoupling: clamp(100 - 25 * forbiddenHits),
    },
  };
}
