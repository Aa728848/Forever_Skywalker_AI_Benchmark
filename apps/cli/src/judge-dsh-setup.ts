import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { JudgeUnavailableError } from '@fsa/judge';
import { readProjectEnvironment, saveProjectEnvironment } from '@fsa/config';
import { discoverDshModels, dshJudgeOptionsFromEnvironment } from '@fsa/evaluation';

/** 目录结构类型由 discoverDshModels 的签名派生，不必再走深层相对路径。 */
type DshModelCatalog = Awaited<ReturnType<typeof discoverDshModels>>;
type DshCatalogProvider = DshModelCatalog['providers'][number];
type DshCatalogModel = DshCatalogProvider['models'][number];

/** 交互面：与启动向导、环境配置共用同一个最小 IO 形状。 */
export interface DshJudgeSetupIO {
  ask(prompt: string): Promise<string | null>;
  say(message: string): void;
}

export interface DshJudgeSetupOptions {
  /** 注入本地目录发现实现；默认读取 DSH root/home，不调用远程端点。 */
  discover?: typeof discoverDshModels;
  /** 允许覆写 .env 中已有非空值；环境补齐向导保持 false（只补缺失）。 */
  replace?: boolean;
}

export const dshJudgeKeys = {
  provider: 'BENCH_JUDGE_DSH_PROVIDER',
  model: 'BENCH_JUDGE_DSH_MODEL',
  effort: 'BENCH_JUDGE_DSH_REASONING_EFFORT',
  maxTokens: 'BENCH_JUDGE_DSH_MAX_TOKENS',
  timeout: 'BENCH_JUDGE_DSH_TIMEOUT_MS',
  promptVersion: 'BENCH_JUDGE_PROMPT_VERSION',
} as const;

export type DshJudgeKey = typeof dshJudgeKeys[keyof typeof dshJudgeKeys];

class Cancelled extends Error {}
interface Choice { id: string; label: string }
const manual = '__manual__';
const effortPattern = /^[a-z][a-z0-9-]{0,31}$/;
const promptVersionPattern = /^[A-Za-z0-9_.:-]{1,64}$/;
const present = (value: string | undefined): boolean => Boolean(value?.trim());

async function answer(io: DshJudgeSetupIO, prompt: string, fallback = ''): Promise<string> {
  const value = await io.ask(`${prompt}${fallback ? ` [回车：${fallback}]` : ''}：`);
  if (value === null || value.trim().toLowerCase() === 'q') throw new Cancelled();
  return value.trim() || fallback;
}

async function choose(io: DshJudgeSetupIO, prompt: string, options: Choice[], fallbackId: string): Promise<string> {
  io.say(`\n${prompt}`);
  options.forEach((item, index) => io.say(`  ${index + 1}. ${item.label}`));
  const fallbackIndex = options.findIndex(item => item.id === fallbackId);
  const fallback = fallbackIndex >= 0 ? String(fallbackIndex + 1) : '1';
  while (true) {
    const input = await answer(io, '输入编号', fallback);
    const selected = options.find(item => item.id === input)?.id ?? (/^[1-9]\d*$/.test(input) ? options[Number(input) - 1]?.id : undefined);
    if (selected !== undefined) return selected;
    io.say('请输入列表中的编号。');
  }
}

async function textInput(io: DshJudgeSetupIO, prompt: string, fallback = ''): Promise<string> {
  while (true) {
    const value = await answer(io, prompt, fallback);
    if (value && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    io.say('请输入非空内容，不包含控制字符。');
  }
}

async function positiveInteger(io: DshJudgeSetupIO, prompt: string, fallback: string, max: number): Promise<string> {
  while (true) {
    const input = await answer(io, `${prompt}（正整数，不超过 ${max}）`, fallback);
    const value = Number(input);
    if (/^\d+$/.test(input) && Number.isSafeInteger(value) && value > 0 && value <= max) return String(value);
    io.say(`请输入 1–${max} 之间的整数。`);
  }
}

/** 只读本地 DSH 目录；失败返回空目录与原因，不中断设置流程。 */
export async function loadDshJudgeCatalog(env: NodeJS.ProcessEnv, discover: typeof discoverDshModels = discoverDshModels): Promise<DshModelCatalog> {
  return discover({
    dshRoot: resolve(env.BENCH_DSH_ROOT || join(homedir(), 'Documents', 'deepseek-harness')),
    dshHome: resolve(env.BENCH_DSH_HOME || env.DSH_HOME || join(homedir(), '.dsh')),
    profile: env.BENCH_DSH_PROFILE || 'sdk',
  });
}

export function describeDshJudge(env: NodeJS.ProcessEnv): string {
  try {
    const config = dshJudgeOptionsFromEnvironment(env);
    return `${config.provider} / ${config.model}（思考 ${config.reasoningEffort}，每轮输出上限 ${config.maxTokens}，单轮超时 ${config.timeoutMs} ms，提示版本 ${config.promptVersion}）`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function pickProvider(io: DshJudgeSetupIO, providers: DshCatalogProvider[], current: string | undefined): Promise<string> {
  const options: Choice[] = [...providers.map(provider => ({ id: provider.id, label: `${provider.name} [${provider.id}]` })), { id: manual, label: '手工填写供应商 ID' }];
  const fallback = options.some(item => item.id === current) ? current! : options[0]!.id;
  const choice = await choose(io, '评分 Agent 的 DSH 供应商（与作答供应商独立）', options, fallback);
  return choice === manual ? textInput(io, 'DSH 中的供应商 ID', current || 'deepseek-official') : choice;
}

async function pickModel(io: DshJudgeSetupIO, models: DshCatalogModel[], current: string | undefined): Promise<string> {
  if (models.length === 0) return textInput(io, '评分模型 ID（可在 DSH 设置 → 模型中查看）', current ?? '');
  const keyword = (await answer(io, '模型名称/ID 过滤关键词，回车显示全部')).toLowerCase();
  const filtered = models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(keyword));
  const visible = filtered.length > 0 ? filtered : models;
  const options: Choice[] = [...visible.map(model => ({ id: model.id, label: `${model.name} [${model.id}]` })), { id: manual, label: '手工填写模型 ID' }];
  const fallback = options.some(item => item.id === current) ? current! : options[0]!.id;
  const choice = await choose(io, '选择评分模型（决定质量分由哪个模型评定）', options, fallback);
  return choice === manual ? textInput(io, '模型 ID', current ?? '') : choice;
}

async function pickEffort(io: DshJudgeSetupIO, model: DshCatalogModel | undefined, current: string | undefined): Promise<string> {
  const supported = [...new Set(['default', ...(model?.reasoningEfforts ?? [])])];
  if (!model?.reasoningEfforts.length) io.say('未取得该模型的思考等级声明；default 表示不传参数。需要指定等级时请手工填写，并确认 DSH 支持。');
  const options: Choice[] = [...supported.map(id => ({ id, label: id === 'default' ? '沿用供应商默认 [default]' : id })), { id: manual, label: '手工填写等级（需确认该模型在 DSH 中支持）' }];
  const fallback = options.some(item => item.id === current) ? current! : 'default';
  const choice = await choose(io, '评分思考等级（两轮会话使用同一等级）', options, fallback);
  if (choice !== manual) return choice;
  while (true) {
    const input = await answer(io, '思考等级 ID', current && effortPattern.test(current) ? current : 'default');
    if (effortPattern.test(input)) return input;
    io.say('请输入小写等级 ID，例如 default、off 或 high。');
  }
}

async function pickPromptVersion(io: DshJudgeSetupIO, current: string | undefined): Promise<string> {
  while (true) {
    const input = await answer(io, `评审提示版本（改动提示词时才需要新版本号）`, current || 'dsh-review-v1');
    if (promptVersionPattern.test(input)) return input;
    io.say('提示版本只能包含字母、数字、下划线、点、冒号和连字符。');
  }
}

/**
 * 收集 DSH 评分 Agent 的供应商、模型、思考等级与预算。
 * 默认只补缺失字段；replace 为 true 时以现有值作默认重新选择。确认保存由调用方负责，本函数不写文件、不调用模型。
 */
export async function collectDshJudgeSetup(io: DshJudgeSetupIO, env: NodeJS.ProcessEnv, options: DshJudgeSetupOptions = {}): Promise<Record<string, string> | null> {
  const replace = options.replace === true;
  // 参数检查失败时强制重问所有字段：已有但无效的非空值也必须能被改掉。
  let force = false;
  const need = (name: string): boolean => replace || force || !present(env[name]);
  if (!Object.values(dshJudgeKeys).some(need)) {
    try {
      dshJudgeOptionsFromEnvironment(env);
      io.say(`DSH 评分 Agent 已配置：${describeDshJudge(env)}`);
      return {};
    } catch (error) {
      if (!(error instanceof JudgeUnavailableError)) throw error;
      io.say('DSH 评分 Agent 已有配置未通过检查：' + error.message + '；请重新填写。');
      force = true;
    }
  }
  try {
    io.say('正在读取本地 DSH 模型目录，不调用模型……');
    const catalog = await loadDshJudgeCatalog(env, options.discover ?? discoverDshModels);
    if (catalog.warning) io.say(catalog.warning);
    const picked: Record<string, string> = {};
    const asked = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const take = async (name: string, read: () => Promise<string>, fallbackValue: string): Promise<void> => {
        if (!need(name)) { picked[name] = fallbackValue; return; }
        picked[name] = await read();
        asked.add(name);
      };
      await take(dshJudgeKeys.provider, () => pickProvider(io, catalog.providers, env[dshJudgeKeys.provider] ?? picked[dshJudgeKeys.provider]), env[dshJudgeKeys.provider] ?? '');
      const provider = catalog.providers.find(item => item.id === picked[dshJudgeKeys.provider]);
      await take(dshJudgeKeys.model, () => pickModel(io, provider?.models ?? [], env[dshJudgeKeys.model] ?? picked[dshJudgeKeys.model]), env[dshJudgeKeys.model] ?? '');
      const model = provider?.models.find(item => item.id === picked[dshJudgeKeys.model]);
      await take(dshJudgeKeys.effort, () => pickEffort(io, model, env[dshJudgeKeys.effort] ?? picked[dshJudgeKeys.effort]), env[dshJudgeKeys.effort] ?? 'default');
      await take(dshJudgeKeys.maxTokens, () => positiveInteger(io, '评分 Agent 每轮最大输出 Token（含思考）', env[dshJudgeKeys.maxTokens] || '16384', 1_000_000), env[dshJudgeKeys.maxTokens] || '16384');
      await take(dshJudgeKeys.timeout, () => positiveInteger(io, '评分 Agent 单轮超时（毫秒）', env[dshJudgeKeys.timeout] || '300000', 3_600_000), env[dshJudgeKeys.timeout] || '300000');
      await take(dshJudgeKeys.promptVersion, () => pickPromptVersion(io, env[dshJudgeKeys.promptVersion] ?? picked[dshJudgeKeys.promptVersion]), env[dshJudgeKeys.promptVersion] ?? 'dsh-review-v1');
      try {
        dshJudgeOptionsFromEnvironment({ ...env, ...picked });
        io.say('DSH 评分 Agent 参数检查通过：' + describeDshJudge({ ...env, ...picked }));
        return Object.fromEntries([...asked].map(name => [name, picked[name]!]));
      } catch (error) {
        if (!(error instanceof JudgeUnavailableError)) throw error;
        force = true;
        io.say('评分 Agent 参数未通过：' + error.message + '；请重新填写。');
      }
    }
    io.say('多次填写仍未通过参数检查，本次不返回可保存项。');
    return null;
  } catch (error) {
    if (error instanceof Cancelled) { io.say('已取消裁判模型设置，.env 未修改。'); return null; }
    throw error;
  }
}

/** 独立命令：交互选择裁判模型并写回 .env；覆写已有值需要显式确认。 */
export async function configureDshJudgeFromTerminal(io: DshJudgeSetupIO, options: { root: string; env: NodeJS.ProcessEnv; discover?: typeof discoverDshModels }): Promise<{ saved: boolean; cancelled: boolean; env: NodeJS.ProcessEnv }> {
  const snapshot = readProjectEnvironment(options.root, options.env);
  const env = snapshot.effectiveEnv;
  if (!present(env.BENCH_DSH_ROOT) || !present(env.BENCH_DSH_HOME)) {
    io.say('尚未配置 BENCH_DSH_ROOT / BENCH_DSH_HOME；请先运行 pnpm start，在环境配置中补齐 DSH 目录。');
    return { saved: false, cancelled: true, env };
  }
  io.say('当前 DSH 评分 Agent：' + describeDshJudge(env));
  const updates = await collectDshJudgeSetup(io, env, { replace: true, ...(options.discover === undefined ? {} : { discover: options.discover }) });
  if (updates === null) return { saved: false, cancelled: true, env };
  if (Object.keys(updates).length === 0) { io.say('.env 无需修改。'); return { saved: false, cancelled: false, env }; }
  io.say('\n将覆写 ' + snapshot.path + ' 中的以下字段（其它配置与注释保留）：');
  for (const [key, value] of Object.entries(updates)) io.say(`  ${key}=${value}`);
  const confirmed = ((await io.ask('确认写入 .env [y/N]：')) ?? '').trim().toLowerCase();
  if (confirmed !== 'y' && confirmed !== 'yes') { io.say('已取消，.env 未修改。'); return { saved: false, cancelled: true, env }; }
  const saved = saveProjectEnvironment(options.root, updates, snapshot, { replace: Object.keys(updates) });
  io.say('已写入 .env；下次启动生效。评分仍需两轮独立会话，缺少有效判决时质量分保持待定。');
  return { saved: true, cancelled: false, env: { ...saved.effectiveEnv, ...updates } };
}
