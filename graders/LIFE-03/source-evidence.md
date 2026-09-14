# LIFE-03 0.2.0 来源与独立契约

所有下列字节均通过 `git show <固定提交>:<路径>` 读取并核对，不使用来源仓库当前未提交代码，也不修改来源。

| 来源 | 固定提交 | 路径 | 原始字节SHA-256 | 已核对锚点 |
| --- | --- | --- | --- | --- |
| `deepseek-harness` | `2377c272a8e839e0a84c9f0e623b867a1dce2014` | `packages/core/agent-loop/tests/scope-lifecycle.spec.ts` | `296e7eb49f65028fb5c8fdf249250f252be1839008d95f84188b628e78dcfe6c` | scope creation rollback / concurrent final enter / pending setup abort |

## 提炼边界

来源在创建失败/中止后回滚未发布对象，并对并发终结入口限制唯一所有者。本题新增固定Runner状态机，覆盖自然退出、同步抛错、多个start等待同一次停止。

新增实现与题目测试为本项目独立编写，原接口回归保持。来源是工程机制依据，不是难度实测证据；实际模型区分度仍待固定预算多次作答校准。
