import { readFileSync } from 'node:fs';
import { difficulties, tasksValidator, type Task } from '@fsa/contracts';

const input: unknown = JSON.parse(readFileSync(new URL('../../../catalog/tasks.json', import.meta.url), 'utf8'));
if (!tasksValidator.Check(input)) throw new Error('题库不符合 Task 协议。');
export const tasks: ReadonlyArray<Task> = input;
if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('题目 ID 重复。');
const core = tasks.filter(task => task.track === 'core');
const integration = tasks.filter(task => task.track === 'integration');
// 题库规模：12 个核心能力域各保留一道深度题，集成题覆盖保留的来源项目。
// 难度标签按实测通过率分配，不再要求每个域凑满四级——一题一域时四级覆盖无法成立。
if (core.length !== 12) throw new Error(`核心题必须为 12 道（每个能力域一道），实际 ${core.length} 道。`);
if (integration.length !== 4) throw new Error(`集成题必须为 4 道，实际 ${integration.length} 道。`);
const domainCounts = new Map<string, number>();
for (const task of core) domainCounts.set(task.domain, (domainCounts.get(task.domain) ?? 0) + 1);
if (domainCounts.size !== 12) throw new Error(`核心题必须覆盖 12 个能力域，实际 ${domainCounts.size} 个。`);
for (const [domain, count] of domainCounts) {
  if (count !== 1) throw new Error(`${domain} 必须恰好有一道核心题，实际 ${count} 道。`);
}
for (const difficulty of difficulties) {
  if (!core.some(task => task.difficulty === difficulty)) throw new Error(`难度层级 ${difficulty} 没有对应核心题。`);
}

export function requireTask(id: string): Task {
  const task = tasks.find(item => item.id === id);
  if (!task) throw new Error(`未知题目：${id}`);
  return task;
}
