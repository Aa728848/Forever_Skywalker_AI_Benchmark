# Agent Note: 撤销项目自有的 pi-ai 供应商档案：改由 DSH home 层补丁统一声明

Status: implemented — 网页「供应商」页签与 /api/providers 路由已删除，档案层保留只读

## Problem

[项目自有的供应商档案](2026-09-27-pi-ai-provider-profiles.md) 交付后，本机出现了三个平行的事实来源：

1. `~/.dsh/cordis.patch.yml` 的 home 层补丁（尚未存在）
2. `~/.dsh/profiles/sdk/cordis.patch.yml` 里的 `llm-pi-ai` 档案
3. `~/.dsh/profiles/web/cordis.patch.yml` 里的同名档案
4. 本项目自己的 `data/provider-profiles.json`

它们靠人工保持同步。事实上已经漂移过：迁移前 `sdk` 声明 stepfun + minimax-cn，`web` 只声明 stepfun，两份声明「同名同模型」的要求靠文档提醒维持，没有机制保证。DSH 自己没有 profile 继承（`profile-boot.ts` 明确是 bundle 层 → profile 层 → home 层 → `--patch`），所以「在 web 里加一个供应商、自动作答就看到」在原结构下根本不成立。

## Decision

1. **pi-ai 供应商档案的唯一来源是 DSH home 层补丁** `~/.dsh/cordis.patch.yml`。DSH 把它应用在每个 profile 之上，因此一份声明同时服务网页与自动作答。本项目的模型目录按同样顺序读两层（见本 Note 的 Verification），读数与真实会话一致。
2. **删除网页「供应商」页签**：`apps/web/src/ProviderPanel.tsx`、`main.tsx` 的页签接线、以及 `style.css` 里约 90 条 `.provider-*` 规则（含三处与其它类合并的选择器，已逐个拆开而非整块删除）。
3. **删除 `/api/providers` 的 5 条路由**及其 `createProviders` 装配、`apps/api/src/providers.ts`（454 行）与 `providers.test.ts`（348 行），并从 `createApp` 的 options 里移除 5 个 `providers*` 字段。`GET /api/config/models` **不变**：「配置」与「发起测评」两个页签读的是它，不受影响。
4. **`data/provider-profiles.json` 的读取层保留**。`preparePreset()` 仍会把它作为最后一层 launch patch 注入，`mergeProjectProviders()` 仍并入目录——已存在的档案继续生效，只是不再有网页入口去增删改。
5. **作答与裁判的 provider / model / 思考等级仍取 `.env`**（`BENCH_DSH_*`、`BENCH_JUDGE_DSH_*`），写进 `experiment.json` 供复现。这条不受影响：这些参数本来就由 SDK 的 `initialize` 传入，不来自 profile；DSH 网页里的 `agent-default-model` 只管网页上新建会话的默认模型。

## Alternatives considered

- **让 DSH 网页设置驱动评测**（把 `agent-default-model` 当作作答模型的来源）：否决。DSH 设置的改动不会被 `experiment.json` 捕获，报告会失去可复现记录；且本项目的 `.env` 已经承担这个角色。
- **连档案读取层一起删干净**：否决。你机器上 `data/provider-profiles.json` 当前不存在（实测），但删除读取层会让「已存在的档案」在未来某次误加时静默失效，而保留读取层的成本是零。
- **保留页签但只读**：否决。用户要的是取消这个功能；只读页签仍会让人以为可以从这里改供应商。
- **反过来让 sdk 抄 web 的 YAML**：否决。两份仍会漂移，只是把漂移方向反过来。

## Consequences

- 网页从七个页签变为六个：题目目录、评分预览、运行记录、报告中心、发起测评、配置。
- 新增供应商的唯一路径是编辑 `~/.dsh/cordis.patch.yml`（手工）或 `data/provider-profiles.json`（无 UI）。这是本 Note 明确接受的代价：**用一点便利换取「事实只有一个家」**。
- `pnpm check` 从 432 项降到 412 项（删掉的是 20 项供应商路由测试），`pnpm test:e2e` 12 项全过。
- 「配置」页签的供应商下拉仍由 DSH 目录驱动，因此 home 层新增的供应商立刻出现在那里，不需要重启。

## Verification

- `pnpm check` exit 0：typecheck + 目录检查 + **412 项测试（28 个文件）** + 前端构建。
- `pnpm test:e2e` exit 0：12 项通过，含「配置」页签读写、密钥不回显、只读字段被拒。
- 删文件后 `pnpm typecheck` 单独再跑一次确认无残留引用（`ProviderPanel`、`createProviders`、`providers.*` 均为 0 命中）。
- `style.css` 中 `.provider-` 规则数量实测从 90 降到 0；合并选择器 `.detail, .provider-form, .artifact` 等三处已单独拆除，未连带影响 `.token-bar`、`.report-*`。
- 真实 DSH 会话未因本次删除而变化：删除只触及本项目的网页与 API 层，`preparePreset()` 的注入与目录发现路径未改（同日 home 层迁移的验收见前一份 Note）。

## 与既有 Note 的关系

本 Note **推翻** [项目自己的供应商档案](2026-09-27-pi-ai-provider-profiles.md) 中「档案归本项目所有、由网页管理」这一决策。那份 Note 仍拥有两项仍然为真的事实：档案**读取**层的形状（`preparePreset()` 注入、`mergeProjectProviders()` 目录合并），以及端点探测的协议对齐（`apps/api/src/providers.ts` 已删除，该事实随之失效）。