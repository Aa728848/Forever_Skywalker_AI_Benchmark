# ARCH-04 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/plugins.ts`；插件用可观察假实现（记录 setup/teardown 序列）。

| 路径 | 用途 |
| --- | --- |
| `checks/plugins.hidden.test.ts` | 未公开检查：成功切换、失败保留旧插件、失败释放新插件、teardown 只一次、同 id 空操作 |
| `reference.patch` | 参考修复：先 setup 新插件，失败则释放新插件并保留旧插件 |
| `alternative/starter/src/plugins.ts` | 替代实现：prepare/commit/rollback 阶段机 |

验证：`pnpm task:verify ARCH-04`。
