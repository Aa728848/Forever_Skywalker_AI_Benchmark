# Forever Skywalker AI Benchmark

基于真实全栈工程任务的 AI 开发能力评测平台：48 道核心题（12 域 × 4 级）及 7 道独立报告的来源仓库集成题；可用验证与代码质量各占 50%。

平台已实现导出独立工作区、完成提交、幂等冻结、受控执行、静态分析、性能配对、两轮独立模型评审、人工复核，以及中文报告与四级汇总。Windows开发验收和固定Linux容器验收均已完成：55题的参考/替代均50/50，缺陷均被检出。**题目包通过不等于正式发布**：真实模型评测仍暂停，裁判与难度/规则校准尚未完成。各题状态见 [题目目录](docs/task-catalog.md)。

接手先读 [交接执行文档](docs/handoff.md)。相关设计：[需求](docs/requirements.md)、[评分标准](docs/scoring.md)、[架构](docs/architecture.md)、[Linux 配置](docs/container-setup.md)、[来源与许可](docs/source-projects.md)。

第一次使用先看 [从启动到看报告](docs/quick-start.md)：说明 Docker、DSH 与网页分别何时启动，以及供应商 ID 和模型 ID 如何填写。

快速启动：Windows 双击根目录 `start.cmd`，或在终端运行 `pnpm start`。缺少 `.env` 或关键配置时，先引导补齐运行环境、DSH目录与裁判配置，令牌输入隐藏，确认后保存并立即生效。随后按阶段选择供应商、模型、DSH模式、思考等级、题目、预算和报告目录；最后可选择仅预检或实际测评，也支持导出/提交其他AI作答和启动网页。

本轮逐题审查55题，改善32题、澄清4题、保留19题，83个近似错误修复已有有效检出证据。加强了异步生命周期、持久事务与崩溃恢复、增量计算、多资源并发、插件回滚及真实性能负载，详见 [完整审查矩阵](docs/reviews/2026-09-14-full-task-quality-audit.md)。简单题继续承担基础门槛；实际模型区分度和难度标签仍须真实作答校准。裁判配置见 [供应商与思考参数](docs/judge-providers.md)。

## 启动

需要 Node 24.14.1、pnpm 11.24.0；F# 题需要 .NET SDK 10，Python 集成题需要 Python 3。浏览器题使用 BENCH_BROWSER_EXECUTABLE 或本机 Edge/Chromium。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

中文面板：`http://127.0.0.1:4317`，API：`http://127.0.0.1:4318`。面板可筛选题目、查看实际检查和时间线、下载证据、选择每题一次作答生成四级汇总。端口冲突不会接管其他服务。

## 提交与评分

在 DSH 中比较同一模型的思考等级，可用一个命令自动导出、作答、提交和生成对比报告：

```powershell
pnpm dsh:compare --model <你在DSH使用的模型ID>
```

默认标准预设、CACHE-02、Off/High 各一次，只用于检查流程。`--all` 选择全部55题；`--provider <供应商ID>` 与 `--model <模型ID>` 联合选择模型，同名模型可来自不同供应商。四预设统一思考等级可用 `--presets "standard,ptc,minimal,cordis" --reasoning high`；`--preset ptc` 选择一种，`--output <报告目录>` 指定报告位置。`--check` 仅预检，不调用模型。作答使用本机 DSH SDK，评分使用固定 Linux 容器；裁判另由 `.env` 的 `BENCH_JUDGE_*`（含思考等级）配置。报告和压缩证据保存校验后清理本次独占临时数据，详情见 [DSH 自动对比](docs/dsh-comparison.md)。

```powershell
pnpm bench list
pnpm task:export CACHE-02 data/submissions/cache-demo
# 让 AI 在导出目录中按照 TASK.md 完成修改
pnpm bench submit CACHE-02 data/submissions/cache-demo --key cache-demo-1 --reason agent-completed --measure
pnpm bench runs
pnpm bench status <runId> <attemptId>
pnpm bench report <runId> <attemptId> --format markdown
pnpm bench review <runId> <attemptId> --measure
pnpm bench summary <作答选择JSON>
pnpm bench judge-config
```

选择文件为 `[{"runId":"实际运行ID","attemptId":"实际作答ID"}]`。不自动挑最高分，不混合不同环境；缺测等级和完整核心总分保持 null，集成题单列。

复制 `.env.example` 为本项目 `.env`，填写自己的 BENCH_JUDGE_* 端点、模型、令牌及预算。CLI/API 自动采集静态分；`--measure` 或 `BENCH_MEASURE_PERFORMANCE=1` 启用两次预热、七轮参考/候选配对。自动评审进行两轮，分歧需复核；缺模型或性能证据不补分。`bench review --human <JSON>` 追加人工修订并保留原判决。令牌不进入候选环境或报告。

API 完成入口是 `POST /api/runs`，需配置 BENCH_SUBMISSIONS_DIR、BENCH_RUN_TOKEN，并发送 x-bench-token。CLI 直接拥有本机运行目录写权限；不要同时用多个平台进程写同一运行目录。

## 验证与环境

```powershell
pnpm task:verify CACHE-02
pnpm task:mutants API-04
pnpm task:mutants GRAPH-04
pnpm trial --all
pnpm score:rehearse
pnpm browsers:install
pnpm test:e2e
pnpm container:status
pnpm container:build
pnpm container:verify
pnpm container:trial --all --alternatives
```

`task:verify` 检查缺陷、参考和替代实现；`trial` 还要求参考获得完整 50/50 可用分。`score:rehearse` 使用脚本评审与示例性能分，只验证合成链路。真实本机结果为 local，未校准容器结果为 rehearsal，不能更换标签冒充正式成绩。

用户已重启，Docker/WSL及固定运行镜像已配置；项目.env已选择Linux档案。实际网络/资源/回收5项与性能采样链通过，见 [容器手册](docs/container-setup.md) 和 [Linux验收报告](docs/trials/2026-09-14-linux-container-validation.md)。运行阶段不下载镜像或回退为宿主运行。

## 维护

`catalog/tasks.json` 是元数据源，`pnpm catalog:docs` 生成文档。非平凡变更附中文 [Agent Note](docs/notes/README.md)。运行证据在忽略的 data/，Web 示例预览单独存 SQLite，二者不是同一种成绩。

来源仓库只读取材，集成题保留固定提交的模块副本、许可证及哈希；副本集成测试不代表七个原产品的完整测试已通过。
