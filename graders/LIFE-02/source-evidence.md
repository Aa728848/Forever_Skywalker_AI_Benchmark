# LIFE-02 0.2.0 来源与独立契约

所有下列字节均通过 `git show <固定提交>:<路径>` 读取并核对，不使用来源仓库当前未提交代码，也不修改来源。

| 来源 | 固定提交 | 路径 | 原始字节SHA-256 | 已核对锚点 |
| --- | --- | --- | --- | --- |
| `deepseek-harness` | `2377c272a8e839e0a84c9f0e623b867a1dce2014` | `packages/extensions/tool-cordis/tests/cordis-lifecycle.spec.ts` | `cb7c1ad02eb394bca4db9ddf8391fb3230cfd63a261c94cf4477c24474b112e8` | Cordis effect ownership / Cordis child publication ownership |
| `dsh-chatgpt-subscription` | `464c98c2a506cdcc9768ef0b49731ba8aa429a90` | `test/web-provider-lifecycle.test.ts` | `74d10d93ff220797a3333ca5c3f9d00c921af84256c82d5cf67536c23e6c3d79` | web provider lifecycle / SearchProviderSwitcher |

## 提炼边界

来源具有迟到资源归属和ready订阅仅释放一次的实测回归。本题的StreamSession将其约束到source/deadline两个注入式资源，不复制来源类。

新增实现与题目测试为本项目独立编写，原接口回归保持。来源是工程机制依据，不是难度实测证据；实际模型区分度仍待固定预算多次作答校准。
