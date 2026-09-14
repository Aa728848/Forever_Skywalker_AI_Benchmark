# INT-VERIFIER 受信集成资产

本题来自 dsh-llm-verifier 固定提交 `1a6b4151b8036203749e1b202b01395319a1578a`。题目中保留 9 个真实源模块、MIT 许可证、原始回归源与逐文件 SHA-256；参考补丁只恢复 auto/engine/cache 中明确注入的回归。

- `checks/integration.hidden.test.mjs`：时效/跨会话、缺 criteria、模型与规则缓存身份、跨 engine 冷启动合并、失败恢复与真实磁盘容量。
- `reference.patch`：恢复冻结来源中的对应实现。
- `alternative/`：不同条件/键构造写法，仍运行完整来源模块链，验证检查没有固定某个源码文本。
- `public-tests/transport.mjs`（随题面提供）：只替换模型 caller 边界，明确无网络、无私有凭据。原 caller.ts 不执行，本题不声称验证真实模型 API。

固定来源未经故障注入时，本题 11 项 Node 集成验收全部通过，原始证据在 `data/integration-baselines/INT-VERIFIER/`。原始 Vitest 回归源被保留，选定断言移植到 Node；没有宣称原仓库完整测试通过。

执行 `node scripts/task.ts verify INT-VERIFIER`，三向验证全部通过后才允许推进 `fixture-ready`。集成题单独报告，正式成绩仍需要隔离、校准和独立质量评审。
