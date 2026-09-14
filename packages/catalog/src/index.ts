import { readFileSync } from 'node:fs';
import { difficulties, tasksValidator, type Task } from '@fsa/contracts';

const input: unknown = JSON.parse(readFileSync(new URL('../../../catalog/tasks.json', import.meta.url), 'utf8'));
if (!tasksValidator.Check(input)) throw new Error('题库不符合 Task 协议。');
export const tasks: ReadonlyArray<Task> = input;
if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('题目 ID 重复。');
const core = tasks.filter(task => task.track === 'core');
if (core.length !== 48 || tasks.length !== 55) throw new Error('初始题库必须包含 48 道核心题与 7 道集成题。');
for (const domain of new Set(core.map(task => task.domain))) {
  for (const difficulty of difficulties) {
    if (core.filter(task => task.domain === domain && task.difficulty === difficulty).length !== 1) throw new Error(`${domain} 的四级覆盖不完整。`);
  }
}

export function requireTask(id: string): Task {
  const task = tasks.find(item => item.id === id);
  if (!task) throw new Error(`未知题目：${id}`);
  return task;
}
