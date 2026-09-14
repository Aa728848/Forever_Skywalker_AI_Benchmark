# ARCH-02 0.2.0 来源与独立契约

所有下列字节均通过 `git show <固定提交>:<路径>` 读取并核对，不使用来源仓库当前未提交代码，也不修改来源。

| 来源 | 固定提交 | 路径 | 原始字节SHA-256 | 已核对锚点 |
| --- | --- | --- | --- | --- |
| `deepseek-harness` | `2377c272a8e839e0a84c9f0e623b867a1dce2014` | `packages/util/http-proxy/src/policy.ts` | `4827eabf9fac440298fa38e1bdc4189bafa9a7d98852a25848d62b03ecc6aacf` | pure transport-free policy / EnvLookup / ProxyPolicy |

## 提炼边界

来源将可在browser-worker运行的纯policy与Node transport拆分，明确不导入undici。LoadableProvider目录、惰性加载和同键合并是本题新增的抽象边界，不声称来源有同名registry。

新增实现与题目测试为本项目独立编写，原接口回归保持。来源是工程机制依据，不是难度实测证据；实际模型区分度仍待固定预算多次作答校准。
