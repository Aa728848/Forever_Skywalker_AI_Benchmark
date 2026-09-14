# Agent Note: 交付固定来源的验收器与插件生命周期集成题

Status: implemented

## Problem

INT-VERIFIER 与 INT-WEB 原先只有设计规格。核心小题不能代替原仓库的跨模块验收、真实文件事务、客户端状态、连接池和隧道生命周期；本次需要保持固定来源和许可、在独立副本中验证原模块与故障恢复。

## Decision

- 两个来源仓库先使用其已有 CodeGraph 定位，再用 `git show <固定commit>:<path>` 只读复制；原仓库未修改，没有读取私有凭据或实际用户配置。
- INT-VERIFIER 固定 `1a6b4151b8036203749e1b202b01395319a1578a`，保留 9 个源模块以及 MIT、原回归源、逐文件 SHA-256。实际运行 engine/cache/core/auto/router/session/replay，模型 caller 边界由明示受信响应替身提供，没有模拟替换评分或门禁模块。
- INT-WEB 固定 `f499828c71b79a8968fba7226c93c76304239879`，保留 34 个源文件。原客户端 face 经真实本地 HTTP 调用原 gateway/routes，实际解析 YAML、读写 profile、回滚安装并发布进度。SSH 原 routes/store/engine/pool/tunnel 链创建和关闭真实 localhost 隧道，远端 SSH 仅用合成传输。
- 补齐分层许可：dsh-web 根和 SSH 为 Apache-2.0，plugin-manager 包自身为 BSD-3-Clause；固定来源锁文件的 YAML 2.9.0 原 dist 与 ISC 许可离线随题发布，逐文件哈希保存，不依赖宿主安装。
- 来源回归源码作为 `.txt` 原样留存，相关断言移植到无需 npm 的 Node 集成检查；没有声称原仓库完整 Vitest、React 或宿主套件已运行。Node 24 原模块参数属性使用声明的 `--experimental-transform-types`。
- 两题在注入前先验证未经修改的实际来源模块基线，再在题面明示范围内注入回归。参考补丁恢复固定来源，替代实现使用不同的 flight 清理/挂载所有权/隧道遍历结构。
- 五个功能评分组都有独立证据；题目状态由题库维护代理在验证通过后统一推进。

## Alternatives considered

未用重新实现的小算法代表原仓库集成。未拷贝整个仓库及用户配置，而是保留相关真实模块闭包和显式外部边界。YAML 解析没有使用正则或假 parser；采用固定版本的原库并离线复制。React 设置页不在此题重复建立完整宿主，题面明确验收其实际客户端状态服务，DOM 专项由真实浏览器核心题负责。

## Consequences

两题可在独立导出的 Node 24 工作区运行，不需要模型、账号、真实 SSH 服务器或网络安装。INT-WEB 允许容器内 localhost HTTP/隧道，但不访问外网。上游文件从平台主 tsconfig 排除，避免把缺失的宿主类型误当成本平台类型；各题原模块接口/运行时通过自己的固定实际执行检查验收，排除不替代执行证据。

源码与依赖清单较大，独立代码裁判必须明确材料和预算范围，不能静默截断或因客观证据与模型材料耦合而丢失已有分数。正式发布仍需容器隔离、校准和真实质量评审，本次只交付 fixture-ready。

## Verification

- INT-VERIFIER 未经注入的固定源：11/11 真实模块检查通过；基线报告 `data/integration-baselines/INT-VERIFIER/baseline.json`。
- INT-WEB 未经注入的固定源：12/12 真实模块检查通过；基线报告 `data/integration-baselines/INT-WEB/baseline.json`，包含真实本机 HTTP 与隧道生命周期。
- `node scripts/task.ts verify INT-VERIFIER`：六阶段通过，starter 恰好七个已声明缺陷项失败；证据 `data/task-runs/INT-VERIFIER/2026-09-14T10-08-18-383Z/`。
- `node scripts/task.ts verify INT-WEB`：六阶段通过，starter 恰好八个已声明缺陷项失败；证据 `data/task-runs/INT-WEB/2026-09-14T10-17-18-768Z/`。
- 替代实现改为显式 owner 清理/别名遍历后，最终两题三向回归均通过：`data/task-runs/INT-VERIFIER/2026-09-14T10-21-08-234Z/`、`data/task-runs/INT-WEB/2026-09-14T10-21-08-333Z/`。两题所有五个功能评分组均有实际执行项。
- 最终 `node node_modules/typescript/bin/tsc --noEmit`：退出 0。
- 临时 profile、缓存和服务均由 finally 释放，证据保留在已忽略的 `data/`；没有运行真实模型、外部 SSH 或原仓库实际账号。
