# LIFE-04 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/acceptance.ts`；子进程端口用可控假实现，检查自行触发退出事件。

| 路径 | 用途 |
| --- | --- |
| `checks/acceptance.hidden.test.ts` | 未公开检查：正常退出、崩溃与信号分类、拒绝重入、完成后可再验收、逐个回收 |
| `reference.patch` | 参考修复：在途时拒绝重入 |
| `alternative/starter/src/acceptance.ts` | 替代实现：用当前句柄而非布尔标记表示占用 |

验证：`pnpm task:verify LIFE-04`。

0.1.1 增加 starter/src/process-acceptance.ts 的真实子进程、超时后代回收、裁判自触发阻断与快照代际检查；Linux 孤儿组路径需容器实跑。
