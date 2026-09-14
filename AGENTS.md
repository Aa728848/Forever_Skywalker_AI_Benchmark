# 项目开发约定

本项目是 Forever Skywalker AI Benchmark。用户已确认的范围见 `docs/requirements.md`。

接手继续开发时先读 `docs/handoff.md`，按执行项及验收证据更新交接状态。

- 当前阶段：M1 已交付（容器内实跑待容器运行时）。48 道核心题中 8 道已有真实题目包与受信资产，其余 47 道仍是设计规格；预览分数不是正式成绩。
- 题目执行状态在 `catalog/tasks.json` 的 `status` 字段：`designed` → `fixture-ready` → `calibrating` → `ready`；没有题目包就不得标成 `fixture-ready`。
- 优先功能正确与最小改动，不改动七个来源仓库，不顺带重构。
- 协议在 `packages/contracts` 维护，评分核心不引入文件、网络或模型调用。
- 题目元数据在 `catalog/tasks.json` 维护，用 `pnpm catalog:docs` 生成目录；题目包结构见 `tasks/core/CACHE-02/`。
- 编译/检查通过后收敛，回归测试只覆盖真实风险；不增加浅层覆盖率测试。
- 评分、协议或行为变动运行相关测试；交付前跑 `pnpm check`，涉及界面或 API 集成再跑 `pnpm test:e2e`；题目包改动跑 `pnpm task:verify <题目 ID>`；试点回归跑 `pnpm trial`。
- 临时测试数据使用系统临时目录并释放；执行产物放入已忽略的 `data/`。
- 每次非平凡变更按 `docs/notes/README.md` 在同一变更中记录中文 Agent Note。
- 如果根目录存在 `.codegraph/`，代码定位优先 CodeGraph；否则使用 `rg`，不主动建立索引。

