import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { repositoryRoot } from '../packages/tasks/src/index.ts';
import { tasks } from '../packages/catalog/src/index.ts';
import { probeContainerRuntime, requirePinnedImage } from '../packages/executor/src/index.ts';
import { JudgeUnavailableError } from '../packages/judge/src/index.ts';
import { dshJudgeOptionsFromEnvironment } from '../packages/evaluation/src/dsh-judge.ts';
import { runDshComparison, validateComparison, type DshComparisonOptions } from '../packages/evaluation/src/dsh-comparison.ts';
import { checkDshInstallation, resolveDshPreset, resolveDshWorkspacePermission } from '../packages/evaluation/src/dsh.ts';
import { cleanupComparisonScratch, createComparisonScratch } from '../packages/evaluation/src/comparison-artifacts.ts';

const usage = `DSH 自动模式对比（固定 Linux 评分，沿用你的 DSH home）

pnpm dsh:compare --model <DSH 中的模型 ID>
pnpm dsh:compare --preset ptc --model <模型 ID> --reasoning high --output <报告目录>
pnpm dsh:compare --presets standard,ptc,minimal,cordis --model <模型 ID> --reasoning high --tasks API-04,GRAPH-04
pnpm dsh:compare --all --provider <供应商ID> --model <模型ID> --preset standard --reasoning high
pnpm dsh:compare --model <模型 ID> --check

预设：standard/标准、ptc/PTC、minimal/极简、cordis/创造。与思考等级分别设置。
--provider 指定 DSH 供应商 ID；与 --model 一起确定目标，同名模型不会跨供应商自动匹配。
默认标准预设、CACHE-02、off/high、每组一次、每题 20 分钟、每请求输出上限 16384 Token。
--reasoning 指定一个思考等级；已有 --modes off,high,max 可同时比较多个等级。
--reasoning default 沿用供应商/模型默认值，省略思考参数；未声明推理等级的模型使用此项。default 不等同 off。
--workspace-permission read-only|workspace-write|danger-full-access 设置 DSH 工作区文件权限，默认 workspace-write。权限会写入 experiment.json。
--all 选择全部已具备题目包的题，不能与 --tasks 同时使用。
--check 只核对本地文件、容器和裁判参数；不启动 DSH、不调用模型。
--minutes / --max-tokens 调整作答预算；--no-measure 跳过性能采样（完整质量分保持待定）。
输出目录只保留报告及压缩证据；其余本次临时数据在报告确认保存后清理。
DSH 配置：BENCH_DSH_ROOT、BENCH_DSH_HOME、BENCH_DSH_PROFILE、BENCH_DSH_PROVIDER、BENCH_DSH_MODEL、BENCH_DSH_PRESETS、BENCH_DSH_REASONING_EFFORT、BENCH_DSH_WORKSPACE_PERMISSION、BENCH_DSH_REPORT_DIR。
真实运行会调用 DSH 已配置的作答模型，以及本项目已配置的裁判。Ctrl+C 停止当前实验。`;

try {
  const { values, positionals } = parseArgs({ options: {
    help: { type: 'boolean' }, check: { type: 'boolean' }, model: { type: 'string' }, provider: { type: 'string' },
    preset: { type: 'string' }, presets: { type: 'string' }, reasoning: { type: 'string' }, output: { type: 'string' },
    tasks: { type: 'string' }, all: { type: 'boolean' }, modes: { type: 'string' }, 'workspace-permission': { type: 'string' },
    repeat: { type: 'string', default: '1' }, minutes: { type: 'string', default: '20' },
    'max-tokens': { type: 'string', default: '16384' }, 'no-measure': { type: 'boolean' },
  } });
  if (values.help) console.log(usage);
  else {
    if (positionals.length > 0) throw new Error('不接受位置参数；使用 --model 指定模型。');
    if (values.preset !== undefined && values.presets !== undefined) throw new Error('--preset 与 --presets 请选择一种。');
    if (values.reasoning !== undefined && values.modes !== undefined) throw new Error('--reasoning 与 --modes 请选择一种。');
    if (values.all && values.tasks !== undefined) throw new Error('--all 与 --tasks 请选择一种。');
    if (values.reasoning !== undefined && /[,\s]/.test(values.reasoning.trim())) throw new Error('--reasoning 只接受一个等级；比较多个等级请用 --modes。');
    const outputRoot = resolve(values.output || process.env.BENCH_DSH_REPORT_DIR || join(repositoryRoot, 'data', 'experiments'));
    const options: DshComparisonOptions = {
      dshRoot: resolve(process.env.BENCH_DSH_ROOT || join(homedir(), 'Documents', 'deepseek-harness')),
      dshHome: resolve(process.env.BENCH_DSH_HOME || process.env.DSH_HOME || join(homedir(), '.dsh')),
      profile: process.env.BENCH_DSH_PROFILE || 'sdk', provider: values.provider || process.env.BENCH_DSH_PROVIDER || 'deepseek-official',
      workspacePermission: resolveDshWorkspacePermission(values['workspace-permission'] || process.env.BENCH_DSH_WORKSPACE_PERMISSION || process.env.DSH_PERMISSION_MODE || 'workspace-write'),
      model: values.model || process.env.BENCH_DSH_MODEL || '',
      // PowerShell 的 pnpm shim 会把未引用的逗号列表作为空格列表传入。
      presets: (values.presets || values.preset || process.env.BENCH_DSH_PRESETS || 'standard').split(/[,\s]+/).filter(Boolean).map(resolveDshPreset),
      taskIds: values.all ? tasks.filter(task => task.status !== 'designed').map(task => task.id) : (values.tasks ?? 'CACHE-02').split(/[,\s]+/).filter(Boolean),
      modes: (values.modes || values.reasoning || process.env.BENCH_DSH_REASONING_EFFORT || 'off,high').split(/[,\s]+/).filter(Boolean),
      repeats: Number(values.repeat), maxTokens: Number(values['max-tokens']), timeoutMs: Number(values.minutes) * 60_000,
      outputDirectory: join(outputRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)),
      image: process.env.BENCH_IMAGE || '', imageDigest: process.env.BENCH_IMAGE_DIGEST || '', measurePerformance: !values['no-measure'],
    };
    validateComparison(options);
    const installation = checkDshInstallation(options.dshRoot);
    const sdk = await import(pathToFileURL(installation.sdkPath).href) as { DeepSeekHarness?: unknown };
    if (typeof sdk.DeepSeekHarness !== 'function') throw new Error('DSH SDK 构建未导出 DeepSeekHarness。');
    if (!existsSync(options.dshHome)) throw new Error('找不到 DSH home；请把 BENCH_DSH_HOME 配置为你已配置供应商的 DSH 目录。');
    if (!options.image || !options.imageDigest) throw new Error('缺少固定 Linux 镜像；请先按容器手册完成配置。');
    const preflight = createComparisonScratch();
    try {
      const captureDir = join(preflight.directory, 'preflight');
      const runtime = probeContainerRuntime({ captureDir, timeoutMs: 5000 });
      requirePinnedImage(runtime, options.image, options.imageDigest, { captureDir, timeoutMs: 5000 });
    } finally { cleanupComparisonScratch(preflight); }
    let judgeMessage = '裁判未配置：可用验证正常评分，完整质量分和总分待定。';
    try {
      const config = dshJudgeOptionsFromEnvironment();
      judgeMessage = `DSH 评分 Agent：${config.provider} / ${config.model}；思考 ${config.reasoningEffort}；每题两轮独立会话。`;
    } catch (error) { if (!(error instanceof JudgeUnavailableError)) throw error; }
    console.log(`DSH ${installation.version}；作答：${options.provider} / ${options.model}；预设 ${options.presets.join('、')}；思考 ${options.modes.join('、')}；共 ${options.taskIds.length * options.presets.length * options.modes.length * options.repeats} 次。`);
    console.log(judgeMessage);
    if (values.check) console.log('本地预检通过；DSH 供应商连接、认证及实际作答尚未验证。模型调用：0。');
    else {
      mkdirSync(outputRoot, { recursive: true });
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error('操作者停止 DSH 模式对比。'));
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const report = await runDshComparison(options, { signal: controller.signal, onProgress: message => console.log(message) });
        console.log(`实验状态：${report.state}\n报告目录：${options.outputDirectory}\n对比报告：${join(options.outputDirectory, 'report.md')}\n完整记录：${join(options.outputDirectory, 'experiment.json')}\n压缩证据：${join(options.outputDirectory, 'evidence.json.gz')}\n清理：${report.cleanup.state}${report.cleanup.directory ? '，保留路径：' + report.cleanup.directory : ''}`);
        if (report.state !== 'completed' || report.rows.some(row => row.evaluation?.status.classification !== 'passed')) process.exitCode = 1;
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('查看用法：pnpm dsh:compare --help');
  process.exitCode = 1;
}
