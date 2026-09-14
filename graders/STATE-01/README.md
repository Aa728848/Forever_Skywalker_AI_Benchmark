# STATE-01 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/store.ts`；每个检查用独立临时目录并在结束时释放。

| 路径 | 用途 |
| --- | --- |
| `checks/store.hidden.test.ts` | 未公开检查：往返、损坏检测、空值、键语义、原子替换残留、关闭语义 |
| `reference.patch` | 参考修复：临时文件 + rename、sha256 校验、空串合法、关闭检查 |
| `alternative/starter/src/store.ts` | 替代实现：`.staging` 临时名与不同的解析分支 |

验证：`pnpm task:verify STATE-01`。
