# BND-03 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/decoder.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/decoder.hidden.test.ts` | 未公开检查：单块解码、跨块拆分的 3/4 字节字符、非法字节偏移、结束时的未完成序列 |
| `reference.patch` | 参考修复：用流式解码器（保留跨块状态）并在 end 时收尾 |
| `alternative/starter/src/decoder.ts` | 替代实现：自维护待续字节缓冲，按首字节推断序列长度 |

验证：`pnpm task:verify BND-03`。
