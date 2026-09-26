# 开发交接与执行手册

## 2026-09-26 测评并行：259 分钟 → 约 87 分钟（3 路）

用户反馈「测试时间太久了」。实测 55 题耗时 **259 分钟**，分解：作答 120 分钟（46%），
容器验证 + 两轮裁判 + 归档 139 分钟（54%）。主循环逐条串行，三类工作从不重叠。

**新增 `--concurrency <1-8>`**（默认 1 = 原串行行为逐字不变）：固定大小 worker 池，
3 路可让作答、容器验证与裁判评分重叠。网页「发起测评」表单也有「并行度」输入框。

估算（作答与验证/评分都重叠）：2 路约 130 分钟、**3 路约 87 分钟**、4 路约 65 分钟。

改动的四个要点：
1. 停止语义由 `break` 改为停止标记——并行时在飞行的行必须收尾，不能半截。
2. 落盘改唯一临时名 + Promise 链串行，否则并发写互相覆盖、rename 乱序。
3. 落盘链**有界**：返回前排空再关闭。少了这步会在调用方清理目录后抛 `ENOENT` 未处理拒绝。
4. 隔离前提本就成立（独立 workspace / 唯一容器名 / 独立 DSH 会话 / 每题独立裁判实例），未改动评分路径。

**一处自我纠正**：我起初判定「裁判适配器内的队列是跨题瓶颈」并据此征询了用户；
查清该实例是**每题新建**后，队列只序列化同一题的两轮，并非跨题瓶颈，故未改它。

**直接证据**：测试记录「同时在飞」峰值——串行 1、3 路 3，且 3 路墙钟显著更短。
本轮验证：`pnpm check` exit 0（**377 项**）。

## 2026-09-26 续跑实测完成：55/55 无待定

续跑按钮的**真 bug 已修**：按钮只发实验标识（这是对的——续跑不该让用户重选题目与等级），
但 plan 仍按界面缺省值构造，与报告里的 55 题/ptc/high 不符，`--resume` 的配置核对**拒绝了自己**，
所以界面点了没反应。现在续跑的 plan **取自报告里的 settings**。

修完后的真实续跑（`exp-2026-09-26T11-21-31-129Z-32e16e34`）：复用 46 行、重跑 9 行，
9 条问题题全部拿到分数，**55/55 已落定、0 待定**：

| 题 | 续跑前 | 续跑后 |
| --- | --- | --- |
| GRAPH-04 | 待定 | 93.63 |
| STATE-01 | 待定 | 97.6 |
| STATE-03 | 待定 | 96.55 |
| INT-HARNESS | 出错 | 95.11 |
| INT-SUB | 未作答 | 93.36 |
| INT-VERIFIER | 未作答 | 93.23 |
| INT-TRADING | 未作答 | 98 |
| INT-WEB | 未作答 | 95.51 |
| INT-PY | 未作答 | 96.54 |

**续跑暴露的第二个真 bug**：9 条全好、55/55 已落定，`state` 却是 `failed`，`issues` 一条
「未找到作答：run-…/attempt-…」。原因是续跑只为新跑的行建 run 记录，复用行的 run 数据在
上一次 scratch 里（已清理），而汇总会拿报告里**全部**带 evaluation 的行去 `summarizeRuns`。
修复：续跑开始时把既有归档**解回**本次 scratch（`restoreComparisonEvidence`），并校验路径与摘要。

本轮验证：`pnpm check` exit 0（**376 项**）、`pnpm test:e2e` 9 项通过；解回逻辑做了反向验证。

## 2026-09-26 续跑与重试：一次 55 题实验的三种失败

用户跑完 55 题，截图显示 1 题「出错」、多题「待定」。诊断出**三个互相独立**的原因：

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| INT-HARNESS 出错，整轮 `state=failed` | `persist()` 用裸 `renameSync`，Windows 上文件被占用即 `EPERM` | 改名带重试（EPERM/EACCES/EBUSY/ENOTEMPTY） |
| GRAPH-04 / STATE-01 / STATE-03 待定 | 模型在中文字符串里写裸 ASCII 引号，JSON 被截断，整轮判决作废 | 适配器对无效响应重试一次；`calls` 只在成功时自增 |
| INT-SUB / INT-VERIFIER / INT-TRADING / INT-WEB / INT-PY 未作答 | 运行中止后从未执行 | `--resume <id>` 只补跑未完成行 |

**新增 `--resume <id>`**：复用已落定的行，只重跑 phase 非 done、或 total 为 null 的行。
配置（供应商/模型/预设/等级/重复次数）必须与既有报告一致才允许续跑，否则拒绝——不同配置的分数不可合并。
证据归档在续跑时**合并**，不覆盖：落定行的 `evidenceRefs` 指向旧 scratch，覆盖会让它们悬空。

**一个容易写错的判据**：「已落定」不能只看 `phase === 'done'`。待定行的 phase 同样是 `done`，
只按 phase 判断会把它们当已完成跳过，待定就永久留在报告里。必须要求**拿到数值总分**。

**网页新增「续跑未完成的 N 条…」按钮**（报告中心）：N 按同一判据统计，两步确认，结果提示在页面级。
对真实失败报告实测显示「续跑未完成的 9 条」，与逐行核对的 9 条一致。

**真实报告核对**：对 `exp-2026-09-26T11-21-31-129Z-32e16e34`（55 行、failed）套用落定判据，
续跑复用 46 行、重跑 9 行，用户截图里需要修的 9 个题 **9/9 覆盖、零遗漏**。

本轮验证：`pnpm check` exit 0（**368 项**）、`pnpm test:e2e` **9 项**通过。

## 2026-09-26 评分：两轮评审不同即取平均；报告中心增加总体评价

用户实测 12 题，出现 **1 个待定（LSP-01）**，要求「取消人工复核部分，2 次不同就采用平均值」，并补上「平均总分评价」。

**LSP-01 为什么待定**：它的两轮评审是 100/100/100 与 78/80/80，差异 22 分超过旧的 20 分阈值，触发 `needsHumanReview`；调用方据此**整份丢弃**两轮结果，评审分缺失 → 质量分与总分一起待定。它两轮都是有效判决，不是失败。

**改动**：
- `compareReviews` 不再因分歧置 `needsHumanReview`；两轮不同直接给出平均，差异只逐维记录在 `differences` 与 `reasons` 里供复核参考。
- 「两轮不可比」与「两轮分数不同」分开：前者（配置指纹、服务端返回模型、DSH 运行时或预设指纹不一致、两轮门槛结论不同）记入 `comparabilityWarnings`，**分数照样取平均**但保留告警并写进 notes。只有「两轮都判不可判」才真正没有可平均的东西。
- 顺带修一处遗留：`compareReviews` 判断「两轮是否可能跨越门槛」用的是四维时代的固定 `0.125`，删维后每维满分是 `qualityPointsPerDimension`（`50/3`）；改用该常量后系数从 0.225 修正为 0.300，否则门槛交互判断低估 1.33 倍。

**真实数据验证**：把 LSP-01 现场的两轮判决喂给新逻辑，`needsHumanReview=false`、平均 89/90/90，不再作废。按静态 100/100/100 合成后，该题由「待定」变为 **96.90/100**，落在其余 11 题（94.83–99.50）的同一区间。

**报告中心新增「总体评价」**：平均总分、中位总分、最低/最高、已评分/待定条数、低于 70 分条数。关键规则是**待定项不参与平均**——把 `total: null` 当成 0 会把「还不知道」误报成「很差」（同一份数据会从 97.27 掉到 89.17）。待定条数单独显示，并在提示里说明它们不参与平均。

**反向验证**：把 `packages/evaluation/src/index.ts` 里落地评审分的条件从 `unjudgedEverywhere` 改回「`needsHumanReview` 即作废」，`evaluation.test.ts` 的「三维齐备」用例立刻失败（`expected null to be 88`）——正是 LSP-01 当时的表现；恢复后通过。（我第一次的「反向验证」改错了行：那条只影响 `reasons` 文本，不影响作废决策，属于无效验证，已改为在真正的判定点上做。）

本轮验证：`pnpm check` exit 0（**364 项**）、`pnpm test:e2e` **9 项**通过。

## 2026-09-26 网页清理记录与报告：移入回收目录，不删除

用户要求「在对应的界面增加清理记录和清理报告的按钮」。三处界面都加了：**报告中心**清理实验报告、**运行记录**清理单次作答、**发起测评**清理启动记录（账本）。

**核心取舍：移动而不是删除。** 这些目录是评测证据——报告里有 `experiment.json`、`report.md`、`evidence.json.gz` 与逐条作答记录，运行记录里还有冻结快照与全部评分证据，删掉不可恢复。清理统一把条目移进该根目录下的 `.trash/`，列表立刻干净，误删仍可手动移回。界面与接口的措辞都是「移入回收目录」。

**实现只用 `renameSync`。** 仓库明令禁止递归删除（会穿过 junction 抹掉链接指向的真实目录）。`renameSync` 既不跟随链接也不递归删除，因此结构上不存在这个风险；收尾清空目录用 `rmdirSync`，它拒绝删除非空目录。

**四道护栏，任一不过即整笔拒绝**（且在移动任何东西之前报错）：相对路径规范（非空、非绝对、无 `..`）、目标存在、`lstat` 不是符号链接或 junction、`realpath` 仍落在真实根目录之内。拒绝链接是刻意的——把 junction 移进回收站虽然只移动链接本身，但之后「清空回收目录」时的递归删除会穿过它抹掉真实目录。

**必须同步维护索引**：运行记录列表先读 `index.json` 再逐个读目录，若留着指向已移走目录的条目，`readJson` 会抛错导致**整个运行记录列表打不开**，幂等键也会仍被认为已用过。新增 `RunStore.forgetMissing()` 在清理后丢弃目录已不存在的条目。

**拒绝清理尚未落定的东西**：运行中的 attempt（`active` 有条目）与未落定的启动记录都拒绝——账本是对账依据，移走会让 sweeper 失去依据、进程失管。三个列表扫描都跳过 `.trash`，否则清理过的条目会重新出现。

### 过程中修掉的两个真实缺陷

1. **清理请求根本到不了服务端**：前端在无请求体的 DELETE 上带了 `content-type: application/json`，Fastify 以 `400 FST_ERR_CTP_EMPTY_JSON_BODY` 拒绝。浏览器里表现为「清理失败（400）：Bad Request」。新增无体的 `authHeaders()`（只带令牌）给所有 DELETE 使用。**我的进程内测试当时没带这个头，所以第一次是假通过**——是 e2e 抓出来的。
2. **清理后看不到结论**：被清理的报告立刻从列表消失，明细区随之换成空状态，而结论提示当时渲染在明细区里，用户永远看不到自己刚做的事成功了没有。改为渲染在列表之外。

### 顺带修正上一轮的遗留

上一轮移除性能维度时，从示例夹具 `examples/assessment.json` 删掉了 `demo-benchmark`，使 `tests/e2e/workbench.spec.ts` 里「4 类证据」的断言失效。`pnpm check` 不跑 e2e，所以它逃过了那次验收。已改为按夹具长度断言，不再写死魔法数字。

本轮验证：`pnpm check` exit 0（**364 项**，28 个文件）、`pnpm test:e2e` **9 项**通过。清理护栏有反向验证——去掉 `lstat` 的符号链接判断后该用例失败，说明护栏是承重的。

## 2026-09-26 评分口径：移除性能维度，质量分改由三维构成

用户要求「缺的那一维度取消了」——把 `performance` 从代码质量评分中移除，四维变三维。

**为什么该维注定缺分**：本项目的受控验证成本配对实测测量的是**验证链路耗时**（含启动与断言成本），不是候选代码本身的性能，用它给候选打分名不副实；而 55 题中 **0 题**有独立的 `benchmark.ts` 性能负载。该维因此必然缺证据，而 `composeQuality` 要求四维齐备才出总分——一个度量不到候选性能的维度把总分永久锁死。

**关键约束：删维不得缩小刻度。** 质量分恒为 50 分（与可用验证各占一半）。每维满分改为由维度个数推导（`qualityTotalPoints / 维度个数` = `50/3`），而不是把 12.5 改成别的常数——增删维度时 50/50 基线自动保持。

**保留采集**：配对实测仍会跑并写入 `benchmark-samples.json`。它作为发布校准需要的环境事实与参考/候选对照证据依然有价值，只是不再产生维度分。

**改动范围**：`packages/contracts`（权重、三个维度形状、新增刻度常量）、`packages/core`（`composeQuality`/`scoreAssessment` 改用推导刻度、客观证据统一为 `static`）、`packages/judge`（`sampleVerdict`、`compareReviews`）、`packages/evaluation`（裁判提示词改为三维、DSH 与 HTTP 两条链一致）、`packages/executor`（评审形状落盘）、`scripts/score-rehearse.ts`。裁判提示词必须同步改——否则会继续索要一个不再评分的维度。

**端到端实测**：`pnpm score:rehearse` 输出三维 91/86/95 → 质量 **45.33/50**、总分 **95.33/100**、门槛 true；`packages/executor` 落盘用例实测三维齐备时 `quality=44`、`total=84.67`（此前因缺 performance 恒为 null）。

**顺带修掉一个测试隔离缺陷**：`apps/api/src/app.test.ts` 的正式运行用例没有隔离仓库根 `.env`，而 `.env` 含 `BENCH_JUDGE_DSH_*`，于是该用例真的去调用模型裁判——同一用例在不同运行分别给出 39.63 与 null 两种分数，且单跑耗时 63 秒。改为注入空配置后确定性通过，耗时降到 1.2 秒。全量测试从 64 秒降到 28 秒。

本轮验证：`pnpm check` exit 0（**358 项**，27 个文件全过）。缺证据仍然保持待定——删维不是「缺测变完整成绩」，三维中任一侧证据缺席时该维为 `null`、总分待定。

## 2026-09-26 DSH 0.1.7 同步：预设挂载、目录发现与直达入口

DSH 升级到 0.1.7-rc.2 后有三处破坏性重构，本项目已同步适配，并修掉一个被掩盖的既有缺陷。

**预设挂载**：旧路径 `packages/preset/agent-presets/**` 已删除，真实作答会直接 `ENOENT`，而 `pnpm dsh:compare --check` 仍报「预检通过」（假通过）。现改为读 `packages/bundle/web-app/presets/<id>.patch.yml` 并把整份 YAML 作为第二个 launch patch 层交付（含 `!!js` 标签，JSON 层无法承载）；注册表入口改为 `packages/preset/agent-preset-registry/lib/index.js`，其 Config 只剩 `default`。两个必须显式处理的事实：预设声明行与 bridge 并发激活，直接 mount 会随机拿到空列表，故轮询 `list()` 并先查 broken；「创造」预设依赖两个宿主行，缺任一个启动即失败。`--check` 现在校验预设挂载前置条件，缺资产即 exit 1。

**目录发现**：`packages/settings/settings-file` 已改为 `packages/settings/settings`（`FileSettingsProvider` 全库不存在，新服务要求注入 `profileContext`/`configEditor`）。查询**不再装载 settings 宿主插件**——适配器不需要它即可注册路由；适配器改为具名导出模块，按模块命名空间交给 cordis；DeepSeek 入口移到 `llm-deepseek-api-key`。订阅渠道插件声明注入 `settings`，缺该服务会永远停在 pending 且不报错，现提供**不带 register** 的同形状接缝（带 register 会让插件改用空的进程内作用域），并把真实 home 的 `storages/*-models.json` 复制进临时 home（凭据不复制）。本机实测 7 个供应商、26 个模型：deepseek-official、antigravity(12)、kimi-code(4)、command-code、workbuddy-subscription、codex-chatgpt(6)，含各自声明的思考等级。

**预设枚举**：读 `presets/*.patch.yml` 解析 id/name/order，无需启动 DSH 运行时；探测失败时前端回退内置四项并显示原因。只枚举文件里声明的预设，不冒充运行期注册的那些。

**失败可诊断**：此前探测失败一律回落成「请手工填写」，真实原因被外层 catch 吞掉，DSH 漂移与「没安装」无法区分。现在 worker 的 stderr 保留有界片段，父进程用分类器压成结构性事实（缺失资产路径 / 无法解析的模块 / 装载失败的插件）再进 warning，并提示需同步适配。异常原文不回传——插件异常可能带凭据；第一版直接被既有的不泄漏用例拦下。

**`.env` 遮蔽（既有缺陷）**：API 的 dev 脚本曾带 `--env-file-if-exists`，把 `.env` 载入 `process.env`，于是每个键遮蔽自己——配置页签「保存即生效」实际失效，界面还满屏误报「被系统环境变量覆盖」。现由 ConfigProvider 自己读文件；真实 OS 变量仍优先并仍被正确标注。新增 `start-web.cmd` / `pnpm start:web` 非交互直达网页（缺 `.env` 时明确报错，不静默失败、不写文件）。

本轮验证：`pnpm check` 通过（348 项测试，含新增守卫用例）、`pnpm test:e2e` 7 项通过；四个预设经真实 DSH 运行时逐个挂载成功（`observedPresets` 分别等于请求值，旧实现为 ENOENT）；缺失预设资产的 DSH root 上 `--check` exit 1（旧实现 exit 0）。仍未做真实模型调用，评分与发布校准继续待定。

## 2026-09-26 网页成为完整操作入口：报告中心、配置面板与受控发起测评

网页新增三个页签（共六个：题目目录、评分预览、运行记录、报告中心、发起测评、配置）。**报告中心**只读列出报告根下一层的实验报告，展开逐条作答阶段、阶段统计、进度日志与清理状态，并可下载 `report.md`/`experiment.json`/`evidence.json.gz`；损坏报告仍列出并写明原因，不会被静默跳过。**配置面板**分「作答 / 裁判 / 目录与预算」三组写入项目 `.env`，保存分两步（先看待写清单、确认后才落盘），密钥字段永不回显，保存后本进程立即按新值工作、**无需重启 API**；`BENCH_RUN_DIR` 与 `BENCH_DSH_ROOT/HOME/PROFILE`、`BENCH_IMAGE`、`BENCH_IMAGE_DIGEST`、`BENCH_PROFILE` 只读并给出原因，写入路径也真的拒绝。**发起测评**默认「仅预检」（`check: true`，不调用模型），真实作答需二次确认并显示计划总作答次数。

实验子进程不被 API 持有：链路是 `API --spawn(detached)--> scripts/experiment-supervisor.ts --spawn--> scripts/dsh-compare.ts`。supervisor 做自登记握手、子进程执行前的令牌与租约授权屏障、5 秒心跳（租约 30 秒）、持有并终止整棵进程树、子进程退出时原子写退出事实、代理取消。展示语义由纯函数 `mergeState(experimentState, recordState, exitFact, cleanupState)` 唯一决定：四个事实互相独立，无退出事实且租约过期时报 `unknown`（不推断为失败），清理只认 `experiment.json` 的明写值，`pending` 一律「清理未知，可能残留」。sweeper 每 10 秒对账一次并在 API 启动时先跑一次；`GET /api/experiments` 是纯读，不写账本。

`.env` 读写迁到新包 `packages/config`（`@fsa/config`），`packages/evaluation` 新增 DSH 模型目录与预设/权限标签导出。本轮 `pnpm check` 通过 332 项测试（27 个测试文件）及严格类型、目录一致与生产构建；`pnpm test:e2e` 7 项通过（含 config-panel 3 项、report-center 2 项）。实测确认仓库根 `.env` 全程未被创建、`GET /api/config` 响应不含任何密钥值、无令牌 `POST /api/config` 返回 401。

已知限制如实记录：Windows 上取进程启动时间依赖 PowerShell `Get-CimInstance`，负载高时可能超时，此时归属降级为 `unconfirmed`（取消路径另有「心跳仍在租约内」作为独立证据）；Windows 上几乎不会报「已确认无残留」，`taskkill /t` 之后无法排除脱离进程组的后代，因此刻意保守报 `unknown`；未先配好 `BENCH_DSH_ROOT/HOME` 时网页改不了 `BENCH_JUDGE_*` 字段（`validateConfigPatch` 会退回不认 `BENCH_JUDGE_DSH_*` 的 HTTP 裁判校验，返回 400），真实部署先跑 `pnpm start` 的正常路径不受影响；报告中心目前只扫描单个报告根，多报告根登记与跨根历史保留属后续阶段；真实模型端的端到端取消未验证（需要真实额度），测试全程使用假脚本。详见 [网页操作入口 Note](notes/implemented/feature/2026-09-26-web-config-and-launch.md) 与 [报告中心 Note](notes/implemented/feature/2026-09-26-experiment-report-api.md)。

## 2026-09-16 订阅渠道进入 DSH 模型目录

DSH 模型目录发现现在按 BENCH_DSH_PROFILE 读取该 profile 的 dsh.profile.bundles，把 DSH 安装目录之外的本地插件包（订阅渠道）装进目录子进程再枚举 provider/model，因此 ChatGPT 订阅、Command Code、Kimi Code 等会出现在启动向导与 pnpm bench judge-setup 的供应商列表里；插件装载失败只丢该插件的路由并提示手工填写，不影响其余目录。查询仍然禁网、禁子进程、禁读 .credentials*/.env*，文件写入被收窄到本次查询的临时 DSH home（插件把凭据物化在 $DSH_HOME 下），真实 home 只读并在查询后整体回收。未初始化或非法的 profile 名直接返回手工输入提示。

本轮离线验证：dsh-catalog.test.ts 12/12；真实本机读取（未调用模型、未联网）在 profile=web 下得到 deepseek-official / antigravity / kimi-code / command-code / codex-chatgpt，profile=sdk 下与改动前一致只有 deepseek-official；tsc --noEmit 通过，全量 pnpm check 见下。订阅渠道是否可用仍取决于用户在该 profile 里是否已登录，目录只列路由、不验证凭据与额度。订阅渠道插件声明注入 webServer，sdk profile 默认不挂该服务、插件会整体停在 pending；把插件装进 sdk 后还必须在 profiles/sdk/cordis.patch.yml 补一个 loopback webserver（port 0），两步都已写入 docs/quick-start.md。详见 [订阅渠道目录 Note](notes/implemented/feature/2026-09-16-dsh-subscription-channel-catalog.md)。

## 2026-09-15 裁判模型的 DSH 供应商/模型设置过程

新增裁判模型的设置流程：环境补齐向导在 DSH 目录就绪时，改用与作答模型相同的本地目录发现（`discoverDshModels`）列出供应商、按关键词过滤模型、从模型声明的思考等级中选择，并补齐每轮输出上限、单轮超时与提示版本；目录不可用时手工输入。新增独立命令 `pnpm bench judge-setup`，可随时重设裁判模型：读取当前 `.env`、显示现有 DSH 评分 Agent、重新选择、列出待写字段，确认 `y` 后才落盘；启动菜单新增“设置裁判模型”入口。全程不调用模型、不请求网络。

`.env` 写入器新增显式 `replace` 选项：默认仍只补缺失/空值（向导行为不变），只有独立命令在确认后覆写列出的 `BENCH_JUDGE_DSH_*`/`BENCH_JUDGE_PROMPT_VERSION`，其它键、注释与 CRLF 保持原样；多行引号值等无法安全定位的赋值直接拒绝写入。已有但无效的非空值会被重新询问，不再因“已填写”而放行。详见 [裁判模型设置 Note](notes/implemented/feature/2026-09-15-dsh-judge-model-setup.md)。

本轮离线验证：`tsc --noEmit` 通过；`env-file.test.ts`、`judge-dsh-setup.test.ts`、`judge-setup.test.ts`、`env-setup.test.ts` 共 40/40 通过；`launcher.test.ts` 新增入口用例通过（仅有既存的 `spawnSync EPERM` 沙箱失败）。未调用模型或裁判。

## 2026-09-15 评分判决协议中断与缺失评分修复

最新 CACHE-02 实验（`187fb412`）执行与性能采样通过、功能分 50，但第 2 轮评分判决未过 `ReviewVerdict` 协议校验，四维评审分缺失使质量分与总分继续待定，且失败轮原始响应被丢弃、报告不写原因。已修复三处：平台自有字段 `cost`/`reviewedAt` 改由平台注入（不再要求模型回显）；模型附带的装饰字段与重复证据引用按记录式归一化处理，写入 `normalizations` 与执行说明，四维分数与证据引用仍严格校验；`JudgeProtocolError` + `explainReviewVerdict` 保留失败轮 `roundId`、原始响应（≤64 KiB）与字段路径，落盘为 `review-round-<n>-error.json`，`review-error.json` 增加 `roundId`/`issues`，报告对这类行输出「待定原因」。

历史实验目录不改写；要拿到质量分必须用同一作答（`bench review`）或重新运行实验。两轮独立判决的规则未变：任一轮不通过仍保持质量分待定，不得补分。详见 [协议中断诊断 Note](notes/implemented/bug-fix/2026-09-15-dsh-judge-protocol-diagnostics.md)。

本轮离线验证：`tsc --noEmit` 通过；`dsh-judge.test.ts` 7/7（含 3 项新增）。

## 2026-09-15 DSH 评分启动错误修复

归档实验 `b71463a5-468d-4250-900d-c6de8bf03ad8` 的 Linux 检查与性能采样均通过；失败根因为评分桥接插件访问 `ctx.tools` 时漏声明 `tools` 注入，随后超长错误堆栈又使 `notes` 超过协议限制。现已修复注入声明，并将超长说明完整保存为 `execution-notes.json`、摘要保持在协议长度内。33 项评分/执行专项测试及本地假 SSE 的真实 DSH SDK 两轮评分通过（未调用外部模型）。旧实验报告保留原样；重新运行同一命令即可取得新评分。

## 2026-09-15 评分待定排查

已核对本机 `.env`：DSH 评分为 `command-code / deepseek/deepseek-v4.1-flash`、思考等级 `high`、`minimal` 评审预设，两轮使用独立 session；`pnpm bench judge-config` 通过。评分响应解析已兼容 JSON 前后的简短说明或 Markdown 围栏，仍严格校验协议身份和证据引用。`pnpm dsh:compare --check --provider command-code --model deepseek/deepseek-v4.1-flash --preset ptc --reasoning high --tasks CACHE-02` 在 Docker Desktop Linux 引擎可访问时通过；若终端提示 `docker_engine` 或 `.docker/config.json` access denied，应先使用有权限的用户启动 Docker Desktop，并确认 Docker context 为 `desktop-linux`。修复提交为 `64e07d3`，已推送公开仓库。

## 最新交付：DSH 评分 Agent 已接入质量链

`createQualityProvider()` 现在默认使用 `createDshJudgeFromEnvironment`，不再自动路由到 HTTP 裁判。评分 Agent 每轮创建独立 DSH session，采用 review-only 无工具预设，严格校验 JSON、题目/运行身份、版本和证据引用；两轮需保持 DSH 版本、预设指纹和模型路由一致。评分模型通过 `BENCH_JUDGE_DSH_PROVIDER`、`BENCH_JUDGE_DSH_MODEL`、`BENCH_JUDGE_DSH_REASONING_EFFORT`、`BENCH_JUDGE_DSH_MAX_TOKENS`、`BENCH_JUDGE_DSH_TIMEOUT_MS` 配置。`BENCH_DSH_ROOT/HOME/PROFILE/WORKSPACE_PERMISSION` 沿用作答 DSH 配置，未知用量记为 null。评分超时、无效响应或回收失败继续保持质量分待定，不生成假分数。

本轮离线验证：`dsh-judge.test.ts` 与 `evaluation.test.ts` 共 6 项通过；未调用真实模型。评分模型可以与作答模型相同，但仍是不同 session。真实 DSH 供应商认证和正式评分校准仍需用户另行运行，不能把离线结果当作模型成绩。

更新：2026-09-14。本文件描述当前状态；历史 M0/M1 Note 保留当时事实，不用于推断当前完成度。

## 最新交付：DSH 工作区权限与报告路径

DSH 自动比较新增 `BENCH_DSH_WORKSPACE_PERMISSION` / `--workspace-permission`，支持 `read-only`、`workspace-write`（默认，建议代码题使用）和 `danger-full-access`。运行时通过 DSH 公开的 `DSH_PERMISSION_MODE` 环境变量传给 SDK；每题独立工作区作为边界，权限写入 `experiment.json` 并显示在 `report.md`。快速启动和首次 `.env` 配置均可选择，完整访问会显示警告。报告默认位于 `data/experiments/<时间戳>-<随机ID>/`，结束时打印 `report.md`、`experiment.json`、`evidence.json.gz` 的绝对路径；`BENCH_DSH_REPORT_DIR` 或 `--output` 可更改父目录。相关记录见 [DSH 权限 Note](notes/implemented/feature/2026-09-15-dsh-workspace-permission.md) 与 [报告位置 Note](notes/implemented/feature/2026-09-14-report-location-output.md)。本轮未调用真实模型/裁判。

用户已授权继续完成项目和安装 Linux 依赖。工作目录：`C:/Users/A/Documents/ChatGPT/Forever_Skywalker_AI_Benchmark`。七个来源仓库只读；接手先检查 git status，保留当前改动，不重新初始化。

用户已自行重启Windows，固定Linux容器已配置并验收。实际模型评测仍暂停；不会因环境就绪自动调用真实裁判。

## 最新交付：快速配置 .env

`pnpm start`/`start.cmd` 在缺少 `.env` 或关键字段时先进入环境配置：生成本地 API 访问令牌，选择提交/运行目录和 Linux 或本机档案，复用已记录的固定镜像，补齐 DSH 项目/home/报告路径，并用本地校验器收集裁判供应商、端点、模型、隐藏令牌、思考参数和预算。已有非空环境变量、`.env` 注释/未知键和 DSH 原配置保留；OS 非空同名变量优先。令牌不进入普通提示、命令参数或报告，确认前不写文件，取消/放弃保存不会落盘；保存后新环境只传给本次及其子进程，不隐式改写当前 `process.env`。

裁判表单支持8家原生供应商及 OpenAI-compatible，参数检查复用 `judgeConfigFromEnvironment`/`createEnvironmentJudge`，没有网络请求或真实模型调用。DSH 本地目录读取仍只返回 provider/model/已声明思考等级；没有目录或额外 profile 时保留手工输入。快速配置实现、保存并发保护、密钥终端行为见 [环境配置 Note](notes/implemented/feature/2026-09-14-env-setup.md)、[裁判表单 Note](notes/implemented/feature/2026-09-14-judge-setup.md) 和 [终端 Note](notes/implemented/feature/2026-09-14-terminal-secret-input.md)。

本轮最终 `pnpm check` 通过247项测试、严格类型、55题目录与生产构建；配置相关聚焦测试38项。此前快速启动实测仍有效，新增环境配置测试使用系统临时目录和虚构令牌，未读取或修改用户真实 `.env`，未调用模型/裁判。

## 最新交付：终端分步启动

新增 `pnpm start` 和 Windows 根目录 `start.cmd`。向导依次选择供应商/模型、DSH预设、思考等级、题目、预算和报告目录；最后展示组合次数、裁判状态与可复制命令，默认仅预检。还可导出外部作答、提交完成作答、启动网页/API或检查Linux环境。外部作答默认导出到仓库外的 `Documents/BenchAnswers`；不改写.env、原DSH配置或评分规则。

DSH目录读取调用已安装DeepSeek/Pi-ai适配器的本地接口，返回provider/model和声明的思考等级，不调用远程目录或模型。额外插件/profile覆盖有明确手工输入入口。未声明等级默认default；同名模型按供应商隔离。完整操作见 [快速启动](quick-start.md)，实现与限制见 [向导Note](notes/implemented/feature/2026-09-14-interactive-launcher.md) 和 [本地目录Note](notes/implemented/feature/2026-09-14-dsh-local-model-catalog.md)。

本轮 `pnpm check` 215项测试、严格类型、55题目录和构建通过。真实Windows终端选择标准/PTC × off/high，CACHE-02共4次计划，最终仅预检通过；模型调用0。外部导出实跑、项目外调用start.cmd并q退出通过，临时验证目录已清理。未变更题包或网页/API行为，不重复全量题目和浏览器验证；下方202项为上一轮交付。

## 最新交付：55题全量工程质量复核

逐题审查55题后改善32题、澄清4题、保留19题。新版任务强化异步生命周期、持久事务/崩溃恢复、多资源并发、插件发布回滚、增量图和有界流式投影；基础题保留作退化门槛。原有及新增83个近似错误修复均有对应版本和补丁哈希的有效检出记录。逐题版本、理由和证据见 [全量审查矩阵](reviews/2026-09-14-full-task-quality-audit.md) 与 [机器矩阵](../catalog/task-quality-audit.json)。

固定Linux分18题及37题两批复验，55/55通过；55个起始缺陷精确检出，参考/替代110次均50/50。PERF-03/04新增专用主路径负载各参考/替代一次，共4/4通过；不是正式配对性能校准。最终 `pnpm check` 202项、严格类型/目录/构建通过，本轮端到端2项通过。原始记录与逐题结果见 [最新Linux验收](trials/2026-09-14-full-quality-linux-validation.md)。下方旧题版本、检查数和历史“待强化”项不覆盖本节最新结论。

新增 [从启动到看报告](quick-start.md)：Docker负责Linux评分；`dsh:compare`自行启动DSH SDK；`pnpm dev`只负责网页/API；不用DSH则export给编程AI后submit。`--all`选全部55题，`--provider`与`--model`联合确定供应商和模型；同名模型不跨供应商匹配。`--reasoning default`省略DSH思考参数，适用于未声明等级的模型，与明确传off不同；原默认off/high保持。独立审查及修复见 [默认思考参数Note](notes/implemented/bug-fix/2026-09-14-dsh-provider-default-reasoning.md)。

全部任务仍fixture-ready，真实模型/裁判调用0；83个错误变体不是83次AI作答，实际模型通过率、难度和评分阈值继续待校准。根变更记录见 [全量工程质量Note](notes/implemented/testing/2026-09-14-full-engineering-task-quality.md)。本轮按用户授权提交并推送公开仓库，保留已有预览标签。

## GitHub 公开预览

用户已授权全部推送并明确选择公开仓库： [Aa728848/Forever_Skywalker_AI_Benchmark](https://github.com/Aa728848/Forever_Skywalker_AI_Benchmark)。首个预览标签为 `v0.1.0-preview.1`，保留 master 与既有历史；[发布说明](releases/v0.1.0-preview.1.md) 明确评分和难度尚待校准。

发布检查补齐被通用 dist/ 忽略的153个固定 YAML 运行时文件。Git导出的干净目录已通过198项检查、2项界面/API端到端及INT-WEB三向验证；.env、依赖安装目录、本机运行产物不发布。审查和验证依据见 [发布 Note](notes/implemented/process/2026-09-14-github-preview-publication.md)。

## 最新交付：DSH 自动模式比较

用户追加要求现已接入：裁判 `.env` 思考等级说明与两轮映射回归；DSH 标准/PTC/极简/创造真实预设（`standard/ptc/minimal/cordis`），与 `--model`、`--reasoning` 独立设置；`--output` / `BENCH_DSH_REPORT_DIR` 指定报告父目录。比较使用独占临时 RunStore，最终只保留 Markdown、experiment.json 和带哈希的压缩证据，报告校验落盘后清理本次工作区、会话/缓存/附件和评分中间数据。历史共享运行目录与原 DSH 配置不删除；回收或写报告失败保留现场并明确标记。

预设通过 SDK 公开 patch 和 Agent preset 作用域接口在首个模型请求之前挂载，实际选择事件必须核对。已使用真实 DSH 对本机假 SSE 服务检查四种预设均完成且工具集不同，没有外部模型请求；最终 `pnpm check` 198项及类型/目录/构建通过，Windows新命令预检通过。详细命令与清理边界见 [DSH 自动对比](dsh-comparison.md)，验收见 [Agent Note](notes/implemented/feature/2026-09-14-dsh-presets-and-report-cleanup.md)。下方185项为上次交付历史。

新增 `pnpm dsh:compare --model <模型ID>`，通过本地同版 DSH TypeScript SDK 自动导出独立工作区、建立新会话、指定思考等级、等待完成、提交 Linux 验证与质量评分，并保存逐次记录与模式对比表。默认 CACHE-02、Off/High 各一次，可选题目/等级/重复数。`--check` 不启动 DSH 或调用模型，见 [使用说明](dsh-comparison.md)。

仅明确 completed 触发评分；失败/超时/取消与未启动项保留，缺测不补分，环境/裁判漂移拒绝均分，核心和集成分开。费用和供应商实际返回版本未取得，保持缺失。DSH SDK profile 不自动复刻 Web profile；运行时关闭不等于所有脱离工具进程已回收。

本轮 `pnpm check` 通过185项测试及类型/目录/构建；DSH真实SDK模块导入与Linux镜像预检通过，只有模拟作答回归，无真实模型请求。DSH供应商认证、实际作答及独立裁判仍需用户启动后验收；不要把此自动化入口写成已跑出真实模型成绩。记录见 [Agent Note](notes/implemented/feature/2026-09-14-dsh-mode-comparison.md)。

## 最新验收：Linux环境已就绪

固定镜像与.env配置已完成，API健康检查为runProfile=linux-container、isolatedExecution=true。网络、非root、只读、CPU/内存/PID、超时/取消/OOM回收5项实际验收通过；PERF-04专用负载18次容器测量通过，模型调用0。

全量55题三种实现首次54/55通过；GRAPH-04发现测试构造超大断言差异导致OOM，已保持完整20,000节点语义做最小修复，针对复跑1/1通过。最终覆盖55/55，参考与替代110次均50/50，55个起始缺陷准确检出。修复与失败记录均保留，见 [Linux验收报告](trials/2026-09-14-linux-container-validation.md)。另修复了执行记录对Docker扩展参数的32项限制，原始题目命令限制保持不变。

当前阻塞已从容器环境移除；剩余是真实模型/裁判试跑以及静态、性能与难度发布校准，用户尚未启动这些操作。下方“172项测试”等属于上一批对应版本验收。

## 最新交付：裁判配置与题目质量

- 裁判支持8供应商和旧兼容入口，按实际模型校验思考/采样/输出参数，保存固定参数指纹与usage；`pnpm bench judge-config`仅做本地配置检查，不调用模型。说明及官方来源见 [供应商参数](judge-providers.md)。
- 两轮参数或服务返回模型不一致会转待复核；不同裁判参数/版本的作答不能混入同一汇总。
- API-04/GRAPH-04升级0.2.0，分别新增真实SQLite跨进程任务协议，以及批次依赖图与诊断发布一致性。两题共6种近似错误修复全部由预声明目标检出，工具为 `pnpm task:mutants <ID>`。
- 题库审查发现部分原高难题实际偏局部，不能把三向通过当作难度证明；仍有待强化题列在 [质量审查](task-quality-review.md)。规模保持48核心+7集成，全部仍为fixture-ready。
- 最新 `pnpm check` 通过172项测试及类型/目录/构建，`pnpm test:e2e` 2项通过；两题受控回归参考均50/50。详见 [本轮验收](trials/2026-09-14-judge-and-task-quality.md)。下方131项及55题报告属于前一批对应版本的历史验收。

## 当前状态

| 范围 | 已交付 | 剩余验收 |
| --- | --- | --- |
| 核心题库 | 48 道完整题包；五组证据、Windows与固定Linux三种实现验收通过 | 难度与规则校准 |
| 来源集成 | 7/7 固定提交模块集成；来源许可/哈希、Windows与Linux三种实现验收通过 | 发布校准 |
| 完成/执行 | CLI/API 完成、冻结、执行、评分、回收与修订；Linux真实边界5项通过 | 真实模型作答与独立裁判验收 |
| 质量评分 | TS/Python/F# 静态事实；真实性能配对；两轮独立 DSH 评分 Agent、预算、证据、人工复核 | 用户配置 BENCH_JUDGE_DSH_*；真实评分 Agent 和静态/性能阈值校准 |
| 中文面板 | 六个页签：目录、评分预览、run/attempt 检查与时间线、报告中心（实验列表/明细/四产物下载）、配置面板（.env 掩码读写、保存即时生效）、发起测评（仅预检默认 + supervisor 托管 + 取消） | 随改动运行端到端测试；真实模型端的取消尚未验证 |
| Linux | Engine29.7.2/Linux、固定镜像四运行时、5项边界、55题三种实现及性能链均通过 | 固定环境上的发布校准 |

fixture-ready 不等于 ready。缺客观或评审证据时总分保持 null；本机为 local，未满足发布门槛的容器结果为 rehearsal；脚本演练不是模型成绩。

## 本轮修复

- 幂等提交、活跃执行、重启恢复与冻结摘要统一；查询最新完成修订，下载证据验证路径和哈希。
- Node 采用独立测试进程、恢复受信公开检查；重复 ID、异常退出、超时/OOM 和输出超限不能用 PASS 日志绕过。
- 本机历史不再显示为正式成绩；API realpath 校验阻止 junction 越过提交根目录。
- 静态分析读取冻结源码；两轮评审材料一致；性能保留两次预热及七轮配对，不挑最佳样本。
- API-02/03、CONC-02、LIFE-04、STATE-04、THR-01/03、PERF-02/04 补足幂等、字节流、会话、真实线程/进程、DOM 和测量行为。
- 新题及 API-04/GRAPH-04 曾缺功能分组，已补真实检查；manifest 和 trial 增加完整 50/50 门禁。
- 生成器拒绝覆盖既有包；失败仅回滚本次新目录。

## 验收与继续执行

```powershell
Set-Location -LiteralPath 'C:\Users\A\Documents\ChatGPT\Forever_Skywalker_AI_Benchmark'
git status --short --branch
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
pnpm trial --all
pnpm score:rehearse
```

平台类型/目录/131 项测试/生产构建、2 项浏览器端到端和真实性能配对链路均已通过。48/48 核心与 7/7 集成的参考可用分全部 50/50，缺陷均被声明检查检出，见 [55 题最终验收报告](trials/2026-09-14-full-fixture-audit.md)。`data/trials/2026-09-14T10-00-09-173Z` 是发现空评分组的首次审查记录，其结论已由后续回归取代，保留用于解释修复。

修改题目先冻结契约并提升版本，再跑 `pnpm task:verify <ID>`。必须起始缺陷在预声明项失败、参考与不同实现全部通过，才能标 fixture-ready。不能为了通过而删除失败项。改 catalog 后运行 `pnpm catalog:docs`。

## Linux 接续

用户已重启，Docker Linux引擎与固定镜像已就绪，详情见 [container-setup.md](container-setup.md)。日常使用 `pnpm container:status`、`pnpm container:verify` 与 `pnpm container:trial --all --alternatives`；不要每次评测都重建镜像。构建会更新.env的执行档案，保留裁判与访问令牌。

最终不可变image ID已保存在data/container/runtime.json，完整环境元数据及汇总在同目录；镜像含Node/.NET/Python/Chromium。没有容器即失败，不回退宿主。网络、CPU/内存/PID和回收已有真实验收，修改执行器后用container:verify重新确认。

## 裁判与发布校准

本项目 .env 已创建并配置本地访问令牌、提交目录和运行目录；DSH 评分 Agent 使用共用 DSH home 的供应商凭据，模型字段由用户填写。`BENCH_MEASURE_PERFORMANCE=1` 已启用；评分 Agent 配置完成后 submit 自动采集客观证据并调用两轮 DSH 评分，既有作答用 `bench review ... --measure` 追加修订。人工复核不覆盖历史。

PERF-02/03/04 有专用负载，其它题测完整验证成本并包含启动/断言开销。内部计时/RSS仅作诊断，外部阶段时间用于配对。性能比值和静态规则尚未发布校准，不能自动标正式成绩。

发布需真实正确/错误作答、固定容器噪声样本、裁判一致性和人工作答结果。没有这些证据时保持待校准。

## 模块与约束

| 位置 | 责任 |
| --- | --- |
| packages/contracts、core | 协议、50/50、等级与配对测量纯计算 |
| packages/catalog、tasks | 元数据、manifest、白名单导出、三向验证 |
| packages/runs、executor | 身份、快照、幂等、执行、回收、修订与报告 |
| packages/static、judge、evaluation | 静态事实、HTTP 裁判、证据组合与汇总 I/O |
| apps/cli、api、web | 操作入口和中文查询面板 |
| tasks/core、tasks/integration、graders | 对 AI 发布的题目包与受信验证资产 |

平台按单机单写者使用，不让多个 API/CLI 同时写同一个目录。容器中的隐藏检查仍可被候选读取；F#/Python 同进程检查与内部采样不能宣称防恶意篡改；本机候选拥有当前用户权限。哈希和标签不代替实际隔离。

非平凡变更在同批提交中附 [中文 Agent Note](notes/README.md)，写命令、结果和限制。未取得真实容器/裁判/校准证据，不把整个项目标为正式发布完成。