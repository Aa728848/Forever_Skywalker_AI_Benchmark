# Agent Note: 作答阶段的资产保密边界

Status: implemented

## Problem
评测的公平性依赖作答模型看不到参考答案与隐藏检查。此前 `docs/dsh-comparison.md` 写「建议评测模型使用 `workspace-write`，避免暴露评测仓库中的隐藏检查和参考答案」，这句话声称的防线并不存在。

## Facts
- **题目投递是白名单导出**：`exportWorkspace` 只复制 `manifest.json` 的 `workspace.entries`，未列出的资产一律不复制（`tasks/core/CACHE-02/manifest.json` 的四件套是 `TASK.md`、`package.json`、`starter/`、`public-tests/`）。题面里没有 `__checks__`、`graders/`、隐藏检查 ID 或可运行的隐藏命令。
- **DSH 三档权限都只限制写入**：`@deepseek-ai/dsh-fs-sandbox` 按会话沙箱模式限制文件的写入与编辑，同时保留本地文件系统的读取行为。因此 `read-only`、`workspace-write`、`danger-full-access` 都不能阻止作答进程读取工作区之外的文件。
- **作答阶段运行在宿主上**：候选工作区是实验临时根下的 `workspaces/<sessionId>`，`graders/<ID>/` 与之同机可达。bash 路径另有 DSH 的进程级隔离后端，但 Windows 上的 ACL 受限令牌档自身报告 `partial`，已知缺口包含「读取不受限」。
- **评分阶段不同**：容器档案把隐藏检查只读挂载在 `/work/__checks__`，且只在验证时挂载；被测对象此时已是冻结快照。
- **导给外部编程 AI 的路径天然隔离**：导出目标在仓库外，`exportWorkspace` 拒绝仓库根、仓库上级与题目包内路径，外部作答方沿 Git 父目录摸不到 `graders/`。

## Decision
- 作答阶段的保密边界是**提示词条款，不是技术隔离**。`comparisonPrompt` 明确声明：仅在当前工作区内进行，可运行构建与测试所需的外部程序（node、dotnet、浏览器等），但不得访问或检索本评测项目的任何资产（含工作区之外的参考答案、隐藏检查、评分脚本与本项目仓库），也不得联网检索本评测项目或其来源仓库。
- 措辞不写成「不得访问工作区外文件」：该措辞会同时禁止读取 node 运行时、启动浏览器与执行 `dotnet fsi`，F# 与浏览器题会失败。
- `docs/dsh-comparison.md` 如实标注三档权限只限制写入，评分阶段的容器隔离另行说明，不再把提示词约束描述成技术隔离。
- 本次没有删除 DSH 预设的 `tool-web`：标准、PTC、创造三个预设都带该工具，剔除后测的就不再是原版预设。联网能力保留，是否收紧由预设保真决定。
- 本次没有改动 `BENCH_DSH_WORKSPACE_PERMISSION`：默认 `workspace-write` 仍更合适（可阻止候选改写评测仓库），且 F# 题在受限权限下的运行行为未实测过。改回默认值会触及 5 道 F# 题的 `dotnet fsi` 首次运行缓存写入。

## Verification
- 未调用真实作答模型或裁判；边界结论依据固定 DSH 源码 `@deepseek-ai/dsh-fs-sandbox` 与 `@deepseek-ai/dsh-sandbox` 的公开说明。
- 55 份 `task.md` 全文扫描确认没有隐藏资产路径、检查 ID 或隐藏测试名。
