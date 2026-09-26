# Agent Note: 实验报告的 API 只读出口

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

## Alternatives considered
- **用裸目录名寻址**：会被路径穿越与跨报告根访问直接命中，且把磁盘布局暴露给前端；改用不透明 `reportId`。
- **损坏报告从列表里跳过**：等于把"报告丢了"伪装成"报告不存在"，故障不可见；改为 `unreadable` + `error` 保留在列表里。
- **只校验实验目录、不校验产物文件**：目录内单个产物仍可是指向根外的链接；逐个产物独立校验。
- **给 `experiment.json` 也做 `evidence.sha256` 比对**：`evidence.sha256` 是压缩证据包的哈希，永远不等于 `experiment.json` 自己的字节，照做会让 `experiment.json` 在任何报告上都 404。因此只核对证据包；`experiment.json` 一旦被改动，会先表现为 `unreadable` 或字段不符，而不是被当成有效报告下载。
- **让 `openReports` 自己写快照或缓存**：报告根类路由保持只读是设计要求；`reports.ts` 与三条路由都不含任何写文件的调用。
- **前端把 `launch.log` 按钮藏起来**：那会让「这一版不产出启动日志」这件事从界面上消失，使用者只会以为功能没做。改为四个按钮都渲染，`log` 的说明与 404 提示写在按钮下方。
- **前端固定每 5 秒重取明细**：会把正在阅读的表格每 5 秒重建一次（滚动与展开状态丢失）。改为只在列表存在进行中实验时轮询，且同一报告不重复取明细。
- **明细失败时清空整个页面**：一次读取失败不该让其余实验不可用。改为按 `reportId` 记录失败原因，右栏局部展示。

## Consequences
历史与后续实验都能在 API 与网页侧列出、读明细、下载产物，且不需要令牌。约束：本阶段只做单报告根；`launch.log` 保留标识但明确返回「不适用」；进度最多 500 条，超出丢弃最旧的。`experiment.json` 未登记 `evidence.sha256` 时，压缩证据因缺少可核对依据而拒绝下载。

损坏报告在网页上「可见但不可读」：它留在列表里并写明原因，不会被筛选静默丢掉，也不会让页面其余部分失效。

## Verification
- `pnpm exec vitest run apps/api packages/evaluation packages/contracts`：8 个测试文件、66 项通过（`apps/api/src/reports.test.ts` 9 项）。
- `pnpm exec tsc --noEmit`：模块级验证时本模块改动无新增错误。
- 整轮合入后 `pnpm check`：332 项测试通过（27 个测试文件）、`tsc --noEmit` 通过、目录一致、生产构建成功；`pnpm test:e2e` 7 项通过，其中 `tests/e2e/report-center.spec.ts` 2 项。
- `tests/e2e/report-center.spec.ts` 用真实 API 与浏览器覆盖前端：列表列出实验并带状态、明细展示行级阶段与进度时间线、四个产物入口可见（`launch.log` 提示 404）、`evidence.json.gz` 的摘要前缀与文件数、下载 `report` 得到 Markdown 正文、损坏报告刷新后仍以 `不可读` 出现并写明「不是有效 JSON」、`已完成` 与 `进行中` 筛选各自只留对应记录、搜索只按关键词命中而不改变损坏报告的可见性。
- 覆盖场景：空目录、报告根不存在、损坏 JSON、`0.2.0` 兼容、`progress` 超 500 条、投影字段越界、伪造/跨根 `reportId`、目录名穿越、URL 层穿越、实验目录符号链接/junction、产物符号链接逃逸、校验和不符、未登记摘要、`launch.log` 不适用、GET 前后 `experiment.json` 字节与 mtime 不变。
