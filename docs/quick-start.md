# 从启动到看报告

下面所有 `pnpm` 命令都在 Windows PowerShell 中输入，工作目录是本评测项目，不是在 DSH 聊天框中输入。

```powershell
Set-Location -LiteralPath 'C:\Users\A\Documents\ChatGPT\Forever_Skywalker_AI_Benchmark'
```

## 先分清三个角色

| 角色 | 用途 | 什么时候需要 |
| --- | --- | --- |
| Docker Desktop 的 Linux 引擎 | 运行题目、检查代码、测量性能 | 采用 Linux 评分时需要打开 |
| DSH 后台运行时 | 让被测模型读题、改代码、执行公开测试 | 用 `dsh:compare` 自动做题时，由命令启动 |
| 本项目网页和 API | 看题库、手工提交的运行记录 | 想看网页时运行 `pnpm dev` |

Linux 环境已经配置好。先打开 Docker Desktop，等待引擎运行；不用进入 Linux 桌面或单独打开 WSL 终端。`pnpm container:status` 可以检查容器环境。

## 方式一：用 DSH 自动测试

在 DSH 中配好自己的供应商和模型，然后在评测项目的 PowerShell 中运行。下面 `deepseek-v4-flash` 只是示例，换成你要测试的实际模型 ID：

```powershell
pnpm dsh:compare --provider deepseek-official --model "deepseek-v4-flash" --preset standard --reasoning high
```

这条命令会创建独立题目目录和新的 DSH 会话，让模型做题，结束后调用 Linux 评分并生成报告。**不需要先手动启动 DSH 网页，也不需要先运行 `pnpm dev`。** 命令直接调用后台运行时。

比较四种 DSH 预设，固定同一个模型和 High 思考等级：

```powershell
pnpm dsh:compare --provider deepseek-official --model "deepseek-v4-flash" --presets "standard,ptc,minimal,cordis" --reasoning high --output "C:\Users\A\Documents\DSH-Reports"
```

标准、PTC、极简、创造分别对应 `standard`、`ptc`、`minimal`、`cordis`。加 `--tasks "API-04,GRAPH-04"` 指定题目，`--repeat 3` 指定每种组合重复三次。不填写题目时只用 CACHE-02 检查完整流程，这一题的结果不能代表完整工程水平。

完整测试使用 `--all`，不需要手工列出55个题号。先固定一种预设和一个思考等级：

```powershell
pnpm dsh:compare --all --provider deepseek-official --model "deepseek-v4-flash" --preset standard --reasoning high
```

命令会显示计划作答次数。55题、4种预设、1个思考等级、各1次就是220次作答；可先加 `--check` 核对计划。不同模型或供应商应使用相同题单、预设、思考设置与预算，保留每次失败结果。

只想先检查配置和 Linux 镜像，可在同一命令末尾加 `--check`；这不会开始做题，也不发模型请求。API 凭据是否可用仍要在实际运行时验证。

命令结束会打印报告的绝对路径。正常情况下只保留 Markdown、完整实验 JSON 和压缩证据；临时工作区、会话缓存及评分中间文件会清理。自动比较的成绩看输出目录中的报告，不会另外写进网页的默认运行列表。

## 方式二：不用 DSH

可以让其它编程 AI 工具做题，再交给本平台评分：

```powershell
pnpm task:export CACHE-02 "C:\Users\A\Documents\BenchAnswers\cache-r1"
```

让编程 AI 打开这个导出目录，按照 `TASK.md` 修改代码。它完成后，回到本评测项目的 PowerShell 提交：

```powershell
pnpm bench submit CACHE-02 "C:\Users\A\Documents\BenchAnswers\cache-r1" --key other-agent-cache-r1 --profile linux-container --measure
```

这种方式同样不需要 DSH，也不要求网页先启动。当前内置的自动做题连接是 DSH；仅填一个普通聊天模型 API，还缺少负责读写文件和运行命令的编程 Agent。裁判模型负责评审最终代码，不负责替被测模型做题。

手工提交的记录保存在运行目录中。想看题库和这些记录时，再运行：

```powershell
pnpm dev
```

浏览器打开 <http://127.0.0.1:4317>，该 PowerShell 窗口在服务使用期间保持运行。`pnpm dev` 只启动网页/API，不会自动让模型做题。

## 模型 ID 和供应商怎么填写

截图中的 `<你在DSH使用的模型ID>` 是占位说明，不是模型名称；不要把尖括号及里面的中文原样输入。

在 DSH 的 **设置 → 模型** 查看供应商及其模型：

- 内置供应商使用已安装的模型目录；供应商 ID 例如 `deepseek-official`、`openai`、`anthropic`。使用实际 ID，不使用自定义显示名称。
- 自定义供应商的 Provider ID 是创建时填写的小写标识。在它的模型目录中点 **获取可用模型**，可以向已配置端点探测模型列表；端点不支持探测时，按供应商给出的名称手动添加模型 ID。
- 手工添加的模型可能没有声明可选思考等级，此时使用 `--reasoning default` 沿用供应商默认，不传思考参数；要指定 `high` 等等级，先确认该模型在 DSH 中声明了对应能力。`off` 表示明确关闭思考，与不指定参数不同。
- 同一个 DSH home 下的标准 SDK 配置读取同一份供应商设置。若自行改变了 SDK profile 的插件组合，应确认对应适配器仍存在；运行时不会靠模型名称猜另一个供应商。

**模型的选择由“供应商 ID + 模型 ID”共同确定。** 假设在 DSH 中建立了两个自定义供应商 `gateway-a` 和 `gateway-b`，它们都有 `same-model`：

```powershell
pnpm dsh:compare --provider gateway-a --model "same-model" --preset standard --reasoning default
pnpm dsh:compare --provider gateway-b --model "same-model" --preset standard --reasoning default
```

这会分别使用 A 和 B 的端点、凭据及模型配置。两个供应商的 Provider ID 必须不同，模型 ID 可以相同。这里三个名称是示例，使用前应替换成 DSH 中真实存在的配置。报告记录供应商与模型，不会仅凭同名模型把两个来源合并。

不想反复输入，可以把默认值保存在本项目 `.env`：

```dotenv
BENCH_DSH_PROVIDER=deepseek-official
BENCH_DSH_MODEL=deepseek-v4-flash
BENCH_DSH_PRESETS=standard
BENCH_DSH_REASONING_EFFORT=high
```

之后只需 `pnpm dsh:compare`。命令行指定的值优先。裁判另用 `BENCH_JUDGE_*` 配置，测试不同 DSH 模式时保持裁判一致；缺少裁判证据时完整总分仍待定。

更多参数见 [DSH 自动比较](dsh-comparison.md)、[裁判配置](judge-providers.md) 与 [Linux 环境](container-setup.md)。DSH 的界面和供应商字段已对照本地 `deepseek-harness/docs/user/guide/providers.zh.md` 与模型选择器源码核对。
