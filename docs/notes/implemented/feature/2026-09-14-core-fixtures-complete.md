# Agent Note: 补齐四十八道核心题并修复参考解与线程验证缺陷

Status: implemented

## Problem

接手时实际已有 38 道核心题目包，交接数字仍为 16。缺少 10 道核心题；API-04 的参考与替代实现在重启后为不同键复用 task-1，THR-01 仅采信候选自报线程 ID，且参考实现超出线程总数契约。生成器失败回滚会删除同 ID 的已有资产。

## Decision

- 补齐 FE-03、FE-04、LSP-02、LSP-03、LSP-04、CACHE-04、BND-04、THR-02、THR-04、PERF-03，每题均有明确接口、缺陷 starter、公开/隐藏检查、参考补丁与替代实现，三向验证通过后标记 fixture-ready。
- LSP 三题使用 F# / .NET，验证 UTF-16 编辑、真实取消令牌、并行增量索引和原子发布。线程两题实际运行 Node worker，使用共享内存屏障构造旧代晚完成，并观察线程创建、消息和退出。
- FE 两题使用真实 Chromium/Edge DOM，检查节点身份、键盘重试、滚动、工作区隔离、重连接续及 100000 增量后的 DOM 与保留堆预算。受信浏览器支撑位于 graders/shared/browser.ts，独立题目包持有可导出的公开副本，不依赖宿主 node_modules。
- CACHE-04 使用真实临时文件和故障注入验证冷启动合并、分域缓存与写失败；BND-04 验证预算先于 JSON 物化和 20000 层输入；PERF-03 使用稀疏/密集输入、访问计数及同机配对规模测量。
- API-04、THR-01 升至 0.1.1，新增实证回归并修正两个正确对照。THR-01 固定 worker 支持批次，参考/替代不超过线程总数且返回前等待退出。
- newtask.ts 在任何写入前拒绝既有题目/受信目录，回滚前校验绝对路径范围，支持 --no-docs 供串行维护元数据后统一生成目录；新 Node 检查使用进程隔离测试模式。

## Alternatives considered

未采用模拟 DOM、自报 threadIds、用 Promise 冒充线程或将占位题直接标为 ready。浏览器支撑选择 Node 内置类型剥离加 Chromium headless，避免为每个候选任务安装额外依赖。原始七个来源工作区始终只读。

## Consequences

核心题现在为 48/48 fixture-ready。该状态仅证明真实资产和开发环境三向验证，不能替代正式 Linux 容器验证、跨模型难度校准或独立裁判凭据配置。浏览器可用 BENCH_BROWSER_EXECUTABLE 指定；Windows 当前用已安装 Edge，正式镜像需包含 Chromium。性能阈值为公开的开发预算，尚不能声称正式校准完成。

## Verification

- 上述新增 10 题逐题执行 node scripts/task.ts verify，全部六阶段通过，缺陷检测项与 manifest 一致，参考和替代实现全部通过，隐藏资产未导出。原始结果保存于已忽略的 data/task-runs/<ID>/。
- API-04 与 THR-01 修复后完整三向验证通过。
- 对生成器执行既有 API-04 创建尝试，确认非零拒绝，manifest 和 reference.patch 的 SHA-256 摘要未变。
- pnpm typecheck 通过；完整平台回归由主代理在合并本次并行修改后统一执行。
- FE-04 的参考与替代均在真实 Edge 中通过 100000 增量、最大 100 行和 GC 后 32 MiB 增长预算检查。

同次评分链审计随后发现，新增题的检查虽可执行，但部分评分组为空，导致可用分仍为 null。已将上述十题升至 0.1.1：按实际断言归组，并补上 FE-04 非法预算、LSP-02 50000 行编辑的时间/分配预算、BND-04 拒绝后的解析状态隔离、PERF-03 输入变更后的索引新鲜性。十题均再次完成六阶段验证，behavior/boundary/state/regression/resources 五组全部有真实检查。新的原始记录位于 data/task-runs/ 对应 2026-09-14T10-04-* 运行。
