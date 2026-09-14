# 来源项目与版本

初次调研日期：2026-09-14。以下保留初始化时读取的提交与定位；初次检查七个项目受跟踪文件无改动，未对未跟踪文件作完整性声明。本轮已制作并验证七个固定来源模块副本，**没有修改来源工作区，也没有执行七个原产品的完整测试**。Python来源的本地目录已不存在，按下述固定公开commit恢复，不能把初始化目录记录解释为当前仍存在。

## 冻结来源

| 项目 | 运行时 | 当前提交 | 可提炼能力 |
| --- | --- | --- | --- |
| cwtools-vscode | TypeScript + F# / .NET 10 | `753a0d7c2df1f4285911febf2d10a949887f4499` | LSP 增量文本、文档生命周期、读写锁与安全发布；Agent Notes 记录体系 |
| deepseek-harness | TypeScript / Node + 浏览器 + 原生组件 | `2377c272a8e839e0a84c9f0e623b867a1dce2014` | 长会话、续跑、流重连、独立 worker 性能和保留堆 |
| dsh-chatgpt-subscription | TypeScript + React | `464c98c2a506cdcc9768ef0b49731ba8aa429a90` | 认证刷新合并、注销竞争、流式参数解析和取消 |
| dsh-llm-verifier | TypeScript + DSH 插件 | `1a6b4151b8036203749e1b202b01395319a1578a` | 并发冷启动缓存、当前证据验收、重复与失效判决 |
| dsh-trading | TypeScript + React + 连接器 | `b6cf5535093cdc43fc61a7037d997bace7fb0e6d` | TTL/LRU、图统计规模增长、原子持久化、模拟账本 |
| dsh-web | TypeScript + Web/宿主插件 | `f499828c71b79a8968fba7226c93c76304239879` | 连接池和隧道生命周期、插件重复挂载和失败恢复 |
| llm-as-a-verifier | Python | `8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770` | 线程池、裁判输出解析、概率聚合、种子与跨语言差异 |

机器可读记录：`catalog/sources.json`。本机路径只用于取材定位，正式任务包不得依赖绝对路径或本机 node_modules。

## 调研证据

### cwtools-vscode

- 本机目录：`C:/Users/A/Documents/cwtools-vscode`。
- 仓库许可证标注：MIT。
- 观察：LSP 增量文本、文档生命周期、读写锁与安全发布；Agent Notes 记录体系。
- 定位：`src/LSP/DocumentStore.Tests.fsx`、`src/Main/RefreshLockIntegration.Tests.fsx`、`.agents/notes/README.md`。

### deepseek-harness

- 本机目录：`C:/Users/A/Documents/deepseek-harness`。
- 仓库许可证标注：MIT。
- 观察：长会话、续跑、流重连、独立 worker 性能和保留堆。
- 定位：`benchmarks/support/calibration.ts`、`benchmarks/active-stream-reconnect/README.zh.md`、`benchmarks/agent-continuation/agent-continuation.bench.ts`。

### dsh-chatgpt-subscription

- 本机目录：`C:/Users/A/Documents/dsh-chatgpt-subscription`。
- 仓库许可证标注：MIT。
- 观察：认证刷新合并、注销竞争、流式参数解析和取消。
- 定位：`test/oauth-service.test.ts`、`test/idle-watchdog.test.ts`、`test/responses-client.test.ts`。

### dsh-llm-verifier

- 本机目录：`C:/Users/A/Documents/dsh-llm-verifier`。
- 仓库许可证标注：MIT。
- 观察：并发冷启动缓存、当前证据验收、重复与失效判决。
- 定位：`src/cache.test.ts`、`src/auto.test.ts`、`src/parity.test.ts`。

### dsh-trading

- 本机目录：`C:/Users/A/Documents/dsh-trading`。
- 仓库许可证标注：PolyForm Noncommercial License 1.0.0（仓库 LICENSE 标注）。
- 观察：TTL/LRU、图统计规模增长、原子持久化、模拟账本。
- 定位：`packages/client-ui-trading/test/ttl-cache.test.ts`、`packages/knowledge/test/graph.test.ts`、`packages/dsh-home/test/fs-atomic.test.ts`。

### dsh-web

- 本机目录：`C:/Users/A/Documents/dsh-web`。
- 仓库许可证标注：Apache-2.0。
- 观察：连接池和隧道生命周期、插件重复挂载和失败恢复。
- 定位：`packages/dsh-ssh/src/engine.ts`、`packages/dsh-plugin-manager/tests/gateway-jobs.spec.ts`。

### llm-as-a-verifier

- 本机目录：`C:/Users/A/Documents/llm-as-a-verifier`。
- 仓库许可证标注：MIT。
- 观察：线程池、裁判输出解析、概率聚合、种子与跨语言差异。
- 定位：`llm_verifier/pivot_tournament.py`、`llm_verifier/fine_grained_reward.py`、`pyproject.toml`。

## 两个裁判实现的语义差异

`dsh-llm-verifier/src/parity.test.ts` 明确固定了两种聚合结果：对同一已给定 ring 和 reward 表，Python 上游将 ring 与完整 pivot pairs 累积，胜者为候选 3；TypeScript 变体对重叠无序边去重，胜者为候选 0。这是已声明的设计差异，不能当成同一实现的错误。

`dsh-llm-verifier/README.md` 还明确其解析失败、重复候选短路和温度策略是宿主策略；Python 默认的错误处理并不自动适合作为本项目合格门槛。题目必须在公开规格中选定语义，不允许由隐藏用例暗中选择其中一边。

## 复现与取材要求

发布题目时记录上游 commit、submodule commits、锁文件哈希、夹具来源、环境 image digest、操作系统档案、参考补丁摘要和目标缺陷。原仓库集成题使用独立副本，不在上述七个工作区原地执行改写任务。

平台与独立核心题采用独立实现；七个集成题已保留固定源模块、许可及哈希，不能统一标成 MIT。外部账号、真实凭据、真实订单和实时行情不作为可复现验收依赖，使用明确说明的合成数据与本地服务替身。

部分 CodeGraph 索引未覆盖相应文件，先尝试索引后通过 git show 读取固定commit。模块基线与三向验证已在Windows执行；Linux和发布校准仍待验证。

## 集成副本与许可位置

| 集成题 | 来源/依赖清单 | 许可 |
| --- | --- | --- |
| INT-CWT | tasks/integration/INT-CWT/PROVENANCE.json | cwtools MIT；固定 FSharp.Data 3.3.1 依赖 Apache-2.0 |
| INT-HARNESS | tasks/integration/INT-HARNESS/starter/SOURCE.json | MIT |
| INT-SUB | tasks/integration/INT-SUB/starter/SOURCE.json | subscription 与 vendored harness 各自 MIT |
| INT-VERIFIER | tasks/integration/INT-VERIFIER/source-provenance.json | MIT |
| INT-TRADING | tasks/integration/INT-TRADING/starter/SOURCE.json | 保留原 PolyForm Noncommercial 1.0.0 |
| INT-WEB | tasks/integration/INT-WEB/source-provenance.json | 根/SSH Apache-2.0；plugin-manager 单包 BSD-3-Clause；yaml 2.9.0 ISC |
| INT-PY | tasks/integration/INT-PY/starter/SOURCE.json | MIT；从公开仓库固定 8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770 恢复 |

缺陷注入文件会与原源码哈希不同，这种差异在各题清单、参考补丁及题面中明确记录。INT-TRADING/SUB 也保留了上游已有缺陷，未经修复的原基线会如实失败，不能为了显示绿色而改写历史。
