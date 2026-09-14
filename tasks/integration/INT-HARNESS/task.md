# INT-HARNESS · 长会话续跑与重连一致性

题目版本：0.2.0；赛道：原仓库模块集成；固定来源版本和逐文件SHA-256见starter/SOURCE.json。

修复 starter/packages/api/session-controller/src/client/sessions/assistant-stream.ts 的真实客户端流重连逻辑，保留公开接口。与原始 AssistantStreamAccumulator、expandAssistantStream、BlockAssembler 联合运行：重连只重建baseline.nextIndex之前的前缀（0时不重建）；后续稠密chunk索引缺口返回rebaseline，不把错位内容发布为正常帧；结算只在匹配end到达后一次性释放，未知attempt不得污染当前尝试。

保留原compact stream验证、未知帧回退、放弃/重新baseline生命周期。验证100000个压缩增量及有界重建前缀，组装文本与完整压缩回放一致。此题为真实stream/client/assembler模块集成，不启动完整Web服务。

## 重连时的工作量与混合记录契约

长会话的完整压缩记录可能远大于当前窗口。`replace` 接收的 baseline 已经在持久边界验证为合法压缩记录，`nextIndex` 为其中有效的前缀长度。恢复时必须只读取/展开这 `nextIndex` 个成员，不能先展开整个历史再截取。零前缀不得读取任何记录载荷；末尾未进入前缀的 `texts`、`args`、`dt` 成员也不得被访问。读取记录类型、数组长度和必要元数据可以，工作量取决于前缀而不是未使用历史。受信检查直接观察数组访问，而不是接受实现自报计数。

前缀可以跨越 text、reasoning、tool-call 压缩块和 raw chunk，必须保留原时间戳、delta边界、工具ID与可选name。恢复出来的帧与原完整展开结果的同一前缀逐项相等；后续稠密帧继续从 `nextIndex` 接续。错误帧（包括重复索引或向前跳跃）返回rebaseline且不推进游标，随后正确索引仍可接收。未知attempt、替换baseline和匹配end后的结算规则保持不变。

原 `expandAssistantStream` 仍负责持久边界的完整合法性校验，不能删除或替换该模块；不要求此客户端再次扫描已经验证但不属于所选前缀的尾部。

## 来源与运行边界

本题是固定原仓库源码的模块子集，保留原始路径、接口、注释和许可证；不代表完整原应用。只允许修改题面指定的starter源码，公开检查和SOURCE.json保持不变。原始工作区只读。检查使用合成输入和明确的外部服务替身，所有被测业务模块均为真实上游源码。

固定依赖：Node.js24.14.1；全部依赖为同一冻结提交的真实llm/assembler/message/brand/values/crypto模块，无npm安装。

运行：node --test --test-isolation=process --test-reporter=tap "public-tests/**/*.test.mjs"。

可用分覆盖行为、边界、状态、回归与资源五组。三向通过仅推进fixture-ready；正式容器、校准和代码评审证据齐备后才发布正式成绩。
