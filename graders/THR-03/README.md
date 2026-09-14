# THR-03 受信侧资产与独立验证计划

本目录只对受信验证方可见，不进入候选工作区（导出只复制 manifest 的 `workspace.entries`）。

| 路径 | 用途 |
| --- | --- |
| `checks/checks.fsx` | 未公开检查：四读并发、读区异常释放、写者与读者先后完成、内存可见性、长序列计数 |
| `reference.patch` | 参考修复：读写分离的监视器 + `try/finally` 释放 + 写者优先 |
| `alternative/starter/src/ReadWriteGate.fsx` | 替代实现：`ReaderWriterLockSlim` + 独立计数锁 |

隐藏检查在导出之后注入 `__checks__/`，只通过 `#load "../starter/src/ReadWriteGate.fsx"` 引入被测模块。
**所有可能被阻塞的调用都在后台线程上带超时执行**，死锁会变成 `not ok` 而不是挂住整批检查；
用到的真实线程都是后台线程，进程不会被遗留线程拖住。

## 独立验证计划

1. 导出候选工作区，断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本只应在 `grader.defectDetectors` 声明的检查上失败（两个并发检查 + 两个异常释放检查）。
3. 应用参考补丁后，公开与隐藏检查必须全部通过。
4. 覆盖替代实现后，公开与隐藏检查必须全部通过。
5. 任一阶段缺失检查 ID 都视为未取得结论。

运行：`pnpm task:verify THR-03`。
