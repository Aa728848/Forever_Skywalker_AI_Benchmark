# API-04 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/submit.ts`；存储用内存实现，可注入写失败以验证事务性。

| 路径 | 用途 |
| --- | --- |
| `checks/submit.hidden.test.ts` | 未公开检查：首提交、幂等键、重启复用、写失败无残留、不同键不同 id |
| `reference.patch` | 参考修复：先读幂等记录，写失败不推进 committed |
| `alternative/starter/src/submit.ts` | 替代实现：ensure 私有方法与失败后序号回滚 |

验证：`pnpm task:verify API-04`。
