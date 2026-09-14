import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { repositoryRoot } from '../../../packages/tasks/src/index.ts';
import { displayLaunchCommand, selectLaunchPlan } from './launcher.ts';

function terminal(answers: string[]) {
  const output: string[] = [];
  return { output, io: {
    say: (message: string) => { output.push(message); },
    ask: async (prompt: string) => { output.push(prompt); return answers.shift() ?? null; },
  } };
}

const catalog = { warning: null, providers: [
  { id: 'gateway-a', name: 'A', models: [{ id: 'same-model', name: '同名模型', reasoningEfforts: [] }] },
  { id: 'gateway-b', name: 'B', models: [{ id: 'same-model', name: '同名模型', reasoningEfforts: ['off', 'high'] }] },
] };

it('供应商限定模型与推理能力，多选组合计数和路径原样传参，默认只预检', async () => {
  const outputPath = "reports/含空格 & '引号' $(never-run)";
  const context = terminal(['dsh', 'gateway-b', '', 'same-model', 'all', 'high,off', '2', 'level', 'hard,extreme', '2', '15', '2048', 'no', outputPath, '']);
  const plan = await selectLaunchPlan(context.io, {}, async () => catalog);
  expect(plan?.command).toBe('dsh:compare');
  const args = plan!.args;
  expect(args.slice(0, 8)).toEqual(['--provider', 'gateway-b', '--model', 'same-model', '--presets', 'standard,ptc,minimal,cordis', '--modes', 'high,off']);
  expect(args[args.indexOf('--workspace-permission') + 1]).toBe('workspace-write');
  expect(args[args.indexOf('--tasks') + 1]!.split(',')).toHaveLength(24);
  expect(args).toContain('--no-measure'); expect(args.at(-1)).toBe('--check');
  expect(args[args.indexOf('--output') + 1]).toBe(resolve(repositoryRoot, outputPath));
  expect(context.output.join('\n')).toContain('384 次作答');
  expect(displayLaunchCommand(plan!)).toContain("''引号'' $(never-run)");
});

it('没有等级声明时不会继承另一供应商同名模型能力或不支持的.env等级', async () => {
  const context = terminal(['dsh', 'gateway-a', '', 'same-model', '', '', '', '', '', '', '', '', '', 'run']);
  const plan = await selectLaunchPlan(context.io, { BENCH_DSH_REASONING_EFFORT: 'off,high' }, async () => catalog);
  expect(plan!.args[plan!.args.indexOf('--modes') + 1]).toBe('default');
  expect(plan!.args).not.toContain('--check');
  expect(context.output.join('\n')).toContain('未取得该模型的思考等级声明');
});

it('目录读取失败可手工输入，错误等级和预算必须重新选择', async () => {
  const context = terminal(['dsh', '', 'custom', 'model-id', 'standard', '__manual__', 'not valid!', 'high,high', '2', 'smoke', '0', '21', '3', '1.5', '10', '-1', '4096', 'yes', 'reports', 'check']);
  const plan = await selectLaunchPlan(context.io, {}, async () => ({ providers: [], warning: '未读到目录，请手工填写。' }));
  expect(plan!.args.slice(0, 8)).toEqual(['--provider', 'custom', '--model', 'model-id', '--presets', 'standard', '--modes', 'high']);
  expect(plan!.args[plan!.args.indexOf('--repeat') + 1]).toBe('3');
  expect(plan!.args[plan!.args.indexOf('--minutes') + 1]).toBe('10');
  expect(plan!.args[plan!.args.indexOf('--max-tokens') + 1]).toBe('4096');
});

it('最终输入结束或q取消不会生成会启动模型的计划', async () => {
  for (const end of [[], ['q']]) {
    const context = terminal(['dsh', 'gateway-a', '', 'same-model', '', '', '', '', '', '', '', '', '', ...end]);
    expect(await selectLaunchPlan(context.io, {}, async () => catalog)).toBeNull();
    expect(context.output.join('\n')).toContain('未启动测评');
  }
});

it('外部作答无需DSH目录，明确跳过性能可覆盖.env中的开启设置', async () => {
  const context = terminal(['submit', 'CACHE-02', 'data/submissions/answer', 'repeatable-key', 'no', 'yes']);
  const plan = await selectLaunchPlan(context.io, {}, async () => { throw new Error('不应读取DSH'); });
  expect(plan).toEqual({ command: 'bench', args: ['submit', 'CACHE-02', resolve(repositoryRoot, 'data/submissions/answer'), '--key', 'repeatable-key', '--profile', 'linux-container', '--no-measure'] });
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'apps/cli/src/main.ts', 'list', '--no-measure'], {
    cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, BENCH_MEASURE_PERFORMANCE: '1' },
  });
  expect(output).toContain('CACHE-02');
});

it('默认导出到评测仓库外，外部编程AI不会沿Git父目录进入参考答案仓库', async () => {
  const context = terminal(['export', 'CACHE-02', '', 'yes']);
  const plan = await selectLaunchPlan(context.io, {}, async () => { throw new Error('不应读取DSH'); });
  expect(plan!.command).toBe('task:export');
  const path = plan!.args[1]!;
  expect(isAbsolute(path)).toBe(true);
  const suffix = relative(repositoryRoot, path);
  expect(suffix.startsWith('..') || isAbsolute(suffix)).toBe(true);
});
