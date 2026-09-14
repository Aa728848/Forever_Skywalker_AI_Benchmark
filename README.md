# Forever Skywalker AI Benchmark

面向真实全栈工程任务的 AI 开发能力评测项目。采用简单、中等、困难、极度困难四级体系，可用验证与代码质量各占 50%。

**当前阶段：M1 已交付（容器内执行除外）。** 题库包含 48 道核心题、7 道原仓库集成题的设计目录，其中 8 道试点（FE-01、LSP-01、CACHE-02、BND-02、THR-03、GRAPH-03、CONC-04、PERF-04）已具备真实题目包、缺陷起始版本、公开与隐藏检查、参考补丁与替代实现，试跑 8/8 通过（见 [M1 试点试跑报告](docs/trials/2026-09-14-m1-pilot.md)）。提交、冻结、执行与状态查询链路可用；容器档案（固定镜像与 digest、`--network none`、CPU/内存/PID 限额、隐藏检查只读挂载）已经实现，但本机没有容器运行时，**尚未在真实容器里跑过**，当前实证结果全部来自宿主 `profile=local`（无隔离、无网络阻断）。代码质量评审（50 分）也未接入，因此**总分保持待定**；当前评分功能计算输入证据的预览分数，不代表系统已验证 AI 完成任务。

**开发接手入口：[开发交接与执行手册](docs/handoff.md)**，包含当前代码位置、M1 执行顺序、首个任务、验收标准和可直接交给 AI 的接手指令。

## 已确认方案

- [需求与范围](docs/requirements.md)
- [技术栈与架构](docs/architecture.md)
- [评分标准](docs/scoring.md)
- [完整题目目录](docs/task-catalog.md)
- [来源项目与版本](docs/source-projects.md)
- [执行记录机制](docs/execution-records.md)
- [开发阶段与验收](docs/roadmap.md)

## 本地运行

需要 Node.js 24 LTS 和 pnpm 11.24.0。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

中文面板：<http://127.0.0.1:4317>；API：<http://127.0.0.1:4318/api/health>。如端口被占用，开发服务会退出，不接管现有服务。

```powershell
pnpm bench list
pnpm bench show CACHE-01
pnpm bench score examples/assessment.json
pnpm bench score examples/assessment.json --format markdown
pnpm task:verify CACHE-02
pnpm task:export CACHE-02 <空目录>
pnpm trial
pnpm bench submit CACHE-02 <候选目录> --key <幂等键>
pnpm bench status <runId> <attemptId>
pnpm browsers:install
pnpm test:e2e
```

面板支持按难度、能力域、题型检索设计目录，并保存、查看显式标注的示例评分预览。运行数据保存在 `data/benchmark.sqlite`，不提交到 Git。命令行评分默认输出到终端。

浏览器首次安装运行 `pnpm browsers:install`，固定版本缓存位于 `.cache/playwright`。若显式设置 `PLAYWRIGHT_BROWSERS_PATH`，安装器与测试会使用同一自定义目录。SQLite 使用 Node 内置模块，在当前 Node 24 下会提示实验性 API，具体限制见架构文档。

## 开发约定

题目元数据以 `catalog/tasks.json` 为单一事实来源；`pnpm catalog:docs` 生成 Markdown 目录，`pnpm catalog:check` 检查二者一致性。评分规则变更必须同步版本与回归测试。非平凡变更按 [Agent Notes](docs/notes/README.md) 记录。

本项目独立实现初始化代码；原项目当前仅用于来源分析与题目设计，没有复制其业务代码。原仓库集成题必须在固定版本的隔离副本中运行。
