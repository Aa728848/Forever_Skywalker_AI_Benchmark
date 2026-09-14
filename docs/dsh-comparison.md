# DSH 单命令模式对比

在评测项目的 PowerShell 中运行，模型 ID 使用你在 DSH 中实际选择的值：

```powershell
pnpm dsh:compare --model <模型ID>
```

自动完成：导出独立题目目录 → 创建全新 DSH SDK 会话 → 应用 DSH 预设、模型和思考等级 → 等待明确完成 → Linux 验证与质量评分 → 保存报告及压缩证据 → 清理本次临时数据。默认标准预设、CACHE-02、Off/High 各一次。真实运行会调用作答模型，以及已配置的裁判。

指定一种预设、模型、思考等级和报告位置：

```powershell
pnpm dsh:compare --preset ptc --model <模型ID> --reasoning high --output "C:\Users\A\Documents\DSH-Reports"
```

| DSH 界面名称 | 命令标识 |
| --- | --- |
| 标准 | standard 或 标准 |
| PTC | ptc |
| 极简 | minimal 或 极简 |
| 创造 | cordis 或 创造 |

预设决定 DSH 的提示及工具组合；思考等级是模型推理参数，二者独立。通过 DSH 公开的预设挂载与作用域组合接口，在首个模型请求之前应用原预设；必须取得实际 `agent-preset/selected` 事件才能接受完成，不能仅把模式标签写入报告。

## 首次使用与配置

本机已发现 `C:/Users/A/Documents/deepseek-harness` 的 SDK/CLI 0.1.5-rc.1 构建。DSH home 默认使用环境中的 `DSH_HOME`，否则使用用户目录的 `.dsh`；由 DSH 自己读取供应商配置，本项目不读取或复制其中密钥。可在本项目 `.env` 设置：

```dotenv
BENCH_DSH_ROOT=C:/Users/A/Documents/deepseek-harness
BENCH_DSH_HOME=C:/Users/A/.dsh
BENCH_DSH_PROFILE=sdk
BENCH_DSH_PROVIDER=deepseek-official
BENCH_DSH_MODEL=你的模型ID
BENCH_DSH_PRESETS=standard,ptc,minimal,cordis
BENCH_DSH_REASONING_EFFORT=high
BENCH_DSH_REPORT_DIR=C:/Users/A/Documents/DSH-Reports
```

保存配置后，日常只运行 `pnpm dsh:compare`。命令行优先于 `.env`；`--provider` 可选择本次使用的 DSH 供应商路由。`--preset` 选择一个预设，`--presets` 接受逗号分隔列表，二者不能同时填写。`--reasoning` 选择一个思考等级，已有 `--modes` 仍接受多个思考等级，二者不能同时填写。这些参数只作用于本次创建的 DSH 会话。

未声明推理等级的模型使用 `--reasoning default`（也可设置 `BENCH_DSH_REASONING_EFFORT=default`）：本项目会省略 DSH SDK 的 `reasoningEffort` 字段，由供应商/模型配置决定行为。`default` 不等同于关闭思考；`off`、`high` 等仍要求模型明确支持该等级，原有默认 Off/High 比较不变。手动添加的自定义模型默认没有等级声明，不能直接给它传 High；若需要控制等级，先按 DSH 的 `providers.zh.md` 在模型配置中声明 `reasoningEfforts`。

```powershell
pnpm dsh:compare --provider gateway-a --model "same-model" --preset standard --reasoning default
pnpm dsh:compare --provider gateway-b --model "same-model" --preset standard --reasoning default
```

两个命令分别使用对应 Provider ID，模型 ID 相同不会跨供应商匹配。上述ID须换成自己的实际配置。

`BENCH_JUDGE_*` 控制固定裁判，与上述作答参数独立。裁判思考等级使用 `BENCH_JUDGE_REASONING_EFFORT`；例如 DeepSeek 裁判为 `high` 且 `BENCH_JUDGE_THINKING=enabled`，完整示例和预算见 [裁判供应商配置](judge-providers.md)。修改 `.env` 后重新运行命令；已启动的 API 服务需重启才读取新参数。

若使用自定义提供方，请保证 SDK profile 注册了该路由及其配置；Web 中存在的路由不会自动复制到 SDK profile。思考等级由对应适配器校验。保持 `BENCH_DSH_PROFILE=sdk`，通过预设选择极简模式，不要混淆 `minimal` 预设与另一套 `sdk-minimal` 启动配置。

先只检查本地文件、SDK 可加载性、固定 Linux 镜像和裁判参数：

```powershell
pnpm dsh:compare --model <模型ID> --check
```

预检不启动 DSH，不验证模型认证或发起模型请求。实际调用时初始化错误会落盘并停止后续作答。

## 实验选择

`--all` 选择全部已具备题目包的题目；不与 `--tasks` 同时使用。每个“题目 × 预设 × 思考等级 × 重复次数”都代表一次独立作答。

```powershell
# 四种 DSH 预设，统一 High 思考，两个复杂任务，共 8 次作答。
pnpm dsh:compare --model <模型ID> --presets standard,ptc,minimal,cordis --reasoning high --tasks API-04,GRAPH-04

# 标准预设，三种思考等级，两个复杂任务，每组每题三次，共 18 次作答。
pnpm dsh:compare --model <模型ID> --preset standard --tasks API-04,GRAPH-04 --modes off,high,max --repeat 3

# 先验证功能；跳过性能测量会使完整代码质量分保持待定。
pnpm dsh:compare --model <模型ID> --no-measure
```

默认每次作答限时 20 分钟、每次模型请求最多输出 16384 Token，使用 `--minutes` 和 `--max-tokens` 调整。输出上限不是整题总 Token/费用预算，DSH 内部可以多次调用模型。Ctrl+C 停止本实验，等待当前 SDK 运行时关闭；不自动重新发起已中断的收费作答。

每次使用独立的临时工作区与随机会话 ID，保持提示词一致，不向下一次作答传递评分反馈。按题配对，重复轮次交换模式顺序，串行执行以减少资源竞争。DSH 自身沿用所选 home 的设置；需要固定同一 home/profile 的工具、插件和审批规则。无交互审批的动作可能被 SDK 拒绝，这属于对应 SDK 档案的能力边界。

## 报告

`--output` / `BENCH_DSH_REPORT_DIR` 指定报告父目录，默认 `data/experiments`；每次建立唯一的时间与 ID 子目录，避免覆盖历史报告。正常结束后只保留三份报告文件：

- `report.md`：中文模式对比。
- `experiment.json`：完整实验配置、逐次结果、状态及归档摘要。
- `evidence.json.gz`：压缩 JSON 证据，包含最终作答代码（包括失败/取消的代码）、冻结 RunStore、实际检查、评分与评审材料、各组选择及分级汇总。每文件记录相对路径、Base64 内容、字节数与 SHA-256，可独立解压复核。

评分使用本次独占 RunStore；会话、缓存、附件、预设补丁、候选工作区和评分中间目录均放入本次临时根。压缩证据写入并逐文件回读校验、两份报告保存成功后才删除临时根。原有 `BENCH_RUN_DIR` 的历史记录不参与删除，新比较也不再写入默认 Web 运行列表；报告是该次比较的完整交付物。

SDK 回收未确认或报告写入/校验失败时，记录 `cleanup.state=retained` 并打印临时路径，保留可恢复数据，不冒报清理完成。正常失败作答和正常取消仍会归档清理。DSH 原有 home 的配置、凭据与历史会话保留；DSH 自身可能维护 profile 配置或迁移旧凭据，这些属于应用配置，不作为本次运行目录删除。

- 对比表：每个“预设 × 思考等级”组合的计划数、完成数、已评分数、验证通过数、可用/质量/总均分，以及每次作答的结束原因和耗时。
- 核心题和来源集成题分开统计。表中是所选题目试评均分，不代替四级加权综合成绩。
- 所有预定作答都保留。未完成、超时、取消和接口失败不会假报完成；没有验证的分数保持 `null`。同一组有缺测时不只平均成功项。
- 压缩证据内 `summaries/` 的 `*-selection.json` 和 `*-summary.json` 沿用原四级评分与集成题单列规则；缺少等级题目仍为待定。
- 不混合不同执行环境、裁判参数或裁判返回模型。SDK 仅公开消息归属路由，尚无可靠的供应商实际响应版本与完整费用汇总，因此 `responseModels: []`、`usage: null`，不以请求参数或文本长度冒充证据。
- `default` 和 `off` 是独立实验组；default 作答的 `solver.requestedModel.reasoningEffort` 为 `null`，表示未传该参数。预设指纹仅标识预设内容，不冒充实际思考深度；供应商默认配置应在实验期间保持固定。

当前通过 SDK 调用原始四种 Agent 预设，未自动化 `/plan` 的人工审批实验。Linux 隔离用于评分，DSH 作答运行在 Windows 本机。SDK close 的验收范围为拥有的运行时，不能声称强制退出后所有脱离工具进程都已回收。

平台仍按单机单写者使用；实验运行时不从其它 CLI/API 同时提交或重评。题库难度、评分阈值和真实模型/裁判仍待校准；脚本模拟验收不是模型成绩。
