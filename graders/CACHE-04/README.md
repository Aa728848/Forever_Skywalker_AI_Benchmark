# CACHE-04 受信资产

来源：dsh-trading/packages/client-ui-trading/test/ttl-cache.test.ts、dsh-llm-verifier/src/cache.test.ts。

公开检查覆盖主要契约，隐藏检查改变输入规模、边界与交错；不引入题面之外的要求。参考与替代实现使用不同的数据组织或控制流程。

使用 node scripts/task.ts verify CACHE-04 运行缺陷、参考补丁与替代实现的公开/隐藏六阶段检查。受信资产不向候选导出。

0.2.0 增加同一队列中的多键事务、refresh 与 snapshot，以及 AtomicFileStorage 的真实文件同步/替换和进程中断检查。新增来源机制见 source-evidence.json。运行 `pnpm task:mutants CACHE-04` 验证三个近似错误修复；未预声明的交叉检出仍保留，不能把超时或缺测算检出。
