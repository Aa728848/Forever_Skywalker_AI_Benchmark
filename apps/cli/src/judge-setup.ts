import { createEnvironmentJudge, judgeConfigFromEnvironment, JudgeUnavailableError } from '@fsa/judge';
import { dshJudgeOptionsFromEnvironment } from '../../../packages/evaluation/src/dsh-judge.ts';

export interface JudgeSetupIO {
  ask(prompt: string): Promise<string | null>;
  secret(prompt: string): Promise<string | null>;
  say(message: string): void;
}

interface Field {
  key: string;
  label: string;
  optional?: boolean;
  fallback?: string;
  secret?: boolean;
}

const prefix = 'BENCH_JUDGE_';
const providers = ['openai', 'anthropic', 'gemini', 'deepseek', 'qwen', 'xai', 'moonshot', 'zhipu', 'openai-compatible'];
const providerField: Field = { key: 'PROVIDER', label: '裁判供应商' };
const requiredFields: Field[] = [
  { key: 'ENDPOINT', label: 'API 基址（HTTP(S)，不要在地址中填写密钥或查询参数）' },
  { key: 'MODEL', label: '裁判模型 ID（填写供应商提供的实际 ID）' },
  { key: 'TOKEN', label: '裁判 API 密钥（隐藏输入）', secret: true },
];
const controls: Record<string, readonly string[]> = {
  openai: ['API', 'REASONING_EFFORT', 'REASONING_MODE'],
  'openai-compatible': ['REASONING_EFFORT'],
  anthropic: ['THINKING', 'THINKING_BUDGET', 'REASONING_EFFORT'],
  gemini: ['REASONING_EFFORT', 'THINKING_BUDGET'],
  deepseek: ['THINKING', 'REASONING_EFFORT'],
  qwen: ['THINKING', 'THINKING_BUDGET', 'STREAM'],
  xai: ['REASONING_EFFORT'],
  moonshot: ['THINKING', 'REASONING_EFFORT', 'STREAM'],
  zhipu: ['THINKING'],
};
const thinkingFields: Field[] = [
  { key: 'API', label: 'API 协议（OpenAI 可选 responses 或 chat-completions）', optional: true },
  { key: 'THINKING', label: '思考开关（enabled / disabled；支持的 Claude 可用 adaptive）', optional: true },
  { key: 'REASONING_EFFORT', label: '思考等级（例如 low / high；具体等级由现有适配器校验）', optional: true },
  { key: 'REASONING_MODE', label: '推理模式（仅已登记模型可填 standard / pro）', optional: true },
  { key: 'THINKING_BUDGET', label: '思考 Token 预算（手动思考时填写；Gemini 可使用其预算语义）', optional: true },
  { key: 'STREAM', label: '流式响应（true / false；部分 Qwen 思考模型须设 true）', optional: true },
];
const budgetFields: Field[] = [
  { key: 'MAX_CALLS', label: '每次作答最多裁判调用次数（完整评审需要两轮）', fallback: '2' },
  { key: 'MAX_INPUT_TOKENS', label: '每次作答裁判总输入 Token 预算', fallback: '120000' },
  { key: 'MAX_OUTPUT_TOKENS', label: '每次作答裁判总输出 Token 预算（含思考）', fallback: '32768' },
  { key: 'MAX_TOKENS_PER_CALL', label: '每轮裁判输出 Token 上限（含思考）', optional: true },
  { key: 'TIMEOUT_MS', label: '单次裁判请求超时（毫秒）', fallback: '300000' },
];

class Cancelled extends Error {}
const nonempty = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

async function input(io: JudgeSetupIO, prompt: string, secret = false): Promise<string> {
  const value = await (secret ? io.secret(prompt) : io.ask(prompt));
  if (value === null || value.trim().toLowerCase() === 'q') throw new Cancelled();
  return value.trim();
}

async function action(io: JudgeSetupIO, prompt: string, choices: string[], fallback = choices[0]!): Promise<string> {
  while (true) {
    const value = (await input(io, prompt)).toLowerCase() || fallback;
    if (choices.includes(value)) return value;
    io.say('请选择提示中的编号，输入 q 取消本次配置。');
  }
}

/** 收集缺失裁判配置，只返回更新；保存和 secret 终端行为由上层启动向导负责。 */
export async function collectJudgeSetup(io: JudgeSetupIO, env: NodeJS.ProcessEnv): Promise<Record<string, string> | null> {
  const updates: Record<string, string> = {};
  const fixed = (field: Field): boolean => nonempty(env[prefix + field.key]);
  const current = (): NodeJS.ProcessEnv => ({ ...env, ...updates });
  const tell = (message: string): void => {
    for (const token of [env.BENCH_JUDGE_TOKEN, updates.BENCH_JUDGE_TOKEN]) if (nonempty(token)) message = message.replaceAll(token!, '[密钥已隐藏]');
    io.say(message);
  };
  const readField = async (field: Field): Promise<void> => {
    if (fixed(field)) return;
    if (field.key === 'PROVIDER') {
      io.say('\n选择裁判供应商（与 DSH 作答供应商独立）：');
      providers.forEach((provider, index) => io.say(`  ${index + 1}. ${provider}`));
      while (true) {
        const value = await input(io, `${prefix}PROVIDER，输入编号或供应商 ID：`);
        const selected = providers.includes(value) ? value : /^\d+$/.test(value) ? providers[Number(value) - 1] : undefined;
        if (selected) { updates[prefix + field.key] = selected; return; }
        io.say('请选择以上九种供应商之一。');
      }
    }
    while (true) {
      const previous = updates[prefix + field.key];
      const fallback = field.secret ? undefined : previous || field.fallback;
      const hint = field.optional ? (fallback ? `回车保留 ${fallback}，- 清空本次值` : '回车沿用适配器/供应商默认') : fallback ? `回车：${fallback}` : '必填';
      const value = await input(io, `${field.label} ${prefix}${field.key}（${hint}）：`, field.secret);
      if (field.optional && value === '-') { delete updates[prefix + field.key]; return; }
      const accepted = value || fallback || '';
      if (/[\u0000-\u001f\u007f]/.test(accepted)) { io.say('输入不能包含控制字符，请重新填写。'); continue; }
      if (!accepted && !field.optional) { io.say('此项不能为空，请重新填写。'); continue; }
      if (accepted) updates[prefix + field.key] = accepted;
      return;
    }
  };
  try {
    if (nonempty(env.BENCH_DSH_ROOT) && nonempty(env.BENCH_DSH_HOME) && !nonempty(env.BENCH_JUDGE_ENDPOINT)) {
      io.say('\n独立 DSH 评分 Agent 配置（工作区权限、root、home、profile 沿用 DSH 作答配置）：');
      const dshFields: Field[] = [
        { key: 'DSH_PROVIDER', label: '评分 Agent 的 DSH 供应商 ID' },
        { key: 'DSH_MODEL', label: '评分 Agent 模型 ID（必须与作答模型分开）' },
        { key: 'DSH_REASONING_EFFORT', label: '评分 Agent 思考等级（default/low/high/max）', fallback: 'default' },
        { key: 'DSH_MAX_TOKENS', label: '评分 Agent 每轮最大输出 Token', fallback: '16384' },
        { key: 'DSH_TIMEOUT_MS', label: '评分 Agent 单轮超时（毫秒）', fallback: '300000' },
      ];
      for (const field of dshFields) await readField(field);
      while (true) {
        try { dshJudgeOptionsFromEnvironment({ ...env, ...updates });
          io.say(`DSH 评分 Agent 参数检查通过：${updates.BENCH_JUDGE_DSH_PROVIDER ?? env.BENCH_JUDGE_DSH_PROVIDER} / ${updates.BENCH_JUDGE_DSH_MODEL ?? env.BENCH_JUDGE_DSH_MODEL}`);
          return updates;
        } catch (error) { if (!(error instanceof JudgeUnavailableError) && !(error instanceof Error)) throw error; tell('DSH 评分配置未通过：' + (error instanceof Error ? error.message : String(error))); return null; }
      }
    }
    io.say('\n裁判配置只做本地检查，本步骤不调用模型。输入 q 取消，本次输入不会交给上层保存。');
    const start = await action(io, '1. 现在补齐裁判配置  2. 暂时跳过（完整代码质量分和总分待定） [回车：2]：', ['1', '2'], '2');
    if (start === '2') return {};
    if (fixed(providerField)) tell(`已有 ${prefix}PROVIDER=${env.BENCH_JUDGE_PROVIDER}，本次保持不变；如需切换，请先修改项目根目录 .env 的该字段，再启动向导。`);
    else await readField(providerField);
    for (const field of requiredFields) await readField(field);
    io.say('\n思考设置：留空使用既有适配器默认，不代表关闭思考。以下仅收集对应字段，模型支持范围由现有裁判校验器判断。');
    const provider = current().BENCH_JUDGE_PROVIDER!;
    if (provider === 'anthropic') io.say('Claude 手动 enabled 需要思考预算；adaptive 不填写手动预算。');
    if (provider === 'gemini') io.say('Gemini 的思考等级与思考预算互斥；按所用模型选择对应字段。');
    if (provider === 'moonshot') io.say('Kimi K3 使用思考等级，K2 系列使用已支持的思考开关，二者不要混填。');
    if (provider === 'deepseek') io.say('关闭思考使用 THINKING=disabled，此时不要填写 REASONING_EFFORT；不要把 off 填入裁判等级。');
    for (const key of controls[provider] ?? []) await readField(thinkingFields.find(field => field.key === key)!);
    io.say('\n裁判预算：总输出包含思考 Token，单轮上限留空由总输出预算和调用次数计算。已有非空配置保持原值。');
    for (const field of budgetFields) await readField(field);
    while (true) {
      try {
        const merged = current();
        const emptyPromptVersion = merged.BENCH_JUDGE_PROMPT_VERSION !== undefined && !nonempty(merged.BENCH_JUDGE_PROMPT_VERSION);
        if (emptyPromptVersion) delete merged.BENCH_JUDGE_PROMPT_VERSION;
        const { config } = judgeConfigFromEnvironment(merged);
        // 已存在但空白的提示版本需写回现有校验器的默认值，避免保存后空串覆盖默认。
        if (emptyPromptVersion) updates.BENCH_JUDGE_PROMPT_VERSION = config.promptVersion;
        // 适配器构造复用现有 TIMEOUT_MS 校验；未调用 review，因此不会发送请求。
        createEnvironmentJudge(current());
        tell(`本地参数检查通过：${config.provider} / ${config.model}；每次作答最多 ${config.maxCalls} 次裁判调用。尚未验证网络与凭据，配置由上层确认保存。`);
        return updates;
      } catch (error) {
        if (!(error instanceof JudgeUnavailableError)) throw error;
        tell(`本地参数检查未通过：${error.message}`);
      }
      io.say('已有非空字段不会覆盖；若错误来自已有配置，请先修改项目根目录 .env。本次新增值可选择重填，密钥不会显示。');
      const editable = [providerField, ...requiredFields, ...thinkingFields, ...budgetFields].filter(field => !fixed(field));
      if (!editable.length) return await action(io, '1. 暂时跳过  q. 取消全部配置 [回车：1]：', ['1']) === '1' ? {} : null;
      io.say('  0. 暂时跳过，放弃本次裁判输入');
      editable.forEach((field, index) => io.say(`  ${index + 1}. ${field.label} (${prefix}${field.key})`));
      while (true) {
        const value = await input(io, '输入要重填的字段编号或环境变量名，0 跳过，q 取消：');
        if (value === '0') return {};
        const selected = editable.find(field => prefix + field.key === value || field.key === value)
          ?? (/^[1-9]\d*$/.test(value) ? editable[Number(value) - 1] : undefined);
        if (selected) { await readField(selected); break; }
        io.say('请输入列表中的字段编号或环境变量名。');
      }
    }
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    io.say('已取消裁判配置；本次输入不会保存。');
    return null;
  }
}
