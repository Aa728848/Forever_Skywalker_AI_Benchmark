# STATE-03 0.2.0 来源与独立契约

所有下列字节均通过 `git show <固定提交>:<路径>` 读取并核对，不使用来源仓库当前未提交代码，也不修改来源。

| 来源 | 固定提交 | 路径 | 原始字节SHA-256 | 已核对锚点 |
| --- | --- | --- | --- | --- |
| `dsh-trading` | `b6cf5535093cdc43fc61a7037d997bace7fb0e6d` | `packages/client-ui-trading/src/tasks/ledger.ts` | `7cb0c9de4fea45ac64c2f738128ed3a6ee4e1852391aecbc2a56da68632e75d1` | fingerprintOf / commit / apply |

## 提炼边界

来源requestId+fingerprint与持久修订启发事务身份。append确认丢失、不可变已确认前缀与坏尾恢复发布是本题新增的独立日志契约。

新增实现与题目测试为本项目独立编写，原接口回归保持。来源是工程机制依据，不是难度实测证据；实际模型区分度仍待固定预算多次作答校准。
