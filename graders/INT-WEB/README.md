# INT-WEB 受信集成资产

固定来源：dsh-web `f499828c71b79a8968fba7226c93c76304239879`。保留真实 plugin-manager client/HTTP/gateway/YAML/profile 链及 SSH routes/store/engine/pool/tunnel 链，许可证和文件哈希在题目包中。

- `checks/integration.hidden.test.mjs` 验证跨闭包单实例、连续 reconciliation、兄弟隧道真实监听回收、HTTP 错误后的 UI face 状态、无效配置原子性和 job 容量。
- `reference.patch` 恢复四个文件中的固定来源实现。
- `alternative/` 使用集合大小判定挂载所有权、显式遍历别名隧道等替代结构，同时保留原模块链。
- `public-tests/transport.mjs` 只替代外部 SSH/终端/React 渲染边界；真实 HTTP、YAML parser、文件操作和 localhost 隧道不替换。

YAML 2.9.0 与固定来源锁文件一致，dist 和 ISC 许可证离线复制，所有文件 SHA-256 在 `source-provenance.json`。plugin-manager 自身 BSD-3-Clause，SSH 及仓库根 Apache-2.0。

未经故障注入的原模块基线 12/12 通过，证据 `data/integration-baselines/INT-WEB/`。检查中的原断言移植自保留的上游回归源码；原仓库完整 React/宿主套件不属于本次通过声明。

执行：`node scripts/task.ts verify INT-WEB`。三向全过后才允许标记 `fixture-ready`，不把本机验证解释为发布校准或 Linux 隔离成绩。

2026-09-14验证版本升0.2.0：新增两个别名同时存在时的真实隧道归属检查，当前13项。目标别名全部关闭，其他别名的监听/池记录继续有效且可复用。固定来源与替代无需修改。`mutants.json` 的4个部分修复覆盖闭包局部所有权、只报错不回滚、跨别名过度回收、只释放首个兄弟隧道；三向6/6与反例4/4通过，详见 `mutation-review.md`。
