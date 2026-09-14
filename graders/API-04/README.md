# API-04 0.2.0 · 受信资产与单题质量审查

## 为什么替换原题

0.1.2 的“极度困难”实际是一个内存 TaskStore 和不到 70 行的提交器：所谓重启只是重新构造对象，事务失败是 Map 写入之前抛错，参考补丁只需加入读取去重和稳定 ID。它能验证基础幂等回归，但没有足够证据支撑极难标签。

0.2.0 保留该旧接口作为回归，主任务变为真实 SQLite 文件上的提交、领取、执行、完成和恢复协议。没有按题目数充数；原 ID 版本升级，使旧成绩不能与新题混算。

## 固定来源与可追溯范围

来源仓库只读，使用 git show 读取固定提交，未把当前工作区变更混入来源。完整 Git blob 与 SHA-256 在 [source-evidence.json](source-evidence.json)。

| 来源 | 固定提交 | 实际路径与观察 | 本题提炼 |
| --- | --- | --- | --- |
| deepseek-harness | 2377c272a8e839e0a84c9f0e623b867a1dce2014 | packages/session/session-persistence-jsonl/src/lease.ts，SessionWriteLease.acquire/release | 所有权必须在真实进程间成立，进程退出后的接管不能依赖内存对象 |
| deepseek-harness | 同上 | packages/session/session-persistence-jsonl/src/generation.ts，writeSyncedTemp / publishCurrentExclusive / publishPreparedMigration | 准备、物理发布、确认之间分别注入中断；发布后确认丢失与发布前失败不同 |
| deepseek-harness | 同上 | packages/util/atomic-write/src/index.ts，withFileLock / writeFileAtomic | 本地 Promise 串行不足以保护其它进程，文件读改写有明确提交边界 |
| dsh-trading | b6cf5535093cdc43fc61a7037d997bace7fb0e6d | packages/client-ui-trading/src/tasks/ledger.ts，commit（366）、apply（408）、openRun（492）、reconcileStartup（586） | 请求内容指纹、提交后可见性、执行记录与重启处置共同作用 |

trading 固定提交的 commit 中可直接看到内存 document 在文件替换前赋值的次序；本题据此把“内存已变化、文件未提交”的可观察性纳入故障契约。未在来源仓库运行故障注入，因此不把本题验证结果描述为原仓库缺陷复现。harness 的所有权是生命周期内核锁，本题的可过期 worker 租约是新增综合条件，不声称原模块实现了相同过期协议。

这里只提炼场景并独立编写代码，没有复制这些来源模块；dsh-trading 的 PolyForm Noncommercial 许可没有被替换为 MIT，也没有把原模块作为本题发布内容。不是完整来源仓库集成题。

## 难度来自相互作用的不变量

1. **身份 × 持久提交 × 确认丢失**：同键同内容只提交一次；不同内容拒绝；提交中断必须回滚；已提交的确认丢失必须重放既有结果。
2. **跨进程领取 × 到期接管 × 代际授权**：两个进程只能确认一个当前领取，旧 worker 名称与新 worker 相同也不能覆盖新结果。
3. **外部执行 × 事务结果 × 生命周期**：外部工作允许再次执行，只有当前代际结果能够进入账本；真实进程退出不能恢复出孤立结果。
4. **状态快照 × 修订 × 资源**：同一动作的状态、结果和修订一起可见，重放不增长历史。

候选包含 5 个源码模块；参考修复跨 queue/storage 两个模块。旧接口已修好保留为兼容回归，公开题面描述事故症状和行为约束，没有“缺陷在第几行/请把某个条件改成什么”的答案提示。

## 验证资产

- 26 个声明检查，五个功能组齐全；其中 14 个针对新增持久协议，12 个保留旧接口回归。
- 三个进程中断检查在指定语义屏障调用 process.exit(86)，不执行 queue.close；父进程验证退出码并重新打开同一个实际 SQLite 文件。覆盖提交、领取、结果暂存。它们是进程退出恢复，不是断电/硬件损坏模拟。
- 已提交后的确认丢失检查覆盖提交和完成两种动作。
- 两进程领取使用标准输入/输出屏障固定交错；SQLite busy 是明确允许的可重试结果；测试不要求特定表结构或特定锁实现。
- 异步执行用显式 Promise 屏障实现旧执行迟到，不使用等待若干毫秒制造竞态。
- 状态机用固定 seed 0x51a7、120 个动作与独立内存预言机，穿插数据库关闭/重开；不依赖概率性负载规模。
- 参考实现：关系表 + 业务事务。替代实现：SQLite 单行 JSON 文档 + 内存状态变换 + 原子发布。替代实现不使用 reference 的 storage 模块，证明检查不绑定某个表结构。
- `mutants.json` 中 3 个近似错误修复分别漏掉内容绑定、代际校验、跨 SQL 原子性，应用到已正确的 reference，避免仅证明起始桩代码会失败。

## 复现

```powershell
node scripts/task.ts verify API-04
node scripts/mutants.ts API-04
```

预声明 starter 10 项失败，其它检查必须通过；reference 和 alternative 全部通过。变异预声明项必须被真实断言检出；额外失败原样记录，缺失检查/编译启动失败不计为检出。尚未对被测模型运行，不写模型通过率。

## 初次验收

- 三向验证：data/task-runs/API-04/2026-09-14T10-52-12-171Z，六阶段全部符合声明。
- 变异验证：data/task-mutations/API-04/2026-09-14T10-52-39-718Z，3/3 检出，全部有效执行。
- `node node_modules/typescript/bin/tsc --noEmit` 通过。
- 管道回收改为等待 close（包含 stdout 完成）后会再执行最终回归，结果见本次 Note。

## 尚未证明的部分

本题仍为 fixture-ready；极难是结构性设计目标，未获得不同模型/人工作答的难度校准。没有 Linux 容器执行、真实模型作答、评审一致性或物理断电测试。资源检查测重复重放是否写放大，不等于吞吐量/长期性能基准。事务保证仅覆盖单个本地数据库，外部副作用允许至少一次重放。
