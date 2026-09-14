# INT-HARNESS 受信验证

修复 starter/packages/api/session-controller/src/client/sessions/assistant-stream.ts 的真实客户端流重连逻辑，保留公开接口。与原始 AssistantStreamAccumulator、expandAssistantStream、BlockAssembler 联合运行：重连只重建baseline.nextIndex之前的前缀（0时不重建）；后续稠密chunk索引缺口返回rebaseline，不把错位内容发布为正常帧；结算只在匹配end到达后一次性释放，未知attempt不得污染当前尝试。

保留原compact stream验证、未知帧回退、放弃/重新baseline生命周期。验证100000个压缩增量及有界重建前缀，组装文本与完整压缩回放一致。此题为真实stream/client/assembler模块集成，不启动完整Web服务。

SOURCE.json记录固定提交和原始源码摘要；参考补丁、替代实现和隐藏检查留在受信侧。

缺陷来源：在真实ClientAssistantStream中注入忽略重连前缀长度、忽略稠密帧序号的回归；另补上游nextIndex=0边界。只修该源模块，真实压缩/展开/组装/不可变值模块共同运行。

全部检查均运行真实源模块。运行 node scripts/task.ts verify INT-HARNESS 验证三向对照。

0.2.0 修正原参考解“完整展开后 slice”带来的工作量漏洞：客户端只展开已验证历史的选定前缀，受信Proxy实际观测尾部读取，并以混合text/reasoning/tool/raw压缩记录的原展开作为独立oracle。原初始来源文件和来源hash不变，参考及替代只修改允许的客户端模块。近似错误修复覆盖提前完整展开、前缀少算一项、拒绝错误帧却污染游标；运行 `pnpm task:mutants INT-HARNESS` 验证。
