# INT-HARNESS · 长会话续跑与重连一致性

题目版本：0.1.0；赛道：原仓库模块集成；固定来源版本和逐文件SHA-256见starter/SOURCE.json。

修复 starter/packages/api/session-controller/src/client/sessions/assistant-stream.ts 的真实客户端流重连逻辑，保留公开接口。与原始 AssistantStreamAccumulator、expandAssistantStream、BlockAssembler 联合运行：重连只重建baseline.nextIndex之前的前缀（0时不重建）；后续稠密chunk索引缺口返回rebaseline，不把错位内容发布为正常帧；结算只在匹配end到达后一次性释放，未知attempt不得污染当前尝试。

保留原compact stream验证、未知帧回退、放弃/重新baseline生命周期。验证100000个压缩增量及有界重建前缀，组装文本与完整压缩回放一致。此题为真实stream/client/assembler模块集成，不启动完整Web服务。

## 来源与运行边界

本题是固定原仓库源码的模块子集，保留原始路径、接口、注释和许可证；不代表完整原应用。只允许修改题面指定的starter源码，公开检查和SOURCE.json保持不变。原始工作区只读。检查使用合成输入和明确的外部服务替身，所有被测业务模块均为真实上游源码。

固定依赖：Node.js24.14.1；全部依赖为同一冻结提交的真实llm/assembler/message/brand/values/crypto模块，无npm安装。

运行：node --test --test-isolation=process --test-reporter=tap "public-tests/**/*.test.mjs"。

可用分覆盖行为、边界、状态、回归与资源五组。三向通过仅推进fixture-ready；正式容器、校准和代码评审证据齐备后才发布正式成绩。
