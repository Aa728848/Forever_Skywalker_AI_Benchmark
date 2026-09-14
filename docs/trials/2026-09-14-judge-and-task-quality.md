# 裁判参数与题目质量强化验收

日期：2026-09-14。Windows开发环境；未调用真实模型、未重启、未执行Linux容器。此报告对应新增裁判配置和API-04/GRAPH-04 0.2.0，前一批55题全量报告保留其原版本事实。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| pnpm check | 类型、55题目录、172项测试、生产构建通过 | 包括53项裁判回归、参数漂移/汇总一致性、反例有效性测试 |
| pnpm test:e2e | 2项通过 | 实际提交、报告、证据、四级汇总及窄屏；界面明确难度未校准 |
| pnpm bench judge-config | 本地验证通过，networkCall=false | 使用临时占位配置验证Responses/high，未发送请求或更改.env |
| pnpm score:rehearse | 兼容演练通过 | 94.68/100为脚本评审及假设性能输入，明确rehearsal |
| API-04三向 | 6/6阶段，参考/替代各26检查通过 | [report.json](../../data/task-runs/API-04/2026-09-14T10-54-39-112Z/report.json) |
| GRAPH-04三向 | 6/6阶段，参考/替代各17检查通过 | [report.json](../../data/task-runs/GRAPH-04/2026-09-14T10-51-27-594Z/report.json) |
| API-04近似错误修复 | 3/3目标检出 | [report.json](../../data/task-mutations/API-04/2026-09-14T10-54-42-718Z/report.json) |
| GRAPH-04近似错误修复 | 3/3目标检出 | [report.json](../../data/task-mutations/GRAPH-04/2026-09-14T10-51-31-714Z/report.json) |
| 两题受控试跑 | 2/2通过，参考均50/50，缺陷精确拦截 | [report.json](../../data/trials/2026-09-14T10-59-32-198Z/report.json) |

旧题审查快照：data/quality-audit/before-upgrade.json。具体判断和仍需强化的题目见 [质量审查](../task-quality-review.md)；8供应商参数、模型限制和官方出处见 [裁判配置](../judge-providers.md)。

反例只在已确认通过的参考实现上施加预声明局部错误，必须取得完整检查结果并命中目标断言；启动/编译/超时/缺测不提升检出率。其它已声明断言的额外失败原样保留，不自动改写目标。

当前仍没有难度校准、真实裁判一致性或Linux正式成绩；已支持的协议通过模拟HTTP验证，不代表每个用户账户与每个模型都实际连接成功。
