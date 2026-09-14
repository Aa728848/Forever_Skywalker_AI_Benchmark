# INT-VERIFIER · 自动验收证据时效与重入控制

- 原仓库集成题，极度困难，版本 0.1.0。独立报告，不计入 48 道核心题分数。
- 来源：dsh-llm-verifier，冻结提交 `1a6b4151b8036203749e1b202b01395319a1578a`，MIT。逐文件原始 SHA-256、变更后的 starter SHA-256 及来源路径见 `source-provenance.json`，许可证见 `LICENSE`。

## 任务

本题保留真实 `engine → core/cache`、`auto → router/session/core` 与 `replay → auto/core` 跨模块链。起始副本注入了四类回归：旧验收未失效、缺失 criteria 被接受、模型/prompt 缓存身份丢失，以及跨 engine 的 single-flight 失效。修复这些回归，保留原仓库公共导出、缓存文档格式和调用成本语义。

可修改范围只有 `starter/upstream/src/auto.ts`、`engine.ts`、`cache.ts`。其他来源文件和公开检查用于兼容验证，不得删减链路或用另一个简化评分器替代原模块。

## 必须满足的跨模块行为

1. `analyzeAutoTask` 只接受当前 session、覆盖当前任务起点及全部已完成重要工作、具有完整且达标 criteria 的验收。验收之后的新编辑和**失败但已经写入的工作**都使旧验收失效。
2. 完成的 `verifier_current_session` 自身不算业务工具，也不构成递归验收工作。完整当前验收关闭门禁；缺项、解析失败、低分或其他 session 的结果不能关闭门禁。
3. 真实 `VerifierEngine.compare` 构造的缓存身份必须覆盖模型、当前完整 prompt（包括候选快照、验收准则和规则上下文）、评分通道及原有版本信息。同 key 可复用；变化后的模型、规则或快照必须重新调用传输。
4. 同 topic 的多个 engine、不同冷缓存实例共享 `SingleFlight` 时，同一请求只进行一次实际传输。重复加入者不重复记成本；失败的 flight 可以重试，不缓存 rejected Promise。
5. 裁判响应不可解析时必须失败，已经返回的用量仍写入 `partialStats`，不得回落为默认通过或伪造零调用。
6. `replay.sweepThresholds` 与实时门禁使用同一每项验收阈值；缓存格式保持 `version:1`，真实磁盘文件不得超过配置的 `maxEntries`。

## 执行环境与边界

Node 24.14.1，固定命令：

```text
node --experimental-transform-types --test --test-reporter=tap "public-tests/**/*.test.mjs"
```

原模块包含 TypeScript 参数属性，必须使用这里声明的原生 transform 模式；不得为了运行将原模块改写为测试专用算法。题目包不需要 npm 安装。

只有原 `caller.ts` 的外部模型/宿主传输边界由 `public-tests/transport.mjs` 明确替换：它提供确定性的响应、失败、屏障和用量。本题**不验证真实模型 API 或订阅**，不读取账户、密钥、原仓库配置，也不发起网络。其余 engine/cache/core/auto/router/session/replay 全部运行保留的真实模块。原 caller/top-logprobs 源码留存用于协议检查，不在本题中发起调用。

原始回归源码完整保留在 `upstream-tests/`（`.txt` 文件内容与冻结提交一致）。公开/隐藏 Node 检查移植了本次链路所需的原断言，新增跨模块交错与故障注入；这里的通过不代表原仓库全部 Vitest/宿主套件均通过。

## 评分证据

业务、边界、状态、回归和基本资源五组均有独立真实检查。缺陷 starter 必须只被预声明的七个检测项拦住，固定原模块参考修复和结构不同的替代修复都必须通过。功能检查与人工可维护性、简洁度、解耦性、性能的质量评审分别计分；缺少质量证据时总分待定。
