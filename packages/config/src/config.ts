import { resolve as resolvePath } from 'node:path';
import { dshJudgeOptionsFromEnvironment } from '@fsa/evaluation';
import { judgeConfigFromEnvironment, JudgeUnavailableError } from '@fsa/judge';

/** 缺失分组名：与交互向导印出的中文分组一一对应，便于直接展示给操作者。 */
const basicGroup = '基础运行配置';
const imageGroup = '固定 Linux 镜像';
const dshPermissionGroup = 'DSH 工作区权限';
const judgeGroup = '裁判配置';

/** 密钥键判定：只看键名，绝不读取值来决定是否隐藏。 */
export const secretKeyPattern = /(_TOKEN|_SECRET|_KEY|_PASSWORD)$/i;

/** 只允许固定取值的配置；其它取值无法被现有执行链路解释。 */
const enumeratedValues: Record<string, readonly string[]> = { BENCH_PROFILE: ['local', 'linux-container'] };

const integerFields = new Set(['BENCH_JUDGE_MAX_CALLS', 'BENCH_JUDGE_MAX_INPUT_TOKENS', 'BENCH_JUDGE_MAX_OUTPUT_TOKENS',
  'BENCH_JUDGE_MAX_TOKENS_PER_CALL', 'BENCH_JUDGE_TIMEOUT_MS', 'BENCH_JUDGE_DSH_MAX_TOKENS', 'BENCH_JUDGE_DSH_TIMEOUT_MS']);
const pathFields = new Set(['BENCH_SUBMISSIONS_DIR', 'BENCH_RUN_DIR', 'BENCH_DSH_REPORT_DIR', 'BENCH_DSH_ROOT', 'BENCH_DSH_HOME']);
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

/** 与 env-file.ts 的 merge() 保持一致：Windows 上环境变量名大小写无关。 */
const nameOf = (name: string): string => process.platform === 'win32' ? name.toUpperCase() : name;

/** 补丁里的 undefined 表示「不设置」，与 readProjectEnvironment 的合并语义一致。 */
function merged(env: NodeJS.ProcessEnv, patch: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(patch)) if (value !== undefined) result[name] = value;
  return result;
}

function judgeError(env: NodeJS.ProcessEnv): string | null {
  try {
    if (present(env.BENCH_DSH_ROOT) && present(env.BENCH_DSH_HOME)) dshJudgeOptionsFromEnvironment(env);
    else judgeConfigFromEnvironment(env);
    return null;
  } catch (error) {
    if (!(error instanceof JudgeUnavailableError)) throw error;
    return error.message;
  }
}

export interface ConfigViewOptions {
  /** 解析相对路径的基准目录；缺省用 process.cwd()。 */
  baseDirectory?: string;
}

/**
 * 判断「基础运行配置」「固定 Linux 镜像」「DSH 工作区权限」「裁判配置」四组未完成项。
 * 只读检查，不写文件、不调用模型。
 */
export function missingGroups(env: NodeJS.ProcessEnv): string[] {
  const groups: string[] = [];
  if (!present(env.BENCH_RUN_TOKEN) || !present(env.BENCH_SUBMISSIONS_DIR) || !present(env.BENCH_PROFILE)) groups.push(basicGroup);
  if (env.BENCH_PROFILE === 'linux-container' && (!present(env.BENCH_IMAGE) || !present(env.BENCH_IMAGE_DIGEST))) groups.push(imageGroup);
  if (present(env.BENCH_DSH_ROOT) && present(env.BENCH_DSH_HOME) && !present(env.BENCH_DSH_WORKSPACE_PERMISSION)) groups.push(dshPermissionGroup);
  if (judgeError(env) !== null) groups.push(judgeGroup);
  return groups;
}

/** 字段级校验错误：调用方据此逐字段提示，不需要解析一个大异常。 */
export interface ConfigFieldError {
  readonly field: string;
  readonly message: string;
}

/**
 * 逐字段校验配置补丁，返回字段级错误（全部通过时返回空数组）。
 * 补丁涉及 BENCH_JUDGE_* 或 BENCH_DSH_ROOT/BENCH_DSH_HOME 时，改用 @fsa/evaluation 的
 * dshJudgeOptionsFromEnvironment 或 @fsa/judge 的 judgeConfigFromEnvironment 做本地检查。
 * 只读检查：不写文件、不调用模型、不因字段问题抛出异常。
 */
export function validateConfigPatch(env: NodeJS.ProcessEnv, patch: Record<string, string | undefined>, options: ConfigViewOptions = {}): ConfigFieldError[] {
  const errors: ConfigFieldError[] = [];
  const add = (field: string, message: string): void => { errors.push({ field, message }); };
  for (const [name, value] of Object.entries(patch)) {
    if (!namePattern.test(name)) { add(name, '环境变量名只能包含字母、数字和下划线，且不能以数字开头。'); continue; }
    if (value === undefined || value.trim() === '') continue;
    if (controlCharacterPattern.test(value)) { add(name, '值不能包含控制字符。'); continue; }
    const key = nameOf(name);
    const allowed = enumeratedValues[key];
    if (allowed !== undefined && !allowed.includes(value.trim())) { add(name, '必须是 ' + allowed.join(' 或 ') + '。'); continue; }
    if (integerFields.has(key) && !(/^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value.trim())) && Number(value.trim()) > 0)) { add(name, '必须是正整数。'); continue; }
    if ((key === 'BENCH_IMAGE' || key === 'BENCH_IMAGE_DIGEST') && !imagePattern.test(value.trim())) { add(name, '必须是 sha256: 加 64 位小写十六进制摘要。'); continue; }
    if (pathFields.has(key)) {
      if (value.startsWith('~')) { add(name, '不支持 ~ 展开，请填写完整路径。'); continue; }
      resolvePath(options.baseDirectory ?? process.cwd(), value);
    }
  }
  if (errors.length > 0) return errors;
  const touchesJudge = Object.keys(patch).some(name => nameOf(name).startsWith('BENCH_JUDGE_')
    || nameOf(name) === 'BENCH_DSH_ROOT' || nameOf(name) === 'BENCH_DSH_HOME');
  if (touchesJudge) {
    const message = judgeError(merged(env, patch));
    if (message !== null) add('BENCH_JUDGE_*', message);
  }
  return errors;
}

/** 每个键的对外视图：密钥键只暴露是否已配置，其余键返回值本身。 */
export type MaskedConfigEntry = {
  readonly source: 'file' | 'environment';
  readonly shadowed: boolean;
} & ({ readonly value: string } | { readonly configured: boolean });

/**
 * 生成可安全打印的配置视图。密钥键（/_TOKEN|_SECRET|_KEY|_PASSWORD$/i）只返回 configured。
 * source 与 shadowed 依据 env-file.ts 中 merge() 的既有语义：trim 后非空的 OS 环境变量优先于 .env；
 * 某键在 .env 有非空值却被 OS 环境变量覆盖时 shadowed 为 true。
 */
export function maskedConfigView(env: NodeJS.ProcessEnv, fileValues: Record<string, string>): Record<string, MaskedConfigEntry> {
  const view: Record<string, MaskedConfigEntry> = {};
  const keys = new Set<string>();
  for (const name of Object.keys(fileValues)) keys.add(nameOf(name));
  for (const name of Object.keys(env)) keys.add(nameOf(name));
  for (const key of keys) {
    const file = fileValues[key];
    const environment = env[key];
    const fromFile = present(file);
    const fromEnvironment = present(environment);
    const source = fromEnvironment ? 'environment' as const : 'file' as const;
    const effective = fromEnvironment ? environment! : fromFile ? file! : environment ?? file ?? '';
    view[key] = secretKeyPattern.test(key)
      ? { configured: present(effective), source, shadowed: fromFile && fromEnvironment }
      : { value: effective, source, shadowed: fromFile && fromEnvironment };
  }
  return view;
}

/** 环境中实际生效且非空的密钥值，供日志与流式输出脱敏使用。 */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).filter(([name, value]) => secretKeyPattern.test(name) && present(value)).map(([, value]) => value as string);
}

/** 脱敏流工具：调用方每次 put 一个 chunk，取回可以安全输出的部分。 */
export interface RedactingStream {
  push(chunk: string): string;
  flush(): string;
}

/**
 * 把密钥值替换为 [已隐藏]。为了跨 chunk 边界也不漏出密钥，无法判定归属的尾部一律留在缓冲区：
 * 只有「既不是完整命中，也不是某个密钥前缀」的字符才会被输出，因此密钥被任意切分到多个 chunk 也不会被拆开。
 * 缓冲区最多保留「最长密钥长度 - 1」个字符；流结束时必须调用 flush() 取回尾部。
 */
export function redactStream(secrets: readonly string[]): RedactingStream {
  const values = [...new Set(secrets.filter(value => value.length > 0))].sort((left, right) => right.length - left.length);
  const firstCharacters = new Set(values.map(value => value[0]!));
  let pending = '';
  const partialAt = (text: string): boolean => values.some(value => value.length > text.length && value.startsWith(text));
  return {
    push(chunk: string): string {
      pending += chunk;
      let output = '';
      let index = 0;
      while (index < pending.length) {
        const hit = values.find(value => pending.startsWith(value, index));
        if (hit !== undefined) { output += '[已隐藏]'; index += hit.length; continue; }
        // 当前位置不是密钥起点、也不是某个密钥的前缀时，整段到下一个可能起点之间都没有风险。
        if (partialAt(pending.slice(index))) break;
        let next = index + 1;
        while (next < pending.length && !firstCharacters.has(pending[next]!)) next += 1;
        output += pending.slice(index, next);
        index = next;
      }
      pending = pending.slice(index);
      return output;
    },
    flush(): string {
      const text = pending;
      pending = '';
      let output = '';
      for (let index = 0; index < text.length;) {
        const hit = values.find(value => text.startsWith(value, index));
        if (hit === undefined) { output += text[index]; index += 1; } else { output += '[已隐藏]'; index += hit.length; }
      }
      return output;
    },
  };
}
