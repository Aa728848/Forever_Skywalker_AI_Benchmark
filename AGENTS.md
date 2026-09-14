# 项目开发约定

本项目是 Forever Skywalker AI Benchmark。用户已确认的范围见 `docs/requirements.md`。

接手继续开发时先读 `docs/handoff.md`，按执行项及验收证据更新交接状态。

- 当前状态：55/55题具备完整资产，全部fixture-ready；用户重启后Docker/WSL与固定Linux镜像已配置。Windows与Linux的参考/替代均50/50，缺陷均准确检出；真实网络/资源/回收5项及PERF-04容器性能链通过。模型评测仍暂停，真实裁判与发布校准待验收，不得冒称正式成绩。
- 评分链路已端到端可用：受控执行 → 可用验证分（`scoreExecution`）；静态规则 → 三个客观维度（`@fsa/static`，阈值未校准）；评审适配器 → 评审分（`@fsa/judge`，凭据由 `BENCH_JUDGE_*` 配置）；`pnpm score:rehearse` 演示完整分数。缺证据的维度必须保持 `null`、总分待定，不得用假设分补齐。预览分数不是正式成绩。
- 裁判已支持8供应商的协议/推理参数，见 `docs/judge-providers.md`；参数指纹与实际返回模型必须保持两轮一致，不同裁判档案不混合汇总。用户暂不急跑实际模型，当前只做开发验收，不自动重启或调用真实裁判。
- API-04/GRAPH-04已升0.2.0并有近似错误修复集；涉及它们除三向外运行 `pnpm task:mutants <ID>`。目标检出项预声明，额外交叉断言失败原样保留；缺测/编译失败不得计为有效检出。难度仍待校准，见 `docs/task-quality-review.md`。
- 题目执行状态在 `catalog/tasks.json` 的 `status` 字段：`designed` → `fixture-ready` → `calibrating` → `ready`；没有题目包就不得标成 `fixture-ready`。
- 优先功能正确与最小改动，不改动七个来源仓库，不顺带重构。
- 协议在 `packages/contracts` 维护，评分核心不引入文件、网络或模型调用。
- 题目元数据在 `catalog/tasks.json` 维护，用 `pnpm catalog:docs` 生成目录；题目包结构见 `tasks/core/CACHE-02/`。
- 新增题目包用 `node scripts/newtask.ts <规格 JSON>` 生成：写出 task.md/manifest.json/starter/public-tests 与 graders 资产、生成参考补丁、跑三向验证，通过后才把状态推进为 `fixture-ready`。五个功能评分组均需真实检查；预声明缺陷检出项不得根据实跑结果反向改写。
- 编译/检查通过后收敛，回归测试只覆盖真实风险；不增加浅层覆盖率测试。
- 评分、协议或行为变动运行相关测试；交付前跑 `pnpm check`，涉及界面或 API 集成再跑 `pnpm test:e2e`；题目包改动跑 `pnpm task:verify <题目 ID>`（或 `node scripts/task.ts verify <ID>`）；试点回归跑 `pnpm trial`；评分链路回归跑 `pnpm score:rehearse`。
- 独立评审的模型、端点与预算由用户在环境变量里配置（`BENCH_JUDGE_ENDPOINT` / `BENCH_JUDGE_MODEL` / `BENCH_JUDGE_TOKEN` 及预算项）；未配置时评审必须拒绝工作并保持质量分待定，不得读取他人私有凭据。
- 临时测试数据使用系统临时目录并释放；执行产物放入已忽略的 `data/`。
- 容器环境和证据见docs/container-setup.md；执行器改动用pnpm container:verify验收实际边界，完整题库用pnpm container:trial --all --alternatives。当前镜像已固定，不要在每次评测前重建或替换它。
- 每次非平凡变更按 `docs/notes/README.md` 在同一变更中记录中文 Agent Note。
- 如果根目录存在 `.codegraph/`，代码定位优先 CodeGraph；否则使用 `rg`，不主动建立索引。
