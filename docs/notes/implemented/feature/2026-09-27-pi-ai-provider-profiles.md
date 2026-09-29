# Agent Note: 目录补齐 pi-ai 的 provider 档案（stepfun 等看不见的原因）

Status: implemented

## Problem

用户在网页「模型」列表里看不到 stepfun（阶跃星辰，模型 `step-5-preview`），
而它明明已在 `~/.dsh/profiles/web/cordis.patch.yml` 里声明、凭据也在
`~/.dsh/.credentials.yaml` 的 refs（`STEPFUN_API_KEY`）。

根因不在 profile 选择，而在**目录探测只装载 pi-ai 模块、不给它的 provider 档案**。

DSH 的 base bundle 把 pi-ai 适配器以**休眠**方式挂载：

```yaml
# deepseek-harness/packages/bundle/base/cordis.patch.yml:120
# The pi-ai multi-provider twin, mounted dormant: zero routes (and no extra
# models in the picker) until a `llm-pi-ai:` settings section supplies provider
# profiles — then those routes register live...
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
```

也就是说：插件已加载，但**没有 provider 档案就注册 0 条路由**。
`packages/evaluation/src/dsh-catalog-worker.mjs` 原先只 `context.plugin(piAdapter)`、
不传 config，于是 stepfun 在任何 profile 下都不会出现——实测 sdk 与 web 返回
**完全相同**的 7 个供应商。

## Decision

1. worker 读取补丁层里 `- id: llm-pi-ai` 的 `config`，在 `context.plugin(adapter, config)`
   时传给 pi 适配器。补丁层有**两层**，都要读：`$DSH_HOME/profiles/<name>/cordis.patch.yml`
   与 `$DSH_HOME/cordis.patch.yml`（home 层，DSH 把它应用在**每个** profile 之上，见
   `app-boot/src/profile-context.ts` 的 `readProfilePatches`）。两层是**整块替换**而非深合并——
   同 id 行的 config 覆盖替换掉整块 config（`docs/user/guide/providers.md:57`），因此按
   profile 层 → home 层顺序「后来者胜」，与 DSH 真实启动时落在插件上的形状一致。
2. **解析放在 worker 内**，而不是父进程：worker 本就在 DSH 的模块解析上下文里
   （已有 `createRequire(modules.llm)` 锚点），YAML 解析因此只有一处实现，
   不新增项目依赖，也不会出现两套语义。父进程只传补丁层的**路径**。
3. 处处失败都只是「少补一个供应商」：没有补丁层、没有 `llm-pi-ai` 条目、
   `providers` 为空、解析抛错——一律返回 null，不阻断其它目录，不抛错。

## Alternatives considered

- **在父进程解析补丁层**（我最初的做法）：需要项目自己引入 YAML 依赖，
  或在测试里维护手写 YAML 桩——后者正是「一个事实只有一个家」要避免的第二套语义。
  改为在 worker 内解析后，测试直接复制 DSH 的那份 js-yaml，语义完全一致。
- **让项目去读 web profile**：不动 DSH 配置，但作答也会切到 web profile，影响面大得多。
- **手工在 `settings.yaml` 里补声明**：`settings.yaml` 在本机已不存在（0.1.7 的
  `settings.yaml.imported` 是一次性导入来源），加载它已不参与路由注册。

## Consequences

- 任何通过 pi-ai 声明的供应商（stepfun、minimax-cn 等）只要写在**任意一层**补丁里，
  就会被列进模型目录；不再需要改本项目代码。**推荐写在 home 层**（`$DSH_HOME/cordis.patch.yml`）：
  DSH 把它应用在每个 profile 之上，本项目的目录也按同样顺序读两层，因此「网页能选到的模型」
  与「自动作答能选到的模型」在结构上就不会漂移。仍写在 profile 层只对该 profile 生效。
- 本机当前状态：pi-ai 档案只存在于 home 层一处（stepfun、minimax-cn），
  `profiles/sdk` 与 `profiles/web` 的补丁层都不再声明。实测两个 profile 的目录完全一致，
  各 10 个供应商、28 个模型。
- 目录仍只做本地读取：不启动 profile、不调用模型、不发起网络请求、不读凭据文件。
- 未声明 provider 档案时行为与之前完全相同（pi-ai 保持休眠）。

## Verification

- 真实探测：`discoverDshModels(profile: 'sdk')` 供应商从 7 变 8，出现
  `stepfun -> step-5-preview`；随后补上 mimo 声明，`sdk` 供应商再变为 9，
  `mimo -> mimo-v2.6-flash、mimo-v2.6-pro`，与 `web` 的同名模型一致。
- 真实 API：`GET /api/config/models` 返回 200、8 个供应商、含 stepfun。
- 反向验证：把 worker 的 `piConfig` 透传改回不传，新增用例立刻失败
  （`expected undefined to be defined`）；恢复后 24 项全过。
- `dsh-catalog.test.ts` 新增用例覆盖「不给档案时不出现」与「给出档案时出现且带模型」；
  夹具复制 DSH 的 js-yaml 与真实 pi 适配器结构（尊重「休眠」语义）。
- 2026-09-28 补 home 层用例四项：只写 home 层可见、两层都有时 home 整块盖掉 profile 层、
  只有 profile 层时行为不变、两层都无时保持休眠。反向验证：把 worker 改回只读第一层，
  「只写在 home 层」与「home 层覆盖」两项立刻失败（2 failed / 31 passed），
  另两项仍通过（说明它们守的是不回归而非新行为）。
- 本机实测：迁移后 `discoverDshModels` 在 sdk 与 web 下返回完全相同的目录
  （10 供应商 / 28 模型，含迁移前只有 sdk 有的 minimax-cn）；真实 SDK 会话在 sdk profile 下
  用 minimax-cn、stepfun、kimi-code 各 initialize 成功（0.2.0-rc.1，standard 预设）。
- 顺带确认（与本次改动无关）：`BENCH_DSH_PROFILE=web` 的真实会话在本机起不来，
  DSH 启动日志为 `listen EADDRINUSE: address already in use 127.0.0.1:3080`——
  端口被正在运行的 DSH 网页占用。用迁移前备份重建 home 复现同样失败，证明这是既有限制，
  不是本次迁移造成的。
- `pnpm check` exit 0（379 项）；`pnpm test:e2e` 9 项通过。

## 本机配置改动（不属于仓库）

**当前（本机，2026-09-29 迁移后）**：pi-ai 档案只存在于 home 层 `~/.dsh/cordis.patch.yml` 一处，
内容为 `stepfun` 与 `minimax-cn`；`profiles/sdk` 与 `profiles/web` 的补丁层都不再声明。
凭据在 `~/.dsh/.credentials.yaml` 的 refs（`STEPFUN_API_KEY`、`MINIMAX_CN_API_KEY`）里，
补丁只写引用名，不含密钥。迁移前备份：`profiles/sdk/cordis.patch.yml.backup-20260929-124641`、
`profiles/web/cordis.patch.yml.backup-20260929-124722`。
更早的 mimo 声明（`MIMO_API_KEY`）已随迁移被 home 层取代，模型目录中不再出现。
这一步是**本机 DSH 配置**，不随仓库分发。

## 后续：项目自己的供应商档案（网页页签已于 2026-09-29 删除）

> **交付态更正**：本节的「网页「供应商」页签」已不存在，`apps/web/src/ProviderPanel.tsx`、
> `apps/api/src/providers.ts` 及其 5 条 `/api/providers` 路由、约 90 条 `.provider-*` 样式
> 与 20 项路由测试均已删除。**档案读取层仍在**（`preparePreset()` 注入、
> `mergeProjectProviders()` 目录合并），已存在的 `data/provider-profiles.json` 继续参与作答；
> 新增供应商请写 DSH home 层补丁。决策与代价见
> [撤销项目自有的供应商档案](2026-09-29-provider-store-withdrawn.md)。以下保留为该决策的历史过程。

上面那条修复让**补丁层里已有的**声明能被看到，但用户仍需手工编辑 `~/.dsh` 下的 YAML。
网页现在可以管理本项目自己的供应商档案：`data/provider-profiles.json`，形状
`{ version: 1, providers: { "<id>": { id, displayName?, api, baseURL, apiKeyEnv, compat?, models } } }`。

事实（现在是交付态）：

- **不写用户的 DSH home**。改 `cordis.patch.yml` 无法在保留注释的前提下安全地改子树，
  改坏用户的 DSH 配置会让 DSH 本身起不来；因此档案属于本项目。
- **密钥永不入库、永不回显**。档案只存 `apiKeyEnv` 引用名；「已配置 / 未配置」由进程环境变量
  或 `~/.dsh/.credentials.yaml` 的 refs **名字**决定。值只在 `POST /api/providers/probe` 出网时
  被读取并放进请求头，不落盘、不进响应正文、不进错误消息、不进日志。
- **作答会话真的用得上**：`preparePreset()` 把档案写成 `<scratch>/project-providers.patch.json`，
  `runDsh` 的 `patches` 变成 `[launch.patch.json, preset.patch.yml, project-providers.patch.json]`，
  即 `--patch` 顺序的最后一层（同名以项目档案为准）。`fingerprint` 只在档案非空时把这一层的
  行内容 `JSON.stringify` 后一并摘要，因此改档案会改变指纹；档案为空时一层都不产生，
  挂载内容与指纹都与改动前完全相同。补丁行先 `insert` 再按固定 id `fsa-pi-ai-providers` 配置，
  因此 profile 补丁层有没有这一行都只多挂一条项目路由集。
- **目录列出它们**：`dsh-catalog.ts` 的 `mergeProjectProviders()` 把项目 provider 并入 `providers`，
  同名以项目档案为准并标 `source: "project"`，补丁层的标 `source: "dsh-patch"`。目录协议仍不带任何
  凭据字段（连引用名都不进目录），「已配置 / 未配置」由 `GET /api/providers` 单独回答。
- **探测**：`apps/api/src/providers.ts` 逐条对齐 `llm-pi-ai/src/discovery.ts`——
  openai-completions / openai-responses 用 bearer auth 打 `GET {baseURL}/models`；
  anthropic-messages 用 `x-api-key` + `anthropic-version: 2023-06-01` 打 `{root}/v1/models`；
  上限 4 MiB，超限**拒绝**而不是截断；其余协议如实报「无法探测」，不猜响应字段。
  这是全项目唯一出网的业务路由；评分核心仍无网络调用。
- **导出**：`POST /api/providers/:id/export-dsh` 是唯一会写 DSH 补丁层的路由。它必须带令牌；
  `confirm !== true` 时只回传将写入的内容，绝不碰文件。确认后先备份为同目录 `.backup-<时间戳>`
  再写。写入是**覆盖式**的（固定行 id 整块替换 `config.providers`），每次导出只带一个供应商，
  因此连续导出不同供应商会互相覆盖——这是已知取舍，DSH 自己设置界面写的行 id 不同、不受影响。
  目标 profile 不存在时拒绝写入，而不是在用户 home 下凭空造一个半截 profile。

更早的 `GET /api/config/models` 也走 `discoverDshModels`，因此网页「配置」与「发起测评」
看到的是同一个合并后的目录（「供应商」页签已于 2026-09-29 删除，见本文开头的更正）。

## Verification（供应商档案）

- 反向验证：把 `preparePreset()` 里的 `providerPatchRows(providerStore)` 换成恒为 `null`，
  新增的 launch 层用例立刻失败（1 failed / 54 passed）；恢复后 55 项全过。
- `pnpm check` exit 0（423 项测试 + 类型 + 目录 + 构建）。
- API 测试用 `node:http` 起本地假端点，断言探测路径/鉴权头、不落盘，以及密钥不出现在任何
  响应正文与错误消息里；测试全部走系统临时目录，不碰真实 `~/.dsh`。