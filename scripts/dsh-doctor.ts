/**
 * DSH 版本漂移体检：DSH 升级后跑一次，逐项报告本项目的耦合点是否仍然成立。
 *
 * 背景：DSH 0.1.7 重构过三处本项目的依赖（settings-file 改名、llm-deepseek 拆分、
 * agent-presets 目录删除），每次症状都是「探测静默变空」或「真实作答直接失败」，
 * 排查成本高。这里把结论固化成可重复的一条命令：
 *
 *   node --import tsx scripts/dsh-doctor.ts
 *
 * 只读本地文件与已安装包，不联网、不调用模型、不写任何配置。
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshRoot = process.env.BENCH_DSH_ROOT ?? 'C:/Users/A/Documents/deepseek-harness';
const dshHome = process.env.BENCH_DSH_HOME ?? join(homedir(), '.dsh');
const profile = process.env.BENCH_DSH_PROFILE ?? 'sdk';

interface Finding { area: string; ok: boolean; detail: string }
const findings: Finding[] = [];
const check = (area: string, ok: boolean, detail: string): void => { findings.push({ area, ok, detail }); };

// 1. 安装身份
try {
  const sdk = JSON.parse(readFileSync(join(dshRoot, 'packages/sdk/client/package.json'), 'utf8')) as { version?: string };
  check('DSH 安装', true, 'sdk ' + (sdk.version ?? '未知') + ' @ ' + dshRoot);
} catch { check('DSH 安装', false, '读不到 packages/sdk/client/package.json；BENCH_DSH_ROOT 是否正确？'); }

// 2. 本项目运行期会直接读取的资产路径（改动这些是本轮踩过的坑）
const requiredAssets: [string, string][] = [
  ['预设注册表', 'packages/preset/agent-preset-registry/lib/index.js'],
  ['预设资产', 'packages/bundle/web-app/presets/standard.patch.yml'],
  ['迁移平面', 'packages/bundle/web-app/cordis.patch.yml'],
  ['scope 模块', 'packages/core/scope/lib/index.js'],
  ['SDK 客户端', 'packages/sdk/client/lib/index.js'],
  ['CLI 入口', 'apps/cli/lib/bin.js'],
  ['llm 运行时', 'packages/llm/llm/lib/index.js'],
  ['DeepSeek 适配器', 'packages/llm/llm-deepseek-api-key/lib/index.js'],
  ['pi-ai 适配器', 'packages/llm/llm-pi-ai/lib/index.js'],
];
for (const [label, rel] of requiredAssets) {
  const full = join(dshRoot, rel);
  check('资产 ' + label, existsSync(full), existsSync(full) ? rel : '缺失 ' + rel + '（DSH 可能已改名或移动，需同步适配）');
}

// 3. profile 组成：注册表行由哪个 bundle 提供
const profileDir = join(dshHome, 'profiles', profile);
let bundles: string[] = [];
try {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } };
  bundles = manifest.dsh?.profile?.bundles ?? [];
  check('profile ' + profile, true, bundles.length + ' 个 bundle: ' + bundles.join(', '));
} catch { check('profile ' + profile, false, '未初始化：' + profileDir); }

for (const bundle of ['base', 'sdk-app', 'web-app']) {
  const patch = join(dshRoot, 'packages/bundle', bundle, 'cordis.patch.yml');
  if (!existsSync(patch)) continue;
  const declares = /id:\s*agent-preset-registry/.test(readFileSync(patch, 'utf8'));
  if (declares) check('预设注册表行', true, '由 ' + bundle + ' bundle 声明');
}
const profileHasRegistry = bundles.includes('@deepseek-ai/dsh-web-app');
check('本 profile 可注册预设', profileHasRegistry,
  profileHasRegistry
    ? '含 web-app bundle，插件可在运行期注册预设'
    : '不含 web-app bundle：插件声明的预设会静默降级到已废弃的 .agent-presets 目录（重装插件无效，缺的是注册表服务）');

// 4. 关键包能否从该 profile 解析（本轮踩过 settings-file 改名）
for (const pkg of ['@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-llm']) {
  let resolved: string | null = null;
  try { resolved = createRequire(pathToFileURL(join(profileDir, 'package.json')).href).resolve(pkg); } catch { /* 未安装 */ }
  check('解析 ' + pkg, resolved !== null, resolved ?? '无法从该 profile 解析');
}

// 5. settings 宿主：本项目已不装载它，但需确认它仍在（供真实作答的 DSH 使用）
check('settings 包路径', existsSync(join(dshRoot, 'packages/settings/settings/lib/index.js')),
  'packages/settings/settings/lib/index.js（旧名 settings-file 已移除，本项目的目录查询不装载它）');

// 6. 订阅插件（如已安装）的预设归属
const pluginLink = join(dshHome, 'profiles/node_modules/@eddyskywalker/dsh-chatgpt-subscription');
if (existsSync(pluginLink)) {
  let target = pluginLink;
  try { target = realpathSync(pluginLink); } catch { /* 保留原路径 */ }
  const legacy = join(dshHome, '.agent-presets');
  const legacyIds = existsSync(legacy) ? readdirSync(legacy) : [];
  check('订阅插件', true, '已安装 @ ' + target + (legacyIds.length ? '（旧预设目录残留: ' + legacyIds.join(', ') + '，DSH 已不读取）' : ''));
} else {
  check('订阅插件', true, '未安装（跳过）');
}

// 7. 本项目的执行档案与镜像
check('执行档案', true, 'BENCH_PROFILE=' + (process.env.BENCH_PROFILE ?? '(未设置)') + ' BENCH_DSH_PROFILE=' + profile);
const runtimeRecord = join(process.cwd(), 'data/container/runtime.json');
check('固定镜像记录', existsSync(runtimeRecord),
  existsSync(runtimeRecord) ? '存在 data/container/runtime.json' : '缺失：向导会提示「未找到可补齐的固定镜像记录」；镜像本体在则按 docs/container-setup.md 恢复即可');

const failed = findings.filter(f => !f.ok);
console.log('DSH 体检（profile=' + profile + '）');
console.log('');
for (const f of findings) console.log('  ' + (f.ok ? 'OK  ' : 'FAIL') + '  ' + f.area.padEnd(22) + ' ' + f.detail);
console.log('');
console.log(failed.length === 0
  ? '全部通过：本项目的 DSH 耦合点与当前安装一致。'
  : failed.length + ' 项需要同步适配：' + failed.map(f => f.area).join('、'));
// 这是体检报告，不是判据：某些 FAIL 是本组合的**已知且有意**的取舍（例如 sdk 不挂
// web-app bundle，因而插件无法在运行期注册预设——自动作答不需要它）。因此始终以 0 退出，
// 避免让一条信息性命令阻断 pnpm check；要机器判读请解析输出中的 FAIL 行。