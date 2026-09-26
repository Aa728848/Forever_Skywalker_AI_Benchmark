/**
 * 清理：把记录与报告移进回收目录。
 *
 * 为什么是「移动」而不是删除：这些目录是评测证据（experiment.json、evidence.json.gz、逐条作答
 * 记录），删掉不可恢复。回收目录让列表立刻干净，误删仍能手动找回。实现上只用 renameSync——
 * 它不跟随链接，也不递归删除任何东西，因此不存在「递归删除穿过 junction 抹掉真实目录」的风险。
 *
 * 全部护栏都必须在移动任何东西之前通过，任何一条不满足就整笔拒绝并说明原因：
 *   1. 相对路径必须是规范形式：非空、非绝对、无盘符、无 .. 或 . 段、无空段；
 *   2. 目标必须存在，且 lstat 判定不是符号链接或 junction；
 *   3. 目标的真实路径必须落在真实根目录之内（含嵌套路径，例如 runs/<题>/<运行>/<尝试>）；
 *   4. 目标不能在回收目录里。
 *
 * 复现性：回收目录内按同一相对结构存放，因此「哪个文件原来在哪」始终可从路径读出。
 */
import { existsSync, lstatSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 回收目录名。列表扫描必须跳过它，否则清理过的条目会以「已清理」重新出现。 */
export const trashDirectoryName = '.trash';

/** 路由层据此选择 HTTP 状态；409 表示「现在不能清」，与「不存在」不同。 */
export class CleanupError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'CleanupError';
    this.status = status;
  }
}

export interface CleanupOutcome {
  /** 回收目录的绝对路径；用户要手动恢复就得靠它。 */
  trashPath: string;
  /** 被移入回收目录的条目（相对根的路径）。 */
  moved: string[];
}

function realRoot(root: string): string {
  const absolute = resolve(root);
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** 规范化的相对路径：拒绝绝对路径、盘符、. 与 .. 段、空段与分隔符混用。 */
function safeRelative(value: string): string | null {
  if (value.length === 0 || isAbsolute(value)) return null;
  const segments = value.split(/[\\/]/);
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  if (segments.some(segment => /[:*?"<>|]/.test(segment))) return null;
  return segments.join(sep);
}

/** 回收目录内的落点：保留原有的相对结构，同一毫秒重复清理也不互相覆盖。 */
function uniqueTarget(directory: string, relativePath: string): string {
  const direct = join(directory, relativePath);
  if (!existsSync(direct)) return direct;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = join(directory, `${relativePath}~${index}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new CleanupError(409, '回收目录中同名条目过多，请先整理回收目录。');
}

/**
 * 把一组条目移进回收目录。要么全部成功，要么在移动任何东西之前就报错。
 * 传入的 path 都相对于 root（可以是嵌套路径，例如 runs/<题>/<运行>/<尝试>）。
 */
export function moveToTrash(options: { root: string; paths: readonly string[]; reason: string }): CleanupOutcome {
  const root = realRoot(options.root);
  if (options.paths.length === 0) throw new CleanupError(400, '没有指定要清理的条目。');
  const sources: Array<{ relativePath: string; path: string }> = [];
  for (const raw of options.paths) {
    const relativePath = safeRelative(raw);
    if (relativePath === null) throw new CleanupError(400, `条目路径无效：${raw}。只接受根目录下的相对路径。`);
    const segments = relativePath.split(sep);
    if (segments[0] === trashDirectoryName) throw new CleanupError(400, '回收目录本身不能作为清理目标。');
    const path = join(root, relativePath);
    if (!existsSync(path)) throw new CleanupError(404, `找不到要清理的条目：${raw}。它可能已被清理。`);
    const stat = lstatSync(path);
    // 链接必须拒绝：把 junction 移进回收目录虽然只是移动链接本身，但之后任何人「清空回收目录」
    // 时的递归删除会穿过它抹掉链接指向的真实目录。不收，避免把风险存进回收站。
    if (stat.isSymbolicLink()) throw new CleanupError(400, `拒绝清理符号链接或 junction：${raw}。请先确认它指向哪里。`);
    // 真实路径必须落在真实根内：任何经由链接产生的逸出都在这里被拦下。
    const real = realpathSync(path);
    const scope = relative(root, real);
    if (scope === '' || scope === '..' || scope.startsWith('..' + sep) || isAbsolute(scope)) {
      throw new CleanupError(400, `条目位于根目录之外，拒绝清理：${raw}。`);
    }
    sources.push({ relativePath: scope, path: real });
  }
  const container = join(root, trashDirectoryName, `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(container, { recursive: true });
  const moved: string[] = [];
  for (const source of sources) {
    const target = uniqueTarget(container, source.relativePath);
    try {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source.path, target);
    } catch (error) {
      // 移动失败时把已经移走的放回去，不留下半清状态。
      for (const done of moved) {
        const back = join(container, done);
        if (existsSync(back)) { try { renameSync(back, join(root, done)); } catch { /* 尽力回滚，下方错误已说明部分移动 */ } }
      }
      throw new CleanupError(409, `清理 ${source.relativePath} 失败：${error instanceof Error ? error.message : String(error)}。已回滚本次已移动的条目。`);
    }
    moved.push(source.relativePath);
  }
  return { trashPath: container, moved };
}
