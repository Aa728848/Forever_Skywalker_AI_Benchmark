import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportWorkspace, repositoryRoot, verifyTaskPackage } from '../packages/tasks/src/index.ts';

const [command, argument, target] = process.argv.slice(2);
const usage = '用法：tsx scripts/task.ts export <题目 ID> <目标目录> | tsx scripts/task.ts verify <题目 ID> [--keep]';

try {
  if (command === 'export' && argument && target) {
    const record = exportWorkspace(argument, target);
    console.log(`已导出 ${record.taskId} 候选工作区：${record.destination}`);
    console.log(record.files.map(file => `  ${file}`).join('\n'));
  } else if (command === 'verify' && argument) {
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
