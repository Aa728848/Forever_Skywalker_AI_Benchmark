# 执行记录机制

开发决策与机器证据分别记录，使用同一题目、版本与作答身份关联。决策记录参考 cwtools-vscode 的 Agent Notes；本项目用户要求优先。

## Agent Note

路径为 docs/notes/{lifecycle}/{class}/YYYY-MM-DD-slug.md。生命周期只用 proposed、implemented、rejected、archived；分类只用 feature、bug-fix、simplification、architecture、process、testing。标题与正文用中文，包含 Problem、Decision、Alternatives considered、Consequences、Verification。与非平凡代码变更同批交付，不维护全局 INDEX。模板见 [README](notes/README.md)。

## 实际运行档案

```text
data/runs/
  index.json
  <taskId>/<runId>/<attemptId>/
    envelope.json                  # 提交信封
    freeze.json                    # 平台实算摘要、文件清单、提交者
    manifest.json                  # 固定题目、规则、候选与环境
    events.jsonl                   # 控制面追加的单调事件
    candidate/                     # 冻结快照
    execution/                     # 第一次执行
      workspace/                   # 被测副本；短性能工作区可能在临时目录
      public.stdout.tap / public.stderr.txt / public.resources.json
      hidden.*
      execution.json / score.json
      static-analysis.json         # 静态规则、范围、事实与违规
      benchmark-samples.json       # 全部配对、原始记录位置、环境哈希、规则
      benchmark-runs/              # 单次参考/候选负载的进程原始输出
      review-materials.json        # 两轮共用的冻结材料
      review-round-1.json / review-round-2.json / review-comparison.json
      review-error.json            # 无配置、预算、超时、无效响应等
      human-review.json            # 人工复核身份、理由、判决、候选摘要
    execution-2/                   # 显式重试或补评；不覆盖旧执行
```

按实际取得的证据生成文件，不创建虚假占位证据。旧入口可能产生 static.json/review.json，读取保持兼容。API 的 /detail 返回状态、执行、评分与事件；/report 生成 Markdown；单份证据下载校验受控路径与 SHA-256。

事件含 schemaVersion、稳定id、递增seq、UTC时间、type、actor、candidateHash、payload、evidenceRefs，同id不重复记账。当前核心事件为 run.created、submission.frozen、execution.started、check.finished、execution.finished、execution.reused、score.finalized；旧静态/评审注入入口还记录 static.analyzed/review.finished。自动质量流水线的完整材料、调用usage和决定保存在上述证据文件，score.finalized引用结果，不把事件名称数量当作完成度。

耗时用单调时钟；性能两次预热、七轮交替参考/候选，保留全部原始结果、环境哈希、中位数及离散度。PERF-02/04优先专用负载，其它题明确标完整验证成本。内部计时和RSS可能受同进程候选影响，仅作诊断；容器外阶段时间才用于性能配对。

## 预览与实际成绩分开

SQLite 默认 data/benchmark.sqlite，仅保存 PreviewReport。示例证据是调用者输入，不是实际AI成绩。实际执行分数来自冻结验证链：local为本机，rehearsal为未发布校准/脚本演练，formal要求隔离、ready题目、已校准规则及独立真实评审。缺分项保持null，不重新归一化。

同快照重试保持题目、环境和候选摘要；修复代码创建新attempt。人工复核和重评追加修订，原判决、身份、原因与时间都保留。查询只采用最新已完成的修订，中断产物不冒充完成记录。

平台按单机单写者使用。候选日志不作为控制面指令；令牌不进入候选环境或报告。输出超过8MiB会终止并明确截断。哈希发现内容变化，但同一权限拥有者仍能重写历史；发布级完整性需要隔离写入身份与受保护存储，不能只靠JSONL承诺不可篡改。

运行文件和临时输出不提交Git；最终结论在docs/trials，设计理由在Agent Note。二者不能互相替代。
