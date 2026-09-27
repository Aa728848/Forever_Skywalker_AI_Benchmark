---
name: benchmark-run-comparison
description: Use when the user wants to compare benchmark experiment reports across models/providers — computing averages and per-dimension statistics, correcting rows scored under superseded scoring rules, and producing a shareable HTML comparison report. Triggers include "对比这几个模型", "帮我分析这几份报告", "出个图表", "which model did better", or any request to analyze two or more data/experiments runs.
---

# 多模型实验报告对比分析

把 \`data/experiments\` 下若干份实验报告变成一份可分享的 HTML 对比 + 一套可复核的统计。**结论必须能追溯到原始证据**，不能靠读报告页截图猜测。

## 铁律

1. **只读原始报告，绝不改写 \`data/experiments/**\`**。修正只发生在内存和 \`data/analysis/\` 的新产物里。
2. **先确认评分口径再比分数**。不同时间跑的报告可能用了不同评分规则；直接求平均是把两种口径混在一起。
3. **质量分待定（\`total: null\`）的行不计入均分**，也不当 0 分。缺测不补分是这个项目的硬约定。
4. **区分「模型没做对」与「基础设施/端点故障」**。前者是有效信号，后者不是——见下方「归因」一节。
5. 每个数字都要能指出它的来源文件与字段。

## 第一步：盘点有哪些报告

\`\`\`powershell
Get-ChildItem data\experiments -Directory | Where-Object { $_.Name -ne '.trash' }
\`\`\`

每份报告目录里有 \`experiment.json\`（唯一事实来源）、\`report.md\`、\`evidence.json.gz\`。
\`experiment.json\` 的关键结构：

| 字段 | 含义 |
| --- | --- |
| \`state\` | \`completed\` / \`failed\` / \`cancelled\` / \`running\` |
| \`settings.provider\` / \`.model\` | 实际作答的供应商与模型 |
| \`settings.presets\` / \`.modes\` | DSH 预设与思考等级（**不同组合不可合并比较**） |
| \`settings.concurrency\` | 并行度，影响墙钟时间 |
| \`rows[]\` | 逐题：\`taskId\`、\`phase\`、\`solver.finishReason\`、\`solver.durationMs\`、\`evaluation.status.classification\`、\`.scoring.{functional,quality,total}\`、\`.knownFailures\` |

**开始分析前先核对三件事**：\`state\` 是否为 completed、\`presets/modes\` 是否一致、逐行 \`phase\` 是否都是 \`done\`。任何一项不合，先说明口径差异再决定能不能比。

## 第二步：确认评分口径（最容易出错的地方）

评分规则演进过。已知的分界点：

- **提交 \`680d0a0\`（2026-09-27 02:14 +0800）** 起：\`check-failed\` 的**可用验证分记 0**，不再按「通过项权重比例」给部分分。
  在此之前跑的实验，含 \`check-failed\` 的行会带着 40~48 的部分分，是按旧规则算的。

判断一份报告是否需要修正：

\`\`\`js
const RULE_CUTOFF = Date.parse('2026-09-26T18:14:14.000Z'); // = 680d0a0 提交时间
reportNeedFix = Date.parse(doc.startedAt) < RULE_CUTOFF;
\`\`\`

**修正方法：从归档证据重算，不要估算。**

\`evidence.json.gz\` 是一个 JSON，\`files[]\` 每项 \`{ path, base64 }\`。需要修正的行：

\`\`\`js
const archive = JSON.parse(zlib.gunzipSync(readFileSync(dir + '/evidence.json.gz')));
const byPath = new Map(archive.files.map(f => [f.path, f]));
const base = 'runs/' + row.taskId + '/' + status.runId + '/' + status.attemptId + '/execution/';
const exec = JSON.parse(Buffer.from(byPath.get(base + 'execution.json').base64, 'base64'));
// exec.classification === 'check-failed' 就是新规则唯一的输入
\`\`\`

修正后的值：\`functional = 0\`、\`quality\` 不变、\`total = quality\`。**在报告里显式标出哪些行被修正了**（旧值→新值）。

> 若新规则再次变更，先在 \`docs/notes/implemented/\` 里找 owning note（\`bug-fix/2026-09-27-failure-isolation-and-zero-scores.md\` 是当前 owner），按它的事实改 \`RULE_CUTOFF\` 与公式，**不要凭记忆**。

## 第三步：区分「有效失败」与「端点故障」

这一步决定结论可不可信。**必须解开会话记录看根因**，不要只看 \`finishReason\`。

逐题会话记录在 \`%TEMP%\fsa-dsh-experiment-*\runtime\<sessionId>\sessions\...\session.v4.jsonl.zstd\`。
⚠️ 它是**多帧 zstd 拼接**，\`zstdDecompressSync\` 只解出第一帧，会得到假象「只有 1 行」。必须按 magic \`28 b5 2f fd\` 切帧后逐帧解：

\`\`\`js
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function framesOf(buf) { const idx = []; let at = buf.indexOf(MAGIC, 0);
  while (at !== -1) { idx.push(at); at = buf.indexOf(MAGIC, at + 4); }
  const out = []; for (let i = 0; i < idx.length; i++) out.push(buf.subarray(idx[i], i + 1 < idx.length ? idx[i + 1] : buf.length));
  return out; }
let text = ''; for (const f of framesOf(readFileSync(p))) { try { text += zlib.zstdDecompressSync(f).toString('utf8'); } catch {} }
\`\`\`

然后看最后一个 \`turn/end\`：

| 观察到 | 归因 | 能不能算模型能力 |
| --- | --- | --- |
| \`{"kind":"completed"}\` | 正常答完 | ✅ 算 |
| \`{"kind":"max-tokens"}\` | 撞到输出上限 | ⚠️ 部分算，要说明 |
| \`{"kind":"error","error":{"code":"PI_AI_ERROR","message":"Concurrency limit exceeded for user…"}}\` | **上游限流** | ❌ 不算 |
| \`llm/retry\` 里出现 \`RATE_LIMIT\` / 503 \`SERVER\` 多次 | **端点不稳定** | ❌ 不算 |
| \`{"kind":"aborted"}\` | 取消/超时 | ❌ 不算 |

**并行度是常见诱因**：\`--concurrency 3\` 共用一个端点很容易触发供应商的并发上限。诊断出限流时，建议用户降到 1 重跑，而不是给模型下结论。

## 第四步：统计与产物

把产物写到 \`data/analysis/\`（该目录被 git 忽略，不进仓库）：

\`\`\`
data/analysis/
  <name>-dataset.json   逐行修正后数据（含 original 字段保留旧值）
  <name>-stats.json     聚合统计
  <name>-comparison.html 交付物
\`\`\`

**必须有的维度**（少一个都可能误导）：

- 总均分 / 中位总分 / 最低分 —— 中位数与均分差距大，说明失败集中而非全面偏弱
- 可用验证均分（/50）与质量均分（/50）**分开报** —— 分水岭通常在可用验证，不在代码质量
- 通过 / 未通过 / 待定 三个计数
- 按难度、按赛道（core/integration）、按领域分组
- 逐题对照表，标出被修正的行
- 墙钟时间（**必须标注并行度**，否则不可横向比）

## 第五步：HTML 交付物

参照本 skill 的 \`assets/comparison-template.html\`：单文件、无外部依赖、深色现代风、双击即开。
生成方式：模板里有唯一占位符 \`__STATS__\`，用字符串替换注入统计 JSON——**注意不要用 \`String.replace\` 直接传含 \`$\` 的字符串**（\`$&\` 等会被当成替换模式），用 \`split/join\` 或函数式 replace。

生成后**必须验证**，不能只看文件大小：

1. 取出嵌入的 JSON 重新 \`JSON.parse\`，确认能被解析；
2. 用 DOM 桩执行页面脚本，确认卡片/表格/图表节点都渲染出来；
3. 若本机有 Chrome，截图确认成图：
   \`\`\`powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=1300,3400 --screenshot=out.png "file:///<绝对路径>/x.html"
   \`\`\`
   Playwright 的浏览器在**项目内**缓存：`playwright.config.ts` 会把 `PLAYWRIGHT_BROWSERS_PATH` 指向 `.cache/playwright`，所以 `pnpm test:e2e` 能用。但独立脚本直接 `import { chromium } from '@playwright/test'` **不会**加载该配置，会报「Executable doesn't exist」——要么自己设 `PLAYWRIGHT_BROWSERS_PATH`，要么用上面的 Chrome headless。
   散点图要**放大到实际分布区间**，用全量程会把点全挤在角落。

## 交付结论怎么写

按这个顺序，缺一不可：

1. **修正说明**：哪些行、旧值→新值、依据什么（点名证据文件），并声明未改动原始报告。
2. **对比表**：核心几个指标 + 三个计数。
3. **可信度警告**：哪些行因端点故障/取消而不可作为模型能力证据，逐条列出根因。
4. **观察到的模式**：如「多数模型共同失败的题」，并明确标注这需要题目侧复核，**不作为模型结论**。
5. **口径限制**：并行度不同导致的耗时不可比、待定行不计入均分、样本仅一轮无重复。

## 反面清单（本项目已踩过的坑）

- ❌ 只用 \`report.md\` 或网页截图做结论——必须回 \`experiment.json\` 与证据归档。
- ❌ 把 \`finishReason=error/timeout\` 直接算成模型能力——先解开会话看是不是限流。
- ❌ 用 \`zstdDecompressSync\` 单次解压读会话——多帧，会只拿到第 1 行。
- ❌ 把 \`total: null\` 当 0 分或直接丢弃不说明——它是「待定」，要单独计数并说明原因。
- ❌ 把不同 \`presets/modes\` 或不同 DSH 版本的结果混在一起求平均——\`comparisonGroups\` 会因漂移拒绝合并，人工分析同样不许合并。
- ❌ 直接 `chromium.launch()` 却不设 `PLAYWRIGHT_BROWSERS_PATH`——浏览器其实在项目 `.cache/playwright` 里，绕过 `playwright.config.ts` 才会误报「未安装」。
