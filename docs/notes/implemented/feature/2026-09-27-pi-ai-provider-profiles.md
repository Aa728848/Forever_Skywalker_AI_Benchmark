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

- 任何通过 pi-ai 声明的供应商（stepfun、xiaomi 等）只要写在 profile 补丁层里，
  就会被列进模型目录；不再需要改本项目代码。
- 目录仍只做本地读取：不启动 profile、不调用模型、不发起网络请求、不读凭据文件。
- 未声明 provider 档案时行为与之前完全相同（pi-ai 保持休眠）。

## Verification

- 真实探测：`discoverDshModels(profile: 'sdk')` 供应商从 7 变 8，出现
  `stepfun -> step-5-preview`。
- 真实 API：`GET /api/config/models` 返回 200、8 个供应商、含 stepfun。
- 反向验证：把 worker 的 `piConfig` 透传改回不传，新增用例立刻失败
  （`expected undefined to be defined`）；恢复后 24 项全过。
- `dsh-catalog.test.ts` 新增用例覆盖「不给档案时不出现」与「给出档案时出现且带模型」；
  夹具复制 DSH 的 js-yaml 与真实 pi 适配器结构（尊重「休眠」语义）。
- `pnpm check` exit 0（379 项）；`pnpm test:e2e` 9 项通过。

## 本机配置改动（不属于仓库）

`~/.dsh/profiles/sdk/cordis.patch.yml` 追加了 `- id: llm-pi-ai` 的 providers 段，
使 sdk profile 也声明 stepfun（原备份：同目录 `.backup-20260927-005926`）。
这一步是**本机 DSH 配置**，不随仓库分发。