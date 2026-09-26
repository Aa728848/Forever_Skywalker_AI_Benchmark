---
name: dsh-upgrade-sync
description: Use when DSH (DeepSeek Harness) or one of its plugins, especially the subscription-channel plugin, has been upgraded, reinstalled, or otherwise changed, and this benchmark project's coupling to it may have drifted. Covers running the read-only doctor, interpreting each finding, and repairing the known coupling points.
---

# DSH 与插件升级后的同步

本项目把 DSH 当外部依赖：它在 `packages/` 下的资产路径、包名、导出形状和 profile 组成都被直接读取或装载。DSH 升级过三处，每次症状都是**探测静默变空**或**真实作答直接失败**，而不是清晰报错。

## 第一步：先跑体检，不要先读代码

```powershell
pnpm dsh:doctor
```

只读本地文件与已安装包，不联网、不调用模型、不写配置；**始终以 0 退出**（它是报告，不是判据）。对其它 profile 体检：

```powershell
$env:BENCH_DSH_PROFILE='web'; pnpm dsh:doctor
```

**为什么要先跑它**：这个项目的历史教训是「用读代码代替跑代码」会得出似是而非的结论。doctor 把九条资产路径与包解析逐个探活，比人眼快且不会漏。

## 第二步：按 FAIL 行定位

| 输出行 | 含义 | 处理 |
| --- | --- | --- |
| `FAIL 资产 <名称>` | 本项目运行期直接读取的路径不存在：DSH 改名或移动了它 | 在 `packages/evaluation/src/dsh.ts`（`preparePreset` 读预设与迁移平面）或 `packages/evaluation/src/dsh-catalog.ts`（模块表 `modules`）里改到新路径；两处都有越界校验，别绕过 |
| `FAIL 解析 <包名>` | 该包不能从当前 profile 解析 | 多半是包被改名或拆分。查 DSH 的 `packages/` 下新名字，并确认它是否已改成**具名导出**（`apply`/`inject`）而非默认导出插件 |
| `FAIL 本 profile 可注册预设` | 该 profile 的 bundles 不含 `web-app`，插件声明的预设会静默降级 | **多数情况不用管**：自动作答（sdk）不需要插件预设。只有确实要用时才改 profile（注意 web profile 会绑 3080 端口并与 DSH 网页冲突） |
| `FAIL 固定镜像记录` | `data/container/runtime.json` 丢失（该目录被 git 忽略） | 镜像通常还在：`docker images` 找到它，按 `docs/container-setup.md` 记的 image ID 恢复记录，**不必** `pnpm container:build` |
| `FAIL DSH 安装` | `BENCH_DSH_ROOT` 指错 | 检查项目 `.env` 的 `BENCH_DSH_ROOT` |

## 第三步：修完必须实测，不能只看代码

改完跑这两条，它们覆盖本轮踩过的全部坑：

```powershell
pnpm check                                                    # 类型 + 目录 + 测试 + 构建
pnpm dsh:compare --check --provider <供应商> --model <模型> --preset standard --reasoning high --tasks CACHE-02
```

`--check` 现在会校验预设挂载前置条件（曾经会在资产缺失时报「预检通过」的假通过），但仍**不启动会话、不调用模型**。要确认预设真能挂载，用真实 `runDsh` 跑一次并看 `observedPresets` 是否等于请求值——**必须是实测，不能推断**。

## 已知的四个耦合点（历史踩坑，改这里最可能出错）

1. **预设资产**：`packages/preset/agent-presets/**` 已删除。现为 `packages/bundle/web-app/presets/<id>.patch.yml`，整份 YAML 作为**第二个 launch patch 层**交付（含 `!!js` 标签，JSON 层载不动）。
2. **预设注册表**：入口是 `packages/preset/agent-preset-registry/lib/index.js`；其 Config **只剩 `default`/`selectedDefault`**。声明行与 bridge **并发激活**，直接 `mount` 会随机拿到空列表——必须轮询 `list()` 并先查 broken。
3. **settings**：`settings-file` 已改名 `packages/settings/settings`，且**不再导出 `FileSettingsProvider`**。目录查询**不装载它**（适配器不需要它即可注册路由）。订阅渠道插件声明注入 `settings`，必须提供同形状接缝但**刻意不带 `register`**——带 `register` 会让插件改用空的进程内作用域，读不到已勾选模型。
4. **适配器**：改为**具名导出**模块（按模块命名空间交给 cordis），DeepSeek 入口移到 `llm-deepseek-api-key`。模型清单来自 `$DSH_HOME/storages/<provider>-models.json`，查询要把这些文件复制进临时 home（**凭据一律不复制**）。

## 关于插件预设（订阅插件的 `dispatch`）

它通过**运行期注册**进入活动注册表，**不写任何 DSH 读取的文件**，所以预设枚举看不到它，也不应假装看到。要判断它在某 profile 是否生效，看该 profile 的 bundles 是否含 `@deepseek-ai/dsh-web-app`。

**重装插件改变不了结果**：包在 sdk 下可以解析（由 `profiles/node_modules` 指向 DSH checkout 的 junction 提供）；缺的是**注册表服务**。`~/.dsh/.agent-presets/` 里的残留是更早降级留下的，DSH 0.1.7 起已不读该目录（可用其自带 `editing-cordis-compositions` 技能核对）。

## 排查纪律

- **探针必须镜像真实布局**：临时 home 若不含 `profiles/node_modules` 的 junction，包解析会因生产环境不存在的理由失败，对比结论就是假的。
- **探针必须能退出**：插件会持有句柄，脚本末尾要 `process.exit(0)`，否则前台等待超时、输出永远看不到。
- 失败原因**只回传结构性事实**（缺失路径、无法解析的模块、装载失败的插件），不转发异常原文——插件异常可能带凭据或本机路径。
- 未确认的执行一律报「未知」，不谎报成功或失败。