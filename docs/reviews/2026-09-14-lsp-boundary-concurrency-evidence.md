# LSP、边界、并发与线程题来源审查证据

日期：2026-09-14。四个来源目录仅读取。此处记录机制锚点，不声称新题直接复现某个未证实的上游缺陷，也不把当前工作树审查替换为来源清单的固定提交证据。

| 来源 | 本轮读取的HEAD | 已读取锚点与迁移到题目的机制 |
| --- | --- | --- |
| cwtools-vscode | 753a0d7c2df1f4285911febf2d10a949887f4499 | 经CodeGraph读取 `client/extension/ai/runner/diagnosticSnapshot.ts`：fresh/pending/stale/unavailable、complete与不可变诊断快照；仅完整fresh观察可比较。LSP-03/04把旧诊断隔离和完整发布转为明确可测的版本/生命周期协议。既有来源锚点另见各题sourcePaths。 |
| deepseek-harness | 2377c272a8e839e0a84c9f0e623b867a1dce2014 | 无.codegraph，使用rg读取 `packages/session/session-persistence-jsonl/src/generation.ts`、`lease.ts`：不可变代际、源身份校验、目标冲突和完整发布。CONC-04提炼计划/分片/发布恢复边界，使用不同的分片归并业务；未复制JSONL实现或声称多协调者事务。 |
| dsh-chatgpt-subscription | fd74561ed65b4cab9f8a2a5f635f2e8b051eee9c | 经CodeGraph读取 `src/host/oauth-service.ts`：refreshPromise合并、刷新结果写存储、logout/dispose与认证生命周期。CONC-02将认证、异步任务和传输清理组合为一个独立可复现协议；此HEAD不同于原始catalog来源提交，原来源清单保持不变。 |
| dsh-llm-verifier | e74ebaf47b984dbf817dce962a507b49a47b979a | 经CodeGraph读取 `lib/index.js` 中 `parseVerdictLetter`、`cleanVerdict`、活动/缓存绑定的当前构建代码；结果规范化、有限分数和输入边界用于BND-02/04的场景设计。没有声称上游采用本题的围栏协议；本题语法以TASK.md为准。 |

16题初审采用实际契约和检查内容：7题保留（LSP-01/02、BND-01、CONC-01、THR-01/02/03），9题改善。重点发现包括：CONC-03接口原本只有单资源；CONC-04原崩溃仅同步异常；THR-04起始代码已有大部分回收仅缺代际比较；BND-03隐藏样例基本复用公开样例；LSP-03/04的线程检查缺少同文档竞争和取消回调重入；BND-02分数描述把合法小数误写成非法。

实现与验证以[Agent Note](../notes/implemented/testing/2026-09-14-lsp-boundary-concurrency-quality.md)记录的题包、版本、三向和近似错误修复产物为准。没有真实作答模型或裁判调用，未把题包验收当作难度校准。
