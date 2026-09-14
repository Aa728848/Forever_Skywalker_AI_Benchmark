import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tasks } from '@fsa/catalog';
import { difficulties, difficultyLabels } from '@fsa/contracts';
import { repositoryRoot } from '../../../packages/tasks/src/index.ts';
import { judgeConfigFromEnvironment, JudgeUnavailableError } from '@fsa/judge';
import { dshPresetLabels, resolveDshPreset } from '../../../packages/evaluation/src/dsh.ts';
import { discoverDshModels } from '../../../packages/evaluation/src/dsh-catalog.ts';

export interface LauncherIO {
  ask(prompt: string): Promise<string | null>;
  say(message: string): void;
}

export interface LaunchPlan {
  command: 'dsh:compare' | 'task:export' | 'bench' | 'dev' | 'container:status' | 'setup';
  args: string[];
}

class Cancelled extends Error {}
interface Choice { id: string; label: string }
const availableTasks = tasks.filter(task => task.status !== 'designed');
const parts = (value: string) => value.split(/[,，\s]+/).filter(Boolean);

async function answer(io: LauncherIO, prompt: string, fallback = ''): Promise<string> {
  const value = await io.ask(`${prompt}${fallback ? ` [回车：${fallback}]` : ''}：`);
  if (value === null || value.trim().toLowerCase() === 'q') throw new Cancelled();
  return value.trim() || fallback;
}

async function choose(io: LauncherIO, prompt: string, options: Choice[], defaults: string[] = [], multiple = false): Promise<string[]> {
  io.say(`\n${prompt}`);
  options.forEach((item, index) => io.say(`  ${index + 1}. ${item.label}`));
  const fallback = defaults.map(id => options.findIndex(item => item.id === id) + 1).filter(index => index > 0).join(',');
  while (true) {
    const input = await answer(io, multiple ? '输入编号，可用逗号多选，all 全选' : '输入编号', fallback);
    const selected = multiple && input.toLowerCase() === 'all' ? options.filter(option => option.id !== '__manual__').map(option => option.id) : parts(input).map(token => {
      const byId = options.find(item => item.id === token);
      return byId?.id ?? (/^[1-9]\d*$/.test(token) ? options[Number(token) - 1]?.id : undefined);
    });
    if (selected.length && (multiple || selected.length === 1) && selected.every((id): id is string => id !== undefined)) return [...new Set(selected)];
    io.say('选择无效，请输入列表中的编号。输入 q 退出。');
  }
}

async function textInput(io: LauncherIO, prompt: string, fallback = ''): Promise<string> {
  while (true) {
    const value = await answer(io, prompt, fallback);
    if (value && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    io.say('请输入非空内容，不包含控制字符。');
  }
}

async function integer(io: LauncherIO, prompt: string, fallback: number, min: number, max: number): Promise<number> {
  while (true) {
    const value = await answer(io, prompt, String(fallback));
    if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max) return Number(value);
    io.say(`请输入 ${min}–${max} 之间的整数。`);
  }
}

async function directory(io: LauncherIO, prompt: string, fallback: string): Promise<string> {
  const value = await textInput(io, prompt, fallback);
  const unquoted = /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
  if (!unquoted.trim()) { io.say('目录不能为空。'); return directory(io, prompt, fallback); }
  return resolve(repositoryRoot, unquoted);
}

async function selectTasks(io: LauncherIO, single = false): Promise<string[]> {
  if (!single) {
    const [scope] = await choose(io, '题目范围', [
      { id: 'smoke', label: '先试一道：CACHE-02（检查流程）' },
      { id: 'all', label: `全部 ${availableTasks.length} 题` },
      { id: 'core', label: '48 道核心题' },
      { id: 'level', label: '按难度选择核心题' },
      { id: 'manual', label: '查看题目列表并选择' },
    ], ['smoke']);
    if (scope === 'smoke') return ['CACHE-02'];
    if (scope === 'all') return availableTasks.map(task => task.id);
    if (scope === 'core') return availableTasks.filter(task => task.track === 'core').map(task => task.id);
    if (scope === 'level') {
      const levels = await choose(io, '选择难度', difficulties.map(id => ({ id, label: difficultyLabels[id] })), ['hard'], true);
      return availableTasks.filter(task => task.track === 'core' && levels.includes(task.difficulty)).map(task => task.id);
    }
  }
  return choose(io, single ? '选择一道题目' : '选择题目（也可以输入题号）', availableTasks.map(task => ({
    id: task.id, label: `${task.id} · ${difficultyLabels[task.difficulty]} · ${task.title}`,
  })), ['CACHE-02'], !single);
}

function describeJudge(io: LauncherIO, env: NodeJS.ProcessEnv): void {
  try {
    const { config } = judgeConfigFromEnvironment(env);
    io.say(`裁判：${config.provider} / ${config.model}；思考：${config.reasoningEffort ?? config.reasoningMode ?? config.thinking ?? '供应商默认'}；每次作答最多 ${config.maxCalls} 次评审调用。`);
  } catch (error) {
    if (!(error instanceof JudgeUnavailableError)) throw error;
    io.say(`裁判：${error.message} 完整质量分和总分将保持待定。`);
  }
}

/** 仅供复制到 PowerShell；实际执行始终传 argv 数组，不执行这个字符串。 */
export function displayLaunchCommand(plan: LaunchPlan): string {
  return ['pnpm', plan.command, ...plan.args.map(value => `'${value.replaceAll("'", "''")}'`)].join(' ');
}

async function dshPlan(io: LauncherIO, env: NodeJS.ProcessEnv, discover: typeof discoverDshModels): Promise<LaunchPlan> {
  io.say('\n阶段 1/5：供应商和模型。正在读取本地 DSH 模型目录，不调用模型……');
  const catalog = await discover({
    dshRoot: resolve(env.BENCH_DSH_ROOT || join(homedir(), 'Documents', 'deepseek-harness')),
    dshHome: resolve(env.BENCH_DSH_HOME || env.DSH_HOME || join(homedir(), '.dsh')),
    profile: env.BENCH_DSH_PROFILE || 'sdk',
  });
  if (catalog.warning) io.say(catalog.warning);
  const manual = '__manual__';
  const providerOptions = [...catalog.providers.map(provider => ({ id: provider.id, label: `${provider.name} [${provider.id}]` })), { id: manual, label: '手工填写供应商 ID' }];
  const providerDefault = providerOptions.some(p => p.id === env.BENCH_DSH_PROVIDER) ? env.BENCH_DSH_PROVIDER! : providerOptions[0]!.id;
  const [providerChoice] = await choose(io, '供应商（同名模型按供应商区分）', providerOptions, [providerDefault]);
  const providerId = providerChoice === manual ? await textInput(io, 'DSH 中的供应商 ID', env.BENCH_DSH_PROVIDER || 'deepseek-official') : providerChoice!;
  const provider = catalog.providers.find(item => item.id === providerId);
  const models = provider?.models ?? [];
  let modelId: string;
  if (models.length) {
    const keyword = (await answer(io, '模型名称/ID 过滤关键词，回车显示全部')).toLowerCase();
    const filtered = models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(keyword));
    const options = [...filtered.map(model => ({ id: model.id, label: `${model.name} [${model.id}]` })), { id: manual, label: '手工填写模型 ID' }];
    const fallback = options.some(model => model.id === env.BENCH_DSH_MODEL) ? env.BENCH_DSH_MODEL! : options[0]!.id;
    const [choice] = await choose(io, '选择模型', options, [fallback]);
    modelId = choice === manual ? await textInput(io, '模型 ID', env.BENCH_DSH_MODEL || '') : choice!;
  } else modelId = await textInput(io, '模型 ID（DSH 设置 → 模型中查看）', env.BENCH_DSH_MODEL || '');
  const model = models.find(item => item.id === modelId);

  io.say('\n阶段 2/5：DSH 模式和思考等级。多选后会逐个组合进行比较。');
  let presetDefaults = ['standard'];
  if (env.BENCH_DSH_PRESETS) {
    try { presetDefaults = parts(env.BENCH_DSH_PRESETS).map(resolveDshPreset); }
    catch { io.say('.env 中预设无效，本次默认使用标准模式。'); }
  }
  const presets = await choose(io, 'DSH 模式', Object.entries(dshPresetLabels).map(([id, label]) => ({ id, label: `${label} [${id}]` })), presetDefaults, true);
  const supported = [...new Set(['default', ...(model?.reasoningEfforts ?? [])])];
  if (!model?.reasoningEfforts.length) io.say('未取得该模型的思考等级声明；使用 default 沿用供应商配置。需要指定等级时，可选手工填写并确认 DSH 支持。');
  const defaultModes = parts(env.BENCH_DSH_REASONING_EFFORT || 'default').filter(mode => supported.includes(mode));
  let modes = await choose(io, '思考等级（default = 不传参数；off = 明确关闭）', [
    ...supported.map(id => ({ id, label: id === 'default' ? '沿用供应商默认 [default]' : id })),
    { id: manual, label: '手工填写等级（需确认该模型在 DSH 中支持）' },
  ], defaultModes.length ? defaultModes : ['default'], true);
  if (modes.includes(manual)) {
    while (true) {
      const entered = parts(await answer(io, '思考等级 ID，多个用逗号分隔', 'default'));
      const combined = [...new Set([...modes.filter(mode => mode !== manual), ...entered])];
      if (combined.length > 0 && combined.length <= 8 && combined.every(mode => /^[a-z][a-z0-9-]{0,31}$/.test(mode))) { modes = combined; break; }
      io.say('请输入 1–8 个有效等级 ID，例如 default、off 或 high。');
    }
  }

  io.say('\n阶段 3/5：选择题目。');
  const taskIds = await selectTasks(io);
  io.say('\n阶段 4/5：作答预算和报告。');
  const repeat = await integer(io, '每种组合重复次数', 1, 1, 20);
  const minutes = await integer(io, '每次作答限时（分钟）', 20, 1, 1440);
  const maxTokens = await integer(io, '每次模型请求的输出 Token 上限（不是整题总量）', 16384, 1, Number.MAX_SAFE_INTEGER);
  const [measure] = await choose(io, '性能测量', [{ id: 'yes', label: '开启配对测量' }, { id: 'no', label: '跳过（完整质量分待定）' }], ['yes']);
  const output = await directory(io, '报告父目录', env.BENCH_DSH_REPORT_DIR || join(repositoryRoot, 'data', 'experiments'));
  const plan: LaunchPlan = { command: 'dsh:compare', args: [
    '--provider', providerId, '--model', modelId, '--presets', presets.join(','), '--modes', modes.join(','),
    '--tasks', taskIds.join(','), '--repeat', String(repeat), '--minutes', String(minutes), '--max-tokens', String(maxTokens),
    '--output', output, ...(measure === 'no' ? ['--no-measure'] : []),
  ] };
  io.say('\n阶段 5/5：核对计划。');
  io.say(`作答：${providerId} / ${modelId}\n模式：${presets.map(id => dshPresetLabels[id as keyof typeof dshPresetLabels]).join('、')}\n思考：${modes.join('、')}\n题目：${taskIds.join('、')}\n总计：${taskIds.length} 题 × ${presets.length} 模式 × ${modes.length} 思考等级 × ${repeat} 次 = ${taskIds.length * presets.length * modes.length * repeat} 次作答。\n每次限时 ${minutes} 分钟；每请求输出上限 ${maxTokens} Token。\n报告：${output}\n正常结束后保留报告和压缩证据，清理本次临时作答数据。`);
  describeJudge(io, env);
  io.say(`可复制的命令：\n${displayLaunchCommand(plan)}`);
  const [action] = await choose(io, '接下来', [
    { id: 'check', label: '仅检查配置（不作答、不调用模型）' },
    { id: 'run', label: '开始测评（调用作答模型及已配置裁判）' },
    { id: 'again', label: '重新选择参数' },
  ], ['check']);
  if (action === 'again') return dshPlan(io, env, async () => catalog);
  if (action === 'check') plan.args.push('--check');
  return plan;
}

export async function selectLaunchPlan(io: LauncherIO, env: NodeJS.ProcessEnv = process.env, discover: typeof discoverDshModels = discoverDshModels): Promise<LaunchPlan | null> {
  io.say('Forever Skywalker AI Benchmark · 快速启动\n输入编号选择；多选用逗号分隔；回车采用提示的默认值；任何一步输入 q 退出。\nLinux 评分需要 Docker Desktop 已启动。测评参数只作用于本次；补齐 .env 须单独确认保存，DSH 配置保持不变。');
  try {
    const [mode] = await choose(io, '要做什么', [
      { id: 'dsh', label: '用 DSH 自动做题并评分' },
      { id: 'export', label: '导出一道题，交给其他编程 AI' },
      { id: 'submit', label: '提交其他 AI 已完成的作答' },
      { id: 'web', label: '打开网页/API 服务' },
      { id: 'status', label: '检查 Linux 容器环境' },
      { id: 'setup', label: '补齐 .env 环境配置' },
    ], ['dsh']);
    if (mode === 'dsh') return await dshPlan(io, env, discover);
    if (mode === 'setup') return { command: 'setup', args: [] };
    if (mode === 'web') {
      io.say('将启动网页 http://127.0.0.1:4317 和 API；保持窗口运行，Ctrl+C 停止。');
      return { command: 'dev', args: [] };
    }
    if (mode === 'status') return { command: 'container:status', args: [] };
    const [taskId] = await selectTasks(io, true);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = await directory(io, mode === 'export' ? '导出到新目录' : '已完成的作答目录', mode === 'export' ? join(homedir(), 'Documents', 'BenchAnswers', `${taskId}-${stamp}`) : '');
    if (mode === 'export') {
      io.say(`将导出 ${taskId} 到 ${destination}，让编程 AI 按 TASK.md 完成后再次启动本向导，选择提交作答。`);
      const [confirm] = await choose(io, '确认导出', [{ id: 'yes', label: '导出' }, { id: 'no', label: '取消' }], ['yes']);
      return confirm === 'yes' ? { command: 'task:export', args: [taskId!, destination] } : null;
    }
    const key = await textInput(io, '本次作答标识（重复提交同一作答请用相同标识）', `${taskId}-${stamp}`);
    const [measure] = await choose(io, '性能测量', [{ id: 'yes', label: '开启' }, { id: 'no', label: '跳过（完整质量分待定）' }], ['yes']);
    describeJudge(io, env);
    io.say(`将冻结 ${destination}，以 Linux 容器验证 ${taskId} 并调用已配置的裁判。`);
    const [confirm] = await choose(io, '确认提交', [{ id: 'no', label: '取消' }, { id: 'yes', label: '提交并评分' }], ['no']);
    return confirm === 'yes' ? { command: 'bench', args: ['submit', taskId!, destination, '--key', key, '--profile', 'linux-container', measure === 'yes' ? '--measure' : '--no-measure'] } : null;
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    io.say('已退出，未启动测评。');
    return null;
  }
}
