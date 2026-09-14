# ARCH-04 0.2.0 来源与独立契约

所有下列字节均通过 `git show <固定提交>:<路径>` 读取并核对，不使用来源仓库当前未提交代码，也不修改来源。

| 来源 | 固定提交 | 路径 | 原始字节SHA-256 | 已核对锚点 |
| --- | --- | --- | --- | --- |
| `deepseek-harness` | `2377c272a8e839e0a84c9f0e623b867a1dce2014` | `packages/extensions/tool-cordis/tests/cordis-lifecycle.spec.ts` | `cb7c1ad02eb394bca4db9ddf8391fb3230cfd63a261c94cf4477c24474b112e8` | Cordis effect ownership / Cordis child publication ownership |

## 提炼边界

来源直接有setup同步重入owner.restart、owner等待setup+异步cleanup、未发布子级清理、单次释放等真实回归；本题将其冻结为独立AsyncPluginHost合同，加入latest-intent选择协议。

新增实现与题目测试为本项目独立编写，原接口回归保持。来源是工程机制依据，不是难度实测证据；实际模型区分度仍待固定预算多次作答校准。
