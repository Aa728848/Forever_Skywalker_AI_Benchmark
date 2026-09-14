# STATE-01 0.2.0 来源与独立契约

所有下列字节均通过 `git show <固定提交>:<路径>` 读取并核对，不使用来源仓库当前未提交代码，也不修改来源。

| 来源 | 固定提交 | 路径 | 原始字节SHA-256 | 已核对锚点 |
| --- | --- | --- | --- | --- |
| `cwtools-vscode` | `753a0d7c2df1f4285911febf2d10a949887f4499` | `client/extension/ai/runner/durableStorage.ts` | `75fcb968732bf04540b6a9d91eaed2ca5aa7359d32c20a2666b403f24e573068` | writeAtomicGeneration / readJsonWithBackup / atomicWriteQueues |

## 提炼边界

来源的同目录暂存替换、失败回收、读后结构验证直接对应本题边界；新增null族和rename故障注入检出实际参考漏洞。

新增实现与题目测试为本项目独立编写，原接口回归保持。来源是工程机制依据，不是难度实测证据；实际模型区分度仍待固定预算多次作答校准。
