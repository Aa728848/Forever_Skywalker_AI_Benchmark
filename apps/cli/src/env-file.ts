import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

export interface ProjectEnvironmentSnapshot {
  readonly path: string;
  readonly text: string | null;
  readonly fileValues: Record<string, string>;
  readonly effectiveEnv: NodeJS.ProcessEnv;
  /** 调用方提供的继承环境副本；保存后依旧优先，不读取另一份全局环境。 */
  readonly inheritedEnv: NodeJS.ProcessEnv;
  readonly revision: string | null;
}

export class EnvironmentFileConflictError extends Error {
  constructor() { super('.env 已被其它操作更改或正在保存，请重新读取配置后再试。'); this.name = 'EnvironmentFileConflictError'; }
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function readState(path: string): { text: string | null; revision: string | null } {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('.env 必须是普通文件，不能通过符号链接写入配置。');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
    const after = lstatSync(path);
    const revision = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    if (revision(before) !== revision(after)) throw new EnvironmentFileConflictError();
    return { text, revision: revision(after) };
  } catch (error) {
    if (missing(error)) return { text: null, revision: null };
    if (error instanceof EnvironmentFileConflictError) throw error;
    throw new Error('无法安全读取 .env，请确认它是可读的 UTF-8 普通文件。');
  }
}

function parse(text: string | null): Record<string, string> {
  try { return Object.assign(Object.create(null) as Record<string, string>, parseEnv(text ?? '')); }
  catch { throw new Error('无法解析 .env，原文件保持不变。'); }
}

function merge(fileValues: Record<string, string>, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nameOf = (name: string) => process.platform === 'win32' ? name.toUpperCase() : name;
  const result: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(fileValues).map(([name, value]) => [nameOf(name), value]));
  for (const [name, value] of Object.entries(inherited)) {
    const fileName = nameOf(name);
    if (value !== undefined && value.trim() !== '') result[fileName] = value;
    else if (result[fileName] === undefined) result[fileName] = value;
  }
  return result;
}

/** 不输出任何变量值。trim后非空的继承变量优先；空白值允许文件补齐，实际值不裁剪。 */
export function readProjectEnvironment(root: string, inheritedEnv: NodeJS.ProcessEnv = process.env): ProjectEnvironmentSnapshot {
  const path = join(realpathSync(root), '.env');
  const state = readState(path);
  const fileValues = parse(state.text);
  const inherited = { ...inheritedEnv };
  return { path, ...state, fileValues, inheritedEnv: inherited, effectiveEnv: merge(fileValues, inherited) };
}

/** Node dotenv没有通用引号转义；逐种表达并用同一个解析器验证，不能无损表达就拒绝。 */
function encode(name: string, value: string): string {
  if (value.includes('\0')) throw new Error('环境变量值含不支持的字符，无法无损保存。');
  const candidates = [value, ...["'", '"', '`'].filter(quote => !value.includes(quote)).map(quote => quote + value + quote)];
  for (const candidate of candidates) {
    const parsed = parseEnv(`${name}=${candidate}\n`);
    if (Object.keys(parsed).length === 1 && Object.hasOwn(parsed, name) && parsed[name] === value) return candidate;
  }
  throw new Error('环境变量值无法用 Node dotenv 无损表达，请改用操作系统环境变量。');
}

interface EmptyAssignment { start: number; end: number; comment: boolean }

/** 只定位空值的最后一次赋值，跨行引号中的“KEY=”从不被当成配置行。 */
function emptyAssignments(text: string): Map<string, EmptyAssignment | null> {
  const assignments = new Map<string, EmptyAssignment | null>();
  let offset = 0;
  let multilineQuote: string | undefined;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0]; if (line === '') break;
    const body = line.replace(/\r?\n$/, '');
    if (multilineQuote !== undefined) {
      if (body.includes(multilineQuote)) multilineQuote = undefined;
      offset += line.length; continue;
    }
    const assignment = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(body);
    if (assignment) {
      const name = assignment[1]!;
      const start = assignment[0].length;
      const quote = body[start];
      assignments.set(name, null);
      if (quote === "'" || quote === '"' || quote === '`') {
        const end = body.indexOf(quote, start + 1);
        if (end < 0) multilineQuote = quote;
        else if (parseEnv(body)[name]?.trim() === '') assignments.set(name, { start: offset + start, end: offset + end + 1, comment: false });
      } else if (parseEnv(body)[name]?.trim() === '') {
        assignments.set(name, { start: offset + start, end: offset + start, comment: body[start] === '#' });
      }
    }
    offset += line.length;
  }
  return assignments;
}

function updatedText(snapshot: ProjectEnvironmentSnapshot, updates: Record<string, string>): string | null {
  const text = snapshot.text ?? '';
  const spans = emptyAssignments(text);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const appended: string[] = [];
  const expected = { ...snapshot.fileValues };
  const changedNames = new Set<string>();
  for (const [requestedName, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(requestedName) || typeof value !== 'string') throw new Error('环境变量名称或值类型无效，原文件保持不变。');
    const normalize = (name: string) => process.platform === 'win32' ? name.toUpperCase() : name;
    const aliases = Object.keys(snapshot.fileValues).filter(name => normalize(name) === normalize(requestedName));
    if (value.trim() === '' || aliases.some(name => snapshot.fileValues[name]!.trim() !== '')) continue;
    if (aliases.length > 1 || changedNames.has(normalize(requestedName))) throw new Error('环境变量名称存在重复或大小写歧义，原文件保持不变。');
    changedNames.add(normalize(requestedName));
    const name = aliases[0] ?? requestedName;
    const encoded = encode(name, value);
    if (Object.hasOwn(snapshot.fileValues, name)) {
      const span = spans.get(name);
      if (!span) throw new Error('无法安全定位 .env 中的空值赋值，原文件保持不变。');
      replacements.push({ start: span.start, end: span.end, value: encoded + (span.comment ? ' ' : '') });
    } else appended.push(`${name}=${encoded}`);
    expected[name] = value;
  }
  if (replacements.length === 0 && appended.length === 0) return snapshot.text;
  let next = text;
  for (const item of replacements.sort((a, b) => b.start - a.start)) next = next.slice(0, item.start) + item.value + next.slice(item.end);
  if (appended.length > 0) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    next += (next === '' || next.endsWith('\n') ? '' : newline) + appended.join(newline) + newline;
  }
  const actual = parse(next);
  if (Object.keys(actual).length !== Object.keys(expected).length || Object.entries(expected).some(([name, value]) => actual[name] !== value)) {
    throw new Error('保存会改变其它 .env 字段，已拒绝写入。');
  }
  return next;
}

function assertCurrent(path: string, snapshot: ProjectEnvironmentSnapshot): void {
  const state = readState(path);
  if (state.text !== snapshot.text || state.revision !== snapshot.revision) throw new EnvironmentFileConflictError();
}

/** 只补缺失/空值；返回新effectiveEnv供当前启动流程及其子进程使用，不隐式修改process.env。 */
export function saveProjectEnvironment(root: string, updates: Record<string, string>, priorSnapshot: ProjectEnvironmentSnapshot): ProjectEnvironmentSnapshot {
  const path = join(realpathSync(root), '.env');
  if (priorSnapshot.path !== path) throw new Error('环境快照不属于当前项目，已拒绝写入。');
  assertCurrent(path, priorSnapshot);
  const next = updatedText(priorSnapshot, updates);
  if (next === priorSnapshot.text) return readProjectEnvironment(root, priorSnapshot.inheritedEnv);
  const lockPath = path + '.fsa-lock';
  let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') throw new EnvironmentFileConflictError();
    throw new Error('无法锁定 .env 进行保存，请检查项目目录的写入权限。');
  }
  const temporary = join(dirname(path), `.env.fsa-${randomUUID()}.tmp`);
  let created = false;
  try {
    assertCurrent(path, priorSnapshot);
    const mode = priorSnapshot.text === null ? 0o600 : lstatSync(path).mode & 0o777;
    const descriptor = openSync(temporary, 'wx', mode); created = true;
    try { writeFileSync(descriptor, next!, { flush: true }); }
    finally { closeSync(descriptor); }
    assertCurrent(path, priorSnapshot);
    renameSync(temporary, path); created = false;
    return readProjectEnvironment(root, priorSnapshot.inheritedEnv);
  } catch (error) {
    if (error instanceof EnvironmentFileConflictError) throw error;
    throw new Error('.env 保存失败，未完成安全写入或替换。');
  } finally {
    try { if (created) unlinkSync(temporary); }
    finally { closeSync(lock); unlinkSync(lockPath); }
  }
}
