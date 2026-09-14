import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportWorkspace, repositoryRoot, verifyTaskPackage } from '../packages/tasks/src/index.ts';
import { tasks } from '../packages/catalog/src/index.ts';

const [command, ...args] = process.argv.slice(2);
const usage = '用法：tsx scripts/task.ts export <题目 ID> <目标目录> | tsx scripts/task.ts export --tasks ID1,ID2 <目标根目录> | tsx scripts/task.ts export --all <目标根目录> | tsx scripts/task.ts verify <题目 ID> [--keep]';

function splitTaskIds(value: string): string[] {
  const ids = value.split(/[,,\s]+/).map(item => item.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('至少指定一道题。');
  if (new Set(ids).size !== ids.length) throw new Error('题目 ID 不得重复。');
  return ids;
}

function exportTasks(taskIds: string[], destinationRoot: string): void {
  const root = destinationRoot;
  if (existsSync(root) && !readdirSync(root).length) {
    // 空目录可直接使用；每个题目仍由 exportWorkspace 再次校验为空。
  } else if (existsSync(root) && readdirSync(root).some(name => name === 'batch-manifest.json')) {
    throw new Error(`目标根目录已存在 batch-manifest.json，为避免覆盖请换一个目录：${root}`);
  }
  mkdirSync(root, { recursive: true });
  const records = taskIds.map(taskId => exportWorkspace(taskId, join(root, taskId)));
  const manifest = {
    schemaVersion: '0.1.0',
    createdAt: new Date().toISOString(),
    destination: root,
    tasks: records.map(record => ({ taskId: record.taskId, directory: record.destination, files: record.files })),
    instructions: '请让每个编程 Agent 只修改对应题目目录；完成后使用 bench submit <题目 ID> <目录> --by <agent-id> 提交评分。',
  };
  writeFileSync(join(root, 'batch-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已批量导出 ${records.length} 道题到：${root}`);
  for (const record of records) console.log(`  ${record.taskId}：${record.destination}`);
  console.log(`清单：${join(root, 'batch-manifest.json')}`);
}

try {
  if (command === 'export') {
    const tasksIndex = args.indexOf('--tasks');
    const all = args.includes('--all');
    if (tasksIndex >= 0 && all) throw new Error('--tasks 与 --all 不能同时使用。');
    if (tasksIndex >= 0) {
      const taskSpec = args[tasksIndex + 1];
      const target = args[tasksIndex + 2];
      if (!taskSpec || !target || args.some((arg, index) => index !== tasksIndex && index !== tasksIndex + 1 && index !== tasksIndex + 2 && arg.startsWith('--'))) throw new Error(usage);
      exportTasks(splitTaskIds(taskSpec), target);
    } else if (all) {
      const target = args.find(arg => !arg.startsWith('--'));
      if (!target || args.filter(arg => !arg.startsWith('--')).length !== 1) throw new Error(usage);
      exportTasks(tasks.filter(task => task.status !== 'designed').map(task => task.id), target);
    } else {
      const [argument, target] = args;
      if (!argument || !target || args.length !== 2) throw new Error(usage);
      if (argument.includes(',')) {
        exportTasks(splitTaskIds(argument), target);
      } else {
        const record = exportWorkspace(argument, target);
        console.log(`已导出 ${record.taskId} 候选工作区：${record.destination}`);
        console.log(record.files.map(file => `  ${file}`).join('\n'));
      }
    }
  } else if (command === 'verify' && args[0]) {
    const argument = args[0];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const artifactDir = join(repositoryRoot, 'data', 'task-runs', argument, stamp);
    mkdirSync(artifactDir, { recursive: true });
    const report = verifyTaskPackage({
      taskId: argument,
      artifactDir,
      ...(process.argv.includes('--keep') ? { keepWorkspace: true } : {}),
    });
    writeFileSync(join(artifactDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    for (const phase of report.phases) {
      console.log(`${phase.ok ? '通过' : '不通过'} ${phase.name}：exit=${phase.exitCode}，实际失败=[${phase.actualFailed.join(', ')}]，预期失败=[${phase.expectedFailed.join(', ')}]，缺失=[${phase.missing.join(', ')}]`);
    }
    console.log(`隐藏资产未导出：${report.hiddenAssetsExcluded ? '是' : '否'}`);
    console.log(`报告与原始输出：${artifactDir}`);
    console.log(report.ok ? `${report.taskId} 三向验证通过。` : `${report.taskId} 三向验证未通过。`);
    if (!report.ok) process.exitCode = 1;
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
