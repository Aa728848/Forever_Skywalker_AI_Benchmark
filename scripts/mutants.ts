import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest, repositoryRoot } from '../packages/tasks/src/index.ts';
import { verifyMutants } from '../packages/tasks/src/mutations.ts';

try {
  const [taskId] = process.argv.slice(2);
  if (!taskId || process.argv.length !== 3) throw new Error('用法：pnpm task:mutants <题目 ID>');
  readManifest(taskId);
  const directory = join(repositoryRoot, 'data', 'task-mutations', taskId, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(directory, { recursive: true });
  const report = verifyMutants(taskId, directory);
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const item of report.variants) console.log(`${item.matchesExpected ? '通过' : '不通过'} ${item.id}：预期=[${item.expectedFailures.join(', ')}]，实际=[${item.failed.join(', ')}]，有效=${item.valid}`);
  console.log(`近似错误修复检出 ${report.detected}/${report.expected}；记录：${directory}`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
