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

1. worker 读取 profile 的补丁层 `cordis.patch.yml`，取出 `- id: llm-pi-ai` 的 `config`，
   在 `context.plugin(adapter, config)` 时传给 pi 适配器。
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

- 任何通过 pi-ai 声明的供应商（stepfun、mimo 等）只要写在 profile 补丁层里，
  就会被列进模型目录；不再需要改本项目代码。两个 profile 的声明保持一致，
  网页（`web`）与自动作答（`sdk`）才能选到同一批模型。
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
- `pnpm check` exit 0（379 项）；`pnpm test:e2e` 9 项通过。

## 本机配置改动（不属于仓库）

`~/.dsh/profiles/sdk/cordis.patch.yml` 追加了 `- id: llm-pi-ai` 的 providers 段，
使 sdk profile 声明与 `web` 相同的 pi-ai 供应商：先是 stepfun，随后是 mimo
（`apiKeyEnv: MIMO_API_KEY`、两个模型 `mimo-v2.6-flash` / `mimo-v2.6-pro`）。
凭据在 `~/.dsh/.credentials.yaml` 的 refs（`STEPFUN_API_KEY`、`MIMO_API_KEY`）里，
本处只补声明，不复制密钥。改动前备份：同目录 `.backup-20260927-005926`（补 stepfun 前）
与 `.backup-20260927-105825`（补 mimo 前）。这一步是**本机 DSH 配置**，不随仓库分发。
## 后续：项目自己的供应商档案（网页「供应商」页签）

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

更早的 `GET /api/config/models` 也走 `discoverDshModels`，因此网页「配置」与「供应商」两个页签
看到的是同一个合并后的目录。

## Verification（供应商档案）

- 反向验证：把 `preparePreset()` 里的 `providerPatchRows(providerStore)` 换成恒为 `null`，
  新增的 launch 层用例立刻失败（1 failed / 54 passed）；恢复后 55 项全过。
- `pnpm check` exit 0（423 项测试 + 类型 + 目录 + 构建）。
- API 测试用 `node:http` 起本地假端点，断言探测路径/鉴权头、不落盘，以及密钥不出现在任何
  响应正文与错误消息里；测试全部走系统临时目录，不碰真实 `~/.dsh`。