# API-03 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/sse.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/sse.hidden.test.ts` | 未公开检查：单块解析、跨块缓存、序列跳跃、重放幂等、结束与非法帧 |
| `reference.patch` | 参考修复：统一 `#accept`（拒旧 / 查新 / 收下） |
| `alternative/starter/src/sse.ts` | 替代实现：先切分全部完整帧再逐帧处理 |

验证：`pnpm task:verify API-03`。

0.1.1 增加 starter/src/byte-stream.ts 的 UTF-8 真实字节边界、有界队列/帧预算与已交付游标重连检查。
