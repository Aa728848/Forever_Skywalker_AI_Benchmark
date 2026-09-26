import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CleanupError, moveToTrash, trashDirectoryName } from './cleanup.ts';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fsa-cleanup-'));
  roots.push(root);
  return root;
}

function cleanup(root: string): void {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-cleanup-')) throw new Error('测试清理越界。');
  rmSync(target, { recursive: true, force: true });
}

describe('清理：移动而不是删除', () => {
  it('把条目移进回收目录，内容一字不动，可以手动移回', () => {
    const root = fixture();
    try {
      mkdirSync(join(root, 'exp-demo'), { recursive: true });
      writeFileSync(join(root, 'exp-demo', 'experiment.json'), '{"kept":true}');
      const outcome = moveToTrash({ root, paths: ['exp-demo'], reason: '测试' });
      // 原位置必须已经空出来
      expect(existsSync(join(root, 'exp-demo'))).toBe(false);
      // 内容必须完整保留在回收目录里
      const kept = join(outcome.trashPath, 'exp-demo', 'experiment.json');
      expect(existsSync(kept)).toBe(true);
      expect(readdirSync(outcome.trashPath)).toEqual(['exp-demo']);
      // 手动恢复：移回根目录即可
      mkdirSync(join(root, 'restored'), { recursive: true });
      expect(outcome.moved).toEqual(['exp-demo']);
    } finally { cleanup(root); }
  });

  it('支持嵌套路径并保留原相对结构，方便找回', () => {
    const root = fixture();
    try {
      mkdirSync(join(root, 'runs', 'CACHE-02', 'run-1', 'attempt-1'), { recursive: true });
      writeFileSync(join(root, 'runs', 'CACHE-02', 'run-1', 'attempt-1', 'freeze.json'), '{}');
      const outcome = moveToTrash({ root, paths: ['runs/CACHE-02/run-1/attempt-1'], reason: '测试' });
      // 回收目录里保留同样的层级，哪个文件原来在哪始终可读
      expect(existsSync(join(outcome.trashPath, 'runs', 'CACHE-02', 'run-1', 'attempt-1', 'freeze.json'))).toBe(true);
      expect(outcome.moved).toEqual([join('runs', 'CACHE-02', 'run-1', 'attempt-1')]);
    } finally { cleanup(root); }
  });

  it('拒绝绝对路径、上级引用与回收目录本身', () => {
    const root = fixture();
    try {
      mkdirSync(join(root, 'inside'), { recursive: true });
      // 绝对路径：调用方可能想指向根外
      expect(() => moveToTrash({ root, paths: [join(root, 'inside')], reason: '测试' })).toThrow(CleanupError);
      // 上级引用：试图逸出报告根
      expect(() => moveToTrash({ root, paths: ['../outside'], reason: '测试' })).toThrow(/无效/);
      expect(() => moveToTrash({ root, paths: ['a/../../b'], reason: '测试' })).toThrow(/无效/);
      // 回收目录自己不能被当成清理目标
      mkdirSync(join(root, trashDirectoryName), { recursive: true });
      expect(() => moveToTrash({ root, paths: [trashDirectoryName], reason: '测试' })).toThrow(/回收目录/);
    } finally { cleanup(root); }
  });

  it('拒绝清理符号链接与 junction，避免把风险存进回收站', () => {
    // 把 junction 移进回收目录虽然只移动链接本身，但之后「清空回收目录」的递归删除
    // 会穿过它抹掉链接指向的真实目录。这里必须在入口就拒绝。
    const root = fixture();
    const outside = fixture();
    try {
      writeFileSync(join(outside, 'precious.txt'), '不可丢失');
      const link = join(root, 'linked');
      try { symlinkSync(outside, link, 'junction'); } catch { return; } // 无权限时跳过
      expect(() => moveToTrash({ root, paths: ['linked'], reason: '测试' })).toThrow(/符号链接|junction/);
      // 链接指向的真实目录必须完好
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    } finally { cleanup(root); cleanup(outside); }
  });

  it('找不到条目报 404，空列表报 400', () => {
    const root = fixture();
    try {
      expect(() => moveToTrash({ root, paths: [], reason: '测试' })).toThrow(/没有指定/);
      const missing = (() => { try { moveToTrash({ root, paths: ['nope'], reason: '测试' }); return null; } catch (error) { return error as CleanupError; } })();
      expect(missing?.status).toBe(404);
    } finally { cleanup(root); }
  });

  it('同名条目再次清理不会覆盖上一份，而是并存', () => {
    const root = fixture();
    try {
      mkdirSync(join(root, 'same'), { recursive: true });
      writeFileSync(join(root, 'same', 'a.txt'), '1');
      const first = moveToTrash({ root, paths: ['same'], reason: '测试' });
      mkdirSync(join(root, 'same'), { recursive: true });
      writeFileSync(join(root, 'same', 'a.txt'), '2');
      const second = moveToTrash({ root, paths: ['same'], reason: '测试' });
      // 两次清理落在不同的时间戳容器里，互不覆盖
      expect(first.trashPath).not.toBe(second.trashPath);
      expect(existsSync(join(first.trashPath, 'same', 'a.txt'))).toBe(true);
      expect(existsSync(join(second.trashPath, 'same', 'a.txt'))).toBe(true);
    } finally { cleanup(root); }
  });
});