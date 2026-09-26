# Agent Note: 实验报告的 API 出口（读取与清理）

Status: implemented

## Problem
自动测评此前只能通过 `pnpm dsh:compare` 运行，产物落在 `BENCH_DSH_REPORT_DIR/<时间戳>-<随机ID>/`（`report.md`、`experiment.json`、`evidence.json.gz`）。API 与网页完全看不到这些报告：`data/experiments` 里的历史实验只能靠文件系统访问，无法在平台上列出、查阅或下载证据。

## Decision
新增协议与只读出口，不改动 CLI 的落盘语义：

- `packages/contracts` 新增 `ProgressEntrySchema`、`ExperimentPhaseCountsSchema`、`ExperimentRowSchema`、`ExperimentSummarySchema`、`ExperimentDetailSchema`、`ExperimentListSchema` 与对应 Validator，全部 `additionalProperties: false`。`status` 允许 `unreadable` 并配 `error`：损坏的 `experiment.json` 必须仍出现在列表里并写明原因，不允许被静默跳过。
- `apps/api/src/reports.ts` 提供 `openReports({ root })`：扫描报告根下一层目录，每个目录读并校验 `experiment.json`；兼容 `0.2.0`（无 `progress`，视为空数组）与 `0.3.0`；报告根不存在时返回空列表。
- 寻址用不透明 `reportId = base64url(JSON.stringify([rootKey, directoryName]))`，`rootKey` 是报告根的 `realpath`；解码后 `rootKey` 不等于当前报告根即 404。详情、原文与下载一律不用裸目录名。
- 逐产物安全：对每个产物文件单独 `lstatSync` 拒绝符号链接，再 `realpathSync` 确认 `relative(实验目录, real) === 文件名`；任一步失败即 404。只校验目录不够——目录内的 `report.md` 可以是指向根外的符号链接。
- `apps/api/src/app.ts` 挂载 `GET /api/reports`、`GET /api/reports/:reportId`（unreadable 返回 422 + 原因）、`GET /api/reports/:reportId/artifacts/:artifactId`。产物标识清单是四条 `reportArtifactIds = ['report', 'experiment', 'evidence', 'log']`（`reports.ts` 与前端 `ReportCenter.tsx` 共用同一组标识），但 `log` 指向的 `launch.log` 不属于比较入口的产物：请求它一律 404 并说明「不适用」，前端把这个说明写在按钮下方而不是隐藏按钮。报告根来自 `process.env.BENCH_DSH_REPORT_DIR`，缺省 `<仓库根>/data/experiments`，可经 `AppOptions.reportsRoot` 注入；`apps/api/src/app.ts` 的 `reports()` 按操作读取当前配置，保存新的 `BENCH_DSH_REPORT_DIR` 后无需重启 API。
- `packages/evaluation/src/dsh-comparison.ts` 两处改动：`DshComparisonReport` 增加 `progress`（`schemaVersion` 升到 `0.3.0`），在 `services.onProgress` 处同步落盘并只保留最近 500 条；`report.md` 改为先写 `.tmp` 再 `renameSync`，与 `experiment.json` 相同的原子替换模式。

`apps/web/src/ReportCenter.tsx` 是报告中心页签的前端实现：列表默认选中第一条并立即取明细；只有列表里存在 `state === 'running'` 的实验时才每 5 秒轮询，且同一报告不重复取明细——否则轮询会不断重建正在阅读的表格。搜索命中实验 id / 报告目录名 / 供应商 / 模型 / 预设 / 思考等级；筛选为「全部 / 进行中 / 已完成 / 失败 / 不可读」。明细页展示行级阶段徽标、阶段统计、进度日志时间线、清理状态、取证问题与页面自行推导的一致性提示（跨题目版本、重复组合），并提供四个产物下载入口。

损坏报告的可见性由前端如实延续：`unreadable` 的实验仍留在列表里，带 `broken` 样式与 `error` 原因，「不可读」筛选专列它们；选中后右栏显示服务端 422 给出的原因，明细失败按 `reportId` 记录，因此切换选择时旧的失败原因不会串到另一份报告上；页面其余部分照常可用。

下载文件名固定 `<experimentId>-<artifactId>.<ext>`，响应带 `content-disposition`。`experiment.json` / `evidence.json.gz` 用 `experiment.json` 内登记的 `evidence.sha256` 与实读内容比对，不符即拒绝下载。

清理（2026-09-26 增加）：`DELETE /api/reports/:reportId`、`DELETE /api/runs/:runId/:attemptId`、`DELETE /api/experiments/:launchId`，三处都需要 `x-bench-token`，行为统一为「移入该根目录下的 `.trash`」。

- 共享实现是 `apps/api/src/cleanup.ts` 的 `moveToTrash({ root, paths, reason })`：只用 `renameSync`，因此既不跟随链接也不递归删除。移动前必须逐条通过四道护栏：相对路径规范（非空、非绝对、无 `..`/`.`/`*` 等）、目标存在、`lstat` 不是符号链接或 junction、`realpath` 仍落在真实根目录之内。任何一条不过就**整笔拒绝**，且在移动任何东西之前报错。
- 拒绝链接是刻意的：把 junction 移进回收目录虽然只移动链接本身，但之后任何人「清空回收目录」时的递归删除会穿过它抹掉链接指向的真实目录。不收，避免把风险存进回收站。
- 回收目录内保留原有的相对结构（例如 `runs/<题>/<运行>/<尝试>`），因此「哪个文件原来在哪」始终可从路径读出；重名条目加 `~N` 后缀并存，不覆盖上一份。
- 三个列表扫描都会跳过 `.trash`：`reports.ts` 的 `scan()`、`launches.ts` 的 `listIds()`、以及运行记录的索引自愈（见下）。否则清理过的条目会以「已清理」重新出现。
- **运行记录必须同时丢弃索引条目**：`listRunStatuses` 先读 `index.json` 再逐个读目录，若留着指向已移走目录的条目，`readJson` 会抛错导致**整个运行记录列表打不开**；幂等键也会仍被认为「已用过」。因此新增 `RunStore.forgetMissing()`，在清理后丢弃目录已不存在的条目。
- 清 launch 记录时会一并移走同名 `.json`/`.exit.json`/`.log`/`.cancel-requested`，避免列表里留下孤立文件；**未落定**（进行中或状态未知）的记录拒绝清理——账本是对账依据，移走会让 sweeper 失去依据、进程失管。
- 正在执行的 run（`active` 中有条目）同样拒绝清理。
- 前端三处（报告中心、运行记录、启动记录）统一为两步确认 + 令牌输入；结论提示渲染在**列表之外**：被清理的条目会立刻从列表消失、明细区随之换成空状态，把结论放进明细区用户就永远看不到自己刚做的事成功了没有。

## Alternatives considered
- **用裸目录名寻址**：会被路径穿越与跨报告根访问直接命中，且把磁盘布局暴露给前端；改用不透明 `reportId`。
- **损坏报告从列表里跳过**：等于把"报告丢了"伪装成"报告不存在"，故障不可见；改为 `unreadable` + `error` 保留在列表里。
- **只校验实验目录、不校验产物文件**：目录内单个产物仍可是指向根外的链接；逐个产物独立校验。
- **给 `experiment.json` 也做 `evidence.sha256` 比对**：`evidence.sha256` 是压缩证据包的哈希，永远不等于 `experiment.json` 自己的字节，照做会让 `experiment.json` 在任何报告上都 404。因此只核对证据包；`experiment.json` 一旦被改动，会先表现为 `unreadable` 或字段不符，而不是被当成有效报告下载。
- **让 `openReports` 自己写快照或缓存**：读路径保持只读是设计要求；`list`/`detail`/`artifact` 与三条 GET 路由仍不含任何写文件的调用。清理是**独立**的 `clean()` + `DELETE`，不复用读路径。
- **直接删除报告目录**：报告目录是评测证据（`experiment.json`、`evidence.json.gz`、逐条作答记录），删掉不可恢复。改为移入报告根下的 `.trash`，可手动移回。
- **用 `rmSync(recursive:true)` 实现清理**：仓库明令禁止递归删除（会穿过 junction 抹掉链接指向的真实目录）。清理只用 `renameSync`，它既不跟随链接也不递归删除；收尾的空目录用 `rmdirSync`（拒绝删除非空目录，结构上不可能删掉内容）。
- **前端把 `launch.log` 按钮藏起来**：那会让「这一版不产出启动日志」这件事从界面上消失，使用者只会以为功能没做。改为四个按钮都渲染，`log` 的说明与 404 提示写在按钮下方。
- **前端固定每 5 秒重取明细**：会把正在阅读的表格每 5 秒重建一次（滚动与展开状态丢失）。改为只在列表存在进行中实验时轮询，且同一报告不重复取明细。
- **明细失败时清空整个页面**：一次读取失败不该让其余实验不可用。改为按 `reportId` 记录失败原因，右栏局部展示。

## Consequences
历史与后续实验都能在 API 与网页侧列出、读明细、下载产物，且不需要令牌；清理是唯一需要令牌的写操作，三处界面统一为两步确认。约束：本阶段只做单报告根；`launch.log` 保留标识但明确返回「不适用」；进度最多 500 条，超出丢弃最旧的。`experiment.json` 未登记 `evidence.sha256` 时，压缩证据因缺少可核对依据而拒绝下载。

损坏报告在网页上「可见但不可读」：它留在列表里并写明原因，不会被筛选静默丢掉，也不会让页面其余部分失效。

清理**不删除任何字节**，只把条目移进对应根目录下的 `.trash`，用户可手动移回；界面与接口的措辞都是「移入回收目录」而不是「删除」。`.trash` 不被任何列表扫描，因此不需要额外的忽略规则。回收目录会一直累积，清空它属于用户的手工操作。

## Verification
- 清理的护栏与语义：`apps/api/src/cleanup.test.ts` 6 项通过——内容完整保留在回收目录、嵌套路径保留原结构、拒绝绝对路径与 `..`、拒绝符号链接/junction（且链接指向的真实目录完好）、找不到报 404、同名不覆盖。**反向验证**：去掉 `lstat` 的符号链接判断后该用例失败，说明这条护栏是承重的而不是摆设。
- 清理路由实测（真实 Fastify 实例、`app.inject`）：无令牌 401、有令牌 200 并返回 `trashPath`/`moved`、清理后列表不再列出、原目录消失、`experiment.json` 仍在回收目录里、重复清理报 404。
- `pnpm exec vitest run apps/api packages/evaluation packages/contracts`：8 个测试文件、66 项通过（`apps/api/src/reports.test.ts` 9 项）。
- `pnpm exec tsc --noEmit`：模块级验证时本模块改动无新增错误。
- 整轮合入后 `pnpm check`：**364 项**测试通过（**28** 个测试文件）、`tsc --noEmit` 通过、目录一致、生产构建成功；`pnpm test:e2e` **9 项**通过，其中 `tests/e2e/report-center.spec.ts` 2 项、`tests/e2e/report-cleanup.spec.ts` 2 项（真实浏览器覆盖两步确认、令牌校验、清理后列表消失、文件确实进了回收目录、缺令牌被拒且报告留在原处）。
- `tests/e2e/report-center.spec.ts` 用真实 API 与浏览器覆盖前端：列表列出实验并带状态、明细展示行级阶段与进度时间线、四个产物入口可见（`launch.log` 提示 404）、`evidence.json.gz` 的摘要前缀与文件数、下载 `report` 得到 Markdown 正文、损坏报告刷新后仍以 `不可读` 出现并写明「不是有效 JSON」、`已完成` 与 `进行中` 筛选各自只留对应记录、搜索只按关键词命中而不改变损坏报告的可见性。
- 覆盖场景：空目录、报告根不存在、损坏 JSON、`0.2.0` 兼容、`progress` 超 500 条、投影字段越界、伪造/跨根 `reportId`、目录名穿越、URL 层穿越、实验目录符号链接/junction、产物符号链接逃逸、校验和不符、未登记摘要、`launch.log` 不适用、GET 前后 `experiment.json` 字节与 mtime 不变。
