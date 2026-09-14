import { spawn } from 'node:child_process';
import { selectLaunchPlan, displayLaunchCommand, type LaunchPlan } from '../apps/cli/src/launcher.ts';
import { createTerminalIO } from '../apps/cli/src/terminal.ts';
import { configureProjectEnvironment } from '../apps/cli/src/env-setup.ts';
import { repositoryRoot } from '../packages/tasks/src/index.ts';

const help = '用法：pnpm start\n缺少 .env 或关键配置时先引导补齐，确认后保存，令牌输入不回显。\n分步选择 DSH 供应商、模型、模式、思考等级、题目、预算和报告目录；也可导出/提交外部作答或启动网页。\n输入 q 或 Ctrl+C 退出；最后可选仅预检，不调用模型。Windows 可双击根目录 start.cmd。';

async function execute(plan: LaunchPlan, env: NodeJS.ProcessEnv): Promise<number> {
  if (plan.command === 'setup') throw new Error('环境配置应由启动菜单处理。');
  const scripts = { 'dsh:compare': 'scripts/dsh-compare.ts', 'task:export': 'scripts/task.ts', bench: 'apps/cli/src/main.ts', 'container:status': 'scripts/container.ts' };
  let executable: string;
  let args: string[];
  if (plan.command === 'dev') {
    // pnpm 的 Windows 入口是 cmd shim；此分支参数固定，不拼入用户输入。
    executable = process.platform === 'win32' ? 'cmd.exe' : 'pnpm';
    args = process.platform === 'win32' ? ['/d', '/c', 'pnpm', 'dev'] : ['dev'];
  } else {
    executable = process.execPath;
    const prefix = plan.command === 'task:export' ? ['export'] : plan.command === 'container:status' ? ['status'] : [];
    args = ['--env-file-if-exists=.env', '--import', 'tsx', scripts[plan.command], ...prefix, ...plan.args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repositoryRoot, env, stdio: 'inherit', shell: false });
    // 前台进程共享终端，Ctrl+C 同时到达子进程；父进程等待其既有清理流程结束。
    const interrupted = () => {};
    process.on('SIGINT', interrupted);
    child.once('error', error => { process.removeListener('SIGINT', interrupted); reject(error); });
    child.once('close', (code, signal) => { process.removeListener('SIGINT', interrupted); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

try {
  if (process.argv.includes('--help')) console.log(help);
  else if (process.argv.length > 2) throw new Error(help);
  else {
    process.chdir(repositoryRoot);
    const terminal = createTerminalIO();
    let env = process.env;
    let plan: LaunchPlan | null = null;
    try {
      const configured = await configureProjectEnvironment(terminal, { root: repositoryRoot, env });
      env = configured.env;
      if (!configured.cancelled) {
        while (true) {
          plan = await selectLaunchPlan(terminal, env);
          if (plan?.command !== 'setup') break;
          plan = null;
          const next = await configureProjectEnvironment(terminal, { root: repositoryRoot, env, force: true });
          env = next.env;
          if (next.cancelled) break;
        }
      }
    } finally { terminal.close(); }
    if (plan) {
      console.log(`\n执行：${displayLaunchCommand(plan)}\n`);
      process.exitCode = await execute(plan, env);
      if (plan.command === 'dsh:compare' && plan.args.includes('--check') && process.exitCode === 0) console.log('\n仅预检已完成。准备实际作答时，再运行 pnpm start，并在最后选择“开始测评”。');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
