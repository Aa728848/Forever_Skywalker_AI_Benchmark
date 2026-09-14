import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { judgeConfigFromEnvironment, JudgeUnavailableError } from '@fsa/judge';
import { readProjectEnvironment, saveProjectEnvironment } from './env-file.ts';
import { collectJudgeSetup, type JudgeSetupIO } from './judge-setup.ts';
import { dshWorkspacePermissionLabels, resolveDshWorkspacePermission } from '../../../packages/evaluation/src/dsh.ts';

export interface EnvironmentSetupResult { env: NodeJS.ProcessEnv; saved: boolean; cancelled: boolean }
class SetupCancelled extends Error {}
const present = (value: string | undefined) => Boolean(value?.trim());
const imageId = /^sha256:[a-f0-9]{64}$/;

function missingGroups(env: NodeJS.ProcessEnv): string[] {
  const groups: string[] = [];
  if (!present(env.BENCH_RUN_TOKEN) || !present(env.BENCH_SUBMISSIONS_DIR) || !present(env.BENCH_PROFILE)) groups.push('基础运行配置');
  if (env.BENCH_PROFILE === 'linux-container' && (!present(env.BENCH_IMAGE) || !present(env.BENCH_IMAGE_DIGEST))) groups.push('固定 Linux 镜像');
  if (present(env.BENCH_DSH_ROOT) && present(env.BENCH_DSH_HOME) && !present(env.BENCH_DSH_WORKSPACE_PERMISSION)) groups.push('DSH 工作区权限');
  try { judgeConfigFromEnvironment(env); }
  catch (error) { if (!(error instanceof JudgeUnavailableError)) throw error; groups.push('裁判配置'); }
  return groups;
}

async function value(io: JudgeSetupIO, prompt: string, fallback = ''): Promise<string> {
  const answer = await io.ask(`${prompt}${fallback ? ` [回车：${fallback}]` : ''}：`);
  if (answer === null || answer.trim().toLowerCase() === 'q') throw new SetupCancelled();
  return answer.trim() || fallback;
}

async function pick(io: JudgeSetupIO, prompt: string, labels: string[], fallback = 1): Promise<number> {
  io.say('\n' + prompt);
  labels.forEach((label, index) => io.say(`  ${index + 1}. ${label}`));
  while (true) {
    const input = await value(io, '输入编号', String(fallback));
    if (/^[1-9]\d*$/.test(input) && Number(input) <= labels.length) return Number(input);
    io.say('请输入列表中的编号，或 q 退出。');
  }
}

async function pathValue(io: JudgeSetupIO, prompt: string, fallback: string, root: string, mustExist = false): Promise<string | null> {
  while (true) {
    const input = await value(io, prompt + (mustExist ? '；s 暂时跳过' : ''), fallback);
    if (mustExist && input.toLowerCase() === 's') return null;
    const unquoted = /^(".*"|'.*')$/.test(input) ? input.slice(1, -1) : input;
    if (!unquoted.trim() || /[\u0000-\u001f\u007f]/.test(unquoted)) { io.say('请输入有效目录。'); continue; }
    const path = resolve(root, unquoted);
    if (!mustExist || (existsSync(path) && statSync(path).isDirectory())) return path;
    io.say('该目录不存在，请重新填写；尚未安装 DSH 可输入 s 跳过。');
  }
}

function recordedImage(root: string): string | null {
  const path = join(root, 'data', 'container', 'runtime.json');
  if (!existsSync(path)) return null;
  try {
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof record === 'object' && record !== null && 'image' in record && 'imageDigest' in record
      && typeof record.image === 'string' && imageId.test(record.image) && record.image === record.imageDigest) return record.image;
  } catch { /* 旧记录不可用时由操作者填写，不猜测镜像摘要。 */ }
  return null;
}

/** 只收集并补齐本项目环境；确认保存前不写文件、不创建会话或调用模型。 */
export async function configureProjectEnvironment(io: JudgeSetupIO, options: { root: string; env: NodeJS.ProcessEnv; force?: boolean }): Promise<EnvironmentSetupResult> {
  const snapshot = readProjectEnvironment(options.root, options.env);
  const env = snapshot.effectiveEnv;
  const result = (cancelled = false): EnvironmentSetupResult => ({ env, saved: false, cancelled });
  const missing = missingGroups(env);
  if (!options.force && snapshot.text !== null && missing.length === 0) return result();
  io.say(`\n环境快速配置：${snapshot.text === null ? '尚未创建本项目 .env' : missing.length ? '尚未完成：' + missing.join('、') : '基础与裁判已配置，可补齐可选目录'}。\n只补缺失或空值，保留已有非空配置。输入 q 取消，确认保存之前不修改文件。`);
  try {
    if (await pick(io, '现在配置环境吗', ['补齐缺失配置', '暂时跳过，继续启动菜单']) === 2) return result();
    const updates: Record<string, string> = {};
    const merged = () => ({ ...env, ...updates });
    const setMissing = (key: string, input: string) => { if (!present(env[key])) updates[key] = input; };
    io.say('\n配置 1/3：运行与 Linux 环境。');
    if (!present(env.BENCH_RUN_TOKEN)) { updates.BENCH_RUN_TOKEN = randomBytes(32).toString('hex'); io.say('将生成本地 API 访问令牌（不显示）。'); }
    if (!present(env.BENCH_SUBMISSIONS_DIR)) setMissing('BENCH_SUBMISSIONS_DIR', (await pathValue(io, '外部作答父目录', join(homedir(), 'Documents', 'BenchAnswers'), options.root))!);
    if (!present(env.BENCH_RUN_DIR)) setMissing('BENCH_RUN_DIR', (await pathValue(io, '运行记录目录', join(options.root, 'data', 'runs'), options.root))!);
    if (!present(env.BENCH_PROFILE)) {
      const profile = await pick(io, '评分环境', ['固定 Linux 容器（DSH 自动测评使用此环境）', '本机预览（不能替代 DSH 的 Linux 评分）']);
      updates.BENCH_PROFILE = profile === 1 ? 'linux-container' : 'local';
    } else io.say(`已有评分环境：${env.BENCH_PROFILE}，保持不变。`);
    if (merged().BENCH_PROFILE === 'linux-container' && (!present(env.BENCH_IMAGE) || !present(env.BENCH_IMAGE_DIGEST))) {
      const pinned = recordedImage(options.root);
      if (pinned && (!present(env.BENCH_IMAGE) || env.BENCH_IMAGE === pinned) && (!present(env.BENCH_IMAGE_DIGEST) || env.BENCH_IMAGE_DIGEST === pinned)) {
        setMissing('BENCH_IMAGE', pinned); setMissing('BENCH_IMAGE_DIGEST', pinned);
        io.say('将复用 data/container/runtime.json 中的固定镜像。实际运行时仍会检查本机镜像。');
      } else {
        io.say('未找到可补齐的固定镜像记录；也可先保存其他配置，之后运行 pnpm container:build。');
        for (const key of ['BENCH_IMAGE', 'BENCH_IMAGE_DIGEST']) {
          if (present(merged()[key])) continue;
          const other = key === 'BENCH_IMAGE' ? merged().BENCH_IMAGE_DIGEST : merged().BENCH_IMAGE;
          while (true) {
            const input = await value(io, `${key}（不可变 sha256:...；s 稍后配置）`, other && imageId.test(other) ? other : 's');
            if (input === 's') break;
            if (imageId.test(input)) { updates[key] = input; break; }
            io.say('请输入 sha256: 加64位小写十六进制摘要，或 s 跳过。');
          }
        }
      }
    }
    setMissing('BENCH_MEASURE_PERFORMANCE', '1');

    io.say('\n配置 2/3：DSH 目录（作答模型和模式随后在启动菜单选择）。');
    if (!present(env.BENCH_DSH_ROOT) || !present(env.BENCH_DSH_HOME)) {
      if (await pick(io, '使用 DSH 自动做题吗', ['补齐 DSH 目录', '暂时不用 / 稍后配置']) === 1) {
        if (!present(env.BENCH_DSH_ROOT)) {
          const path = await pathValue(io, 'DSH 项目目录', join(homedir(), 'Documents', 'deepseek-harness'), options.root, true);
          if (path) updates.BENCH_DSH_ROOT = path;
        }
        if (!present(env.BENCH_DSH_HOME)) {
          const path = await pathValue(io, 'DSH 配置目录', env.DSH_HOME || join(homedir(), '.dsh'), options.root, true);
          if (path) updates.BENCH_DSH_HOME = path;
        }
        setMissing('BENCH_DSH_PROFILE', 'sdk');
      }
    } else io.say('已有 DSH 路径保持不变。');
    if (present(merged().BENCH_DSH_ROOT) && present(merged().BENCH_DSH_HOME) && !present(env.BENCH_DSH_WORKSPACE_PERMISSION)) {
      const permission = await pick(io, 'DSH 工作区权限（写入 .env；默认仅当前题目目录可写）', Object.entries(dshWorkspacePermissionLabels).map(([id, label]) => `${label} [${id}]`), 2);
      updates.BENCH_DSH_WORKSPACE_PERMISSION = resolveDshWorkspacePermission(Object.keys(dshWorkspacePermissionLabels)[permission - 1]!);
    } else if (present(env.BENCH_DSH_WORKSPACE_PERMISSION)) {
      try { io.say(`已有 DSH 工作区权限：${dshWorkspacePermissionLabels[resolveDshWorkspacePermission(env.BENCH_DSH_WORKSPACE_PERMISSION!)]}，保持不变。`); }
      catch { io.say('已有 DSH 工作区权限值无法识别；启动向导中会要求重新选择。'); }
    }
    if (!present(env.BENCH_DSH_REPORT_DIR)) setMissing('BENCH_DSH_REPORT_DIR', (await pathValue(io, 'DSH 报告父目录', join(options.root, 'data', 'experiments'), options.root))!);
    io.say('DSH 作答供应商的密钥仍由 DSH 自己管理，不复制到本项目。');

    io.say('\n配置 3/3：独立裁判。');
    const judge = await collectJudgeSetup(io, merged());
    if (judge === null) throw new SetupCancelled();
    Object.assign(updates, judge);
    if (Object.keys(updates).length === 0) { io.say('没有需要补齐的项目，.env 保持不变。'); return result(); }
    io.say(`\n将保存到 ${snapshot.path}：`);
    for (const [key, input] of Object.entries(updates)) io.say(`  ${key}=${key.endsWith('_TOKEN') ? '已填写（隐藏）' : input}`);
    if (await pick(io, '确认保存', ['保存并继续启动菜单', '放弃本次修改，继续菜单']) === 2) return result();
    const saved = saveProjectEnvironment(options.root, updates, snapshot);
    io.say('已保存 .env，本次启动立即使用新增配置。令牌未进入命令参数或报告。');
    const remaining = missingGroups(saved.effectiveEnv);
    if (remaining.length) io.say(`仍待配置：${remaining.join('、')}；可在启动菜单选择“补齐 .env 配置”。`);
    return { env: saved.effectiveEnv, saved: true, cancelled: false };
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.say('已取消环境配置，.env 未修改。');
    return result(true);
  }
}
