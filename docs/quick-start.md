# 从启动到看报告

## 最简单：分步启动向导

Windows 直接双击项目根目录的 `start.cmd`；已在项目终端中则运行：

```powershell
pnpm start
```

按编号选择，回车采用默认值，多选用逗号分隔，输入 `q` 或按 Ctrl+C 退出。向导提供：

如果没有 `.env`，或者基础环境/裁判尚未配置，向导会先询问是否补齐：

- 运行环境：生成本地API访问令牌，选择外部作答与运行记录目录、Linux或本机预览；已有 `data/container/runtime.json` 固定镜像记录会复用，镜像本体仍在预检时核对。没有镜像可暂时跳过，之后运行 `pnpm container:build`。
- DSH目录：选择项目、配置和报告目录。作答供应商的密钥继续由DSH管理；作答模型与模式在后续菜单选择。
- DSH工作区权限：选择只读、工作区可写（默认，限制在当前题目目录）或完整访问。评测建议使用“工作区可写”；权限会写入本次实验记录，便于比较复现。
- 独立 DSH 评分 Agent：填写独立供应商、模型 ID、思考等级和预算；root/home/profile/工作区权限沿用上方 DSH 配置，不另填 API 密钥。DSH home 自己管理供应商凭据。仅做本地参数校验，不发模型请求。也可以暂时跳过裁判，完整总分仍待定。

最后核对将补齐的字段，密钥只显示“已填写”。确认后保存到本项目 `.env`，本次启动和后续子进程立即使用新值。已有非空值、注释和其他字段保留；系统中非空的同名环境变量优先。中途取消或放弃保存不会写入本次输入。主菜单还可以选择 **“补齐 .env 环境配置”**。

后续测试菜单提供：

1. 用 DSH 自动做题：依次选择供应商与模型、标准/PTC/极简/创造模式、思考等级、题目、重复次数、每次限时、输出Token上限、性能测量和报告目录。
2. 导出一道题：默认放在评测仓库外的 `Documents\BenchAnswers`，交给其他编程AI工具完成。
3. 提交已完成的作答：选择题目、作答目录和标识，使用Linux验证及已配置裁判评分。
4. 启动网页/API，或检查Linux容器环境。

DSH模型列表从本地已安装适配器和配置读取，不向供应商探测或调用模型；供应商与模型ID联合选择。列表不代表认证已经验证。读取不到或额外插件路由未列出时，可手工填写ID。思考等级优先使用该模型声明的选项；没有声明时默认 `default`，也可手工填写自己确认受支持的等级。

最后会显示完整计划、作答总次数、裁判状态与可复制命令。默认“仅检查配置”，选择“开始测评”才会实际调用模型。同一页可以重新选择参数。选择仅预检后不会自动转为正式作答。

测评菜单中的模型、模式等选择只作用于本次；环境配置仅在单独确认后补齐 `.env`，原DSH配置不改动。评分 Agent 从本项目 `.env` 的 `BENCH_JUDGE_DSH_*` 读取；没有配置时完整质量分和总分待定。Linux评分前打开Docker Desktop。下面保留直接命令用法，便于脚本化使用。

评分模型（裁判）可以在启动菜单选择“设置裁判模型”，也可以随时运行 `pnpm bench judge-setup`：它读取本地 DSH 目录，列出供应商、模型和该模型声明的思考等级，确认后写回 `.env`；不调用模型。环境补齐向导只补缺失/空值，改已有值请用这条命令。

下面所有 `pnpm` 命令都在 Windows PowerShell 中输入，工作目录是本评测项目，不是在 DSH 聊天框中输入。

```powershell
Set-Location -LiteralPath 'C:\Users\A\Documents\ChatGPT\Forever_Skywalker_AI_Benchmark'
```

## DSH 或插件升级后：先跑一次体检

DSH 与订阅插件是外部依赖，升级可能改名或移动本项目读取的资产。历史上发生过三次，症状都是「探测静默变空」或「真实作答直接失败」，排查成本很高。升级后用一条命令逐项核对：

```powershell
pnpm dsh:doctor
```

它只读本地文件与已安装包，不联网、不调用模型、不写任何配置。输出逐项列出：DSH 版本、九个运行期资产路径是否存在、当前 profile 的 bundle 组成、预设注册表行由谁提供、关键包能否从该 profile 解析、订阅插件与旧预设目录状态、固定镜像记录。结尾汇总「需要同步适配」的条目。

命令**始终以 0 退出**——它是体检报告而非判据，其中某些 FAIL 是本组合已知且有意的取舍（例如 sdk 不挂 `web-app` bundle，插件因而无法在运行期注册预设，而自动作答不需要该能力）。要机器判读请解析输出中的 `FAIL` 行。

用 `BENCH_DSH_PROFILE` 可对其它 profile 体检，例如 `$env:BENCH_DSH_PROFILE='web'; pnpm dsh:doctor`。

## 先分清三个角色

| 角色 | 用途 | 什么时候需要 |
| --- | --- | --- |
| Docker Desktop 的 Linux 引擎 | 运行题目、检查代码、测量性能 | 采用 Linux 评分时需要打开 |
| DSH 后台运行时 | 让被测模型读题、改代码、执行公开测试 | 用 `dsh:compare` 自动做题时，由命令启动 |
| 本项目网页和 API | 看题库与运行记录、看自动测评报告、改配置、发起测评 | 想看网页时运行 `pnpm dev` |

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

命令结束会打印报告的绝对路径。正常情况下只保留 Markdown、完整实验 JSON 和压缩证据；临时工作区、会话缓存及评分中间文件会清理。自动比较的成绩看输出目录中的报告；这些报告会出现在网页的**报告中心**页签，但不会写进「运行记录」（那是 `BENCH_RUN_DIR` 里的手工提交记录）。

报告默认保存在本项目的 `data\\experiments` 下。每次实验都会新建一个类似 `2026-09-14T12-30-00-000Z-a1b2c3d4` 的子目录，因此不会覆盖旧结果；例如：

```text
C:\\Users\\A\\Documents\\ChatGPT\\Forever_Skywalker_AI_Benchmark\\data\\experiments\\<实验时间戳>-<随机ID>\\
  report.md          # 中文对比报告（优先阅读）
  experiment.json    # 完整配置、逐次状态与结果
  evidence.json.gz   # 可复核的压缩证据
```

向导中的“报告父目录”或 `BENCH_DSH_REPORT_DIR` 可以改到其它位置；命令结束时会同时打印报告目录、三个文件的绝对路径。手工 `bench submit` 的记录则在 `BENCH_RUN_DIR`（默认 `data\\runs`），与 DSH 自动比较目录分开。

## 方式二：不用 DSH

可以让其它编程 AI 工具做题，再交给本平台评分：

```powershell
pnpm task:export CACHE-02 "C:\Users\A\Documents\BenchAnswers\cache-r1"
```

也可以一次导出多道题；每道题会放在批次目录的独立子目录，并生成 `batch-manifest.json`：

```powershell
pnpm task:export --tasks CACHE-02,API-04,GRAPH-04 "C:\Users\A\Documents\BenchAnswers\batch-r1"
# 或导出全部已具备题目包的题目
pnpm task:export --all "C:\Users\A\Documents\BenchAnswers\batch-all"
```

让编程 AI 打开这个导出目录，按照 `TASK.md` 修改代码。它完成后，回到本评测项目的 PowerShell 提交：

```powershell
pnpm bench submit CACHE-02 "C:\Users\A\Documents\BenchAnswers\cache-r1" --key other-agent-cache-r1 --profile linux-container --measure
```

如果需要把某次作答交给外部评分 Agent，可先导出脱敏评审材料：

```powershell
pnpm bench review-export <runId> <attemptId> --output "C:\Users\A\Documents\BenchAnswers\review-cache-r1"
```

目录中会生成 `review-request.json` 与说明文件。评分 Agent 返回 `ReviewVerdict` 后，请包装为 `{"reviewer":"agent-id","reason":"独立评分","verdict":<ReviewVerdict>}` 文件，再用 `bench review <runId> <attemptId> --human <JSON文件>` 写回该次作答；材料包不包含隐藏检查、参考补丁或 API 令牌。

这种方式同样不需要 DSH，也不要求网页先启动。当前内置的自动做题连接是 DSH；仅填一个普通聊天模型 API，还缺少负责读写文件和运行命令的编程 Agent。裁判模型负责评审最终代码，不负责替被测模型做题。

如果要交给外部评分 Agent，平台应先导出冻结作答的评审材料，再由 Agent 返回符合协议的 JSON；Agent 不能直接修改分数。当前 `bench review` 会使用已配置的独立裁判，质量材料不足或响应无效时质量分继续显示“待定”。

手工提交的记录保存在运行目录中。想看题库和这些记录时，再运行：

```powershell
pnpm dev
```

浏览器打开 <http://127.0.0.1:4317>，该 PowerShell 窗口在服务使用期间保持运行。`pnpm dev` 只启动网页/API，不会自动让模型做题。网页自己发起的测评要走「发起测评」页签，见下节。

## 网页现在能做什么

浏览器打开 <http://127.0.0.1:4317> 后有六个页签：**题目目录**、**评分预览**、**运行记录**、**报告中心**、**发起测评**、**配置**。读操作不需要令牌；发起测评、取消、写配置和提交外部作答需要在页面上填写运行令牌（对应 `.env` 的 `BENCH_RUN_TOKEN`，只写入请求头，不回显、不外传，令牌存在浏览器本地）。

- **报告中心**：只读列出 `BENCH_DSH_REPORT_DIR`（默认 `data\experiments`）下一层的实验报告，展开逐条作答的阶段、阶段统计、进度日志与清理状态，并下载 `report.md`、`experiment.json`、`evidence.json.gz`。进行中的实验每 5 秒自动刷新。**损坏的报告仍然列出**并写明原因，不会被静默隐藏；`launch.log` 按钮保留但明确提示本阶段不产出该产物。

- **配置**：分「作答 / 裁判 / 目录与预算」三组修改 `.env`。保存分两步——先看待写清单，确认后才写入；密钥字段只显示「已填写」，值不会回显。**保存后当前进程立即按新值工作，不需要重启 API。** 只读项（`BENCH_RUN_DIR`、`BENCH_DSH_ROOT/HOME/PROFILE`、`BENCH_IMAGE`、`BENCH_IMAGE_DIGEST`、`BENCH_PROFILE`）会在页面上标注原因，写入请求也会真的被拒绝；这些请用 CLI 或环境变量修改后重启服务。
- **发起测评**：选题目范围、供应商/模型、DSH 预设、思考等级、重复次数、限时与输出上限，页面显示**计划总作答次数**。默认按钮是**「仅预检」**（等价于 `--check`，不启动 DSH、不调用模型）；**「发起真实作答…」需要二次确认**，确认框会再次显示总作答次数并提示会消耗真实额度。发起后由受控 supervisor 持有实验子进程：页面显示进程判定、心跳与租约与退出事实，只有服务端说「进行中」才轮询；取消由 supervisor 代理执行，无法确认终止时会如实报「残留未知」而不是谎报干净。启动记录同时显示**实验自身的结论** `merged.reportOutcome`（取自 `experiment.json`，与进程结论并列、互不顶替）：跑完但有行未通过显示**「已完成（有未通过行）」**，退出码 1 是「有题没做对」的 CI 语义，不再显示成「失败」；`experiment.json` 为 `failed` 仍是失败；仅预检没有实验结论就如实说「未登记」。**残留**只在落定后下结论：运行中不判残留（中性描述「运行中，子进程树 N 个存活进程」，子进程在场属正常状态），已落定且 supervisor 核对过后代才显示「已确认无残留」，其余如实说「残留未知」。**清理这条记录**（归档）只拒绝「仍在运行」与「发现可证明归属的存活进程」两种情形，按钮旁直接写明能不能用及原因；状态未知的记录可以归档，文件移入启动记录根下的 `.trash`、不删除、可手动移回。同一页签下方还能从 `BENCH_SUBMISSIONS_DIR` 的候选目录里提交外部作答。

## 模型 ID 和供应商怎么填写

截图中的 `<你在DSH使用的模型ID>` 是占位说明，不是模型名称；不要把尖括号及里面的中文原样输入。

在 DSH 的 **设置 → 模型** 查看供应商及其模型：

- 内置供应商使用已安装的模型目录；供应商 ID 例如 `deepseek-official`、`openai`、`anthropic`。使用实际 ID，不使用自定义显示名称。
- 自定义供应商的 Provider ID 是创建时填写的小写标识。在它的模型目录中点 **获取可用模型**，可以向已配置端点探测模型列表；端点不支持探测时，按供应商给出的名称手动添加模型 ID。
- 手工添加的模型可能没有声明可选思考等级，此时使用 `--reasoning default` 沿用供应商默认，不传思考参数；要指定 `high` 等等级，先确认该模型在 DSH 中声明了对应能力。`off` 表示明确关闭思考，与不指定参数不同。
- 订阅渠道（例如 ChatGPT 订阅、Command Code、Kimi Code）同样列在 **设置 → 模型** 中；它们的模型 id 直接填入，不需要 API 密钥。
- 启动向导列出的供应商 = 本地 DSH 设置里的供应商 + 原生适配器 + **当前 profile 已安装的插件包**。同一个 DSH home 下，订阅渠道插件只装在某个 profile（例如 `web`）时，默认的 `sdk` profile 看不到它，因为 SDK 启动的是 `sdk` profile，插件必须真的在那里装载才提供路由。要把订阅渠道用于自动作答，任选一种：
  1. 把插件装进自动作答使用的 profile（推荐，见下方两步）。
  2. 让本项目改用该 profile：在 `.env` 中设置 `BENCH_DSH_PROFILE=web`。实测 `web` profile 能在自动作答的 SDK 会话里装载，但它会绑定 `127.0.0.1:3080`——与正在运行的 DSH 网页界面同一个端口，界面开着时启动会以 `EADDRINUSE` 失败；它还会在每个会话进程里打开浏览器、且 `patchReload` 是 `live`（会挂 HMR 并热重载用户 patch），与 `sdk` 的 `startup` 冻结语义不同。除非先停掉网页界面并接受这些差异，否则不要用于正式评测。
  3. 仍然只做手工输入：向导的“手工填写供应商 ID / 模型 ID”始终可用。注意如果插件没装进当前 profile，运行时会报“没有为该供应商注册适配器”，所以这一种只在插件已装好的前提下有效。
- 同一个 DSH home 下的其它 profile 读取同一份供应商设置。若自行改变了 profile 的插件组合，应确认对应适配器仍存在；运行时不会靠模型名称猜另一个供应商。

### 把订阅渠道装进 sdk profile

只装插件还不够：这类插件声明注入 `webServer`（它要注册登录/额度路由），而 `sdk` profile 不挂载这个服务，插件会整体停在 pending——**连它自己的订阅路由一起都不注册**，实测运行时报 `no adapter registered for provider "codex-chatgpt"`。两步都要做。

第一步，安装插件（构建是必需的，缺 `--allow-build` 会报 `ERR_PNPM_IGNORED_BUILDS`）：

```powershell
dsh plugin --profile sdk add file:C:/Users/A/Documents/ChatGPT/dsh-chatgpt-subscription --allow-build=@eddyskywalker/dsh-chatgpt-subscription
```

第二步，编辑 `%USERPROFILE%\.dsh\profiles\sdk\cordis.patch.yml`，补上这一个 loopback 服务：

```yaml
# 订阅渠道插件声明注入 webServer；sdk profile 默认不挂它，插件会停在 pending。
# port 0 = 由操作系统分配空闲端口，不与网页界面的 3080 冲突。
- insert:
    - id: local-webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: 127.0.0.1
        port: 0
```

同一台机器上的**所有** profile 共享的供应商声明放在 **home 层补丁** `~\.dsh\cordis.patch.yml`（不是 `profiles\<name>\` 里那份）。DSH 把它应用在每个 profile 之上，本项目的模型目录也按同样顺序读两层，所以只写一处，`web`（网页）与 `sdk`（自动作答）就能选到同一批模型，不会像以前那样各写一份后互相漂移。写在 `profiles\<name>\cordis.patch.yml` 里只对该 profile 生效，且同名时会被 home 层整块盖掉。以 mimo 为例，写在 `~\.dsh\cordis.patch.yml`：

```yaml
- id: llm-pi-ai
  config:
    providers:
      mimo:
        apiKeyEnv: MIMO_API_KEY
        api: openai-completions
        baseURL: http://47.108.232.192:54483/v1
        models:
          - id: mimo-v2.6-flash
            name: mimo-v2.6-flash
            input:
              - text
              - image
            reasoningEfforts:
              low: low
              medium: medium
              high: high
          # mimo-v2.6-pro 同形；stepfun 见 web profile 的等价声明
```

凭据只从 `%USERPROFILE%\.dsh\.credentials.yaml` 的 refs 里按 `apiKeyEnv` 解析，补丁层不复制密钥。

本项目仍会**读取** `data\provider-profiles.json`（若你手工写过）：作答与裁判会话启动时由 `preparePreset()` 把它作为 `--patch` 顺序里**最后**的一层注入（因此与 home 层补丁同名时以项目档案为准），模型目录也列出它。网页**供应商**页签已于 2026-09-29 删除，因此**新增**供应商只能在 home 层补丁里写（见上），或手工维护该 JSON 文件。

这样做只影响 `sdk` profile：`web` profile 的清单、`node_modules` 与入口行都不变，网页界面照常使用。装完后 `pnpm start` 的供应商列表里会出现 `codex-chatgpt`（模型 `gpt-6-astra`，思考等级 `low/medium/high/xhigh/max`）。插件是否需要登录、额度是否足够，由 DSH 在运行时判断；模型目录本身不验证这些。

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

之后只需 `pnpm dsh:compare`。命令行指定的值优先。评分 Agent 另用 `BENCH_JUDGE_DSH_*` 配置，测试不同 DSH 模式时保持裁判一致；缺少裁判证据时完整总分仍待定。

更多参数见 [DSH 自动比较](dsh-comparison.md)、[裁判配置](judge-providers.md) 与 [Linux 环境](container-setup.md)。DSH 的界面和供应商字段已对照本地 `deepseek-harness/docs/user/guide/providers.zh.md` 与模型选择器源码核对。