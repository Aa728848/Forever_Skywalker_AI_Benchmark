# INT-WEB · 插件安装、卸载和失败恢复

- 原仓库集成题，困难，版本 0.1.0。独立报告，不并入核心题分数。
- 来源 dsh-web，冻结提交 `f499828c71b79a8968fba7226c93c76304239879`。来源路径、逐文件 SHA-256、starter 缺陷注入记录见 `source-provenance.json`。
- 根仓库及 SSH 模块是 Apache-2.0；plugin-manager 包单独使用 BSD-3-Clause，保留于 `starter/upstream/packages/dsh-plugin-manager/LICENSE`；离线 YAML 依赖是 ISC，许可证位于 `starter/vendor/yaml/LICENSE`。不得删除这些声明。

## 真实集成范围

本题保留 34 个真实来源源文件，运行两条完整相关模块链：

1. 原客户端 `createPluginManagerFace` → 本地真实 HTTP → 原 `makeGatewayRoutes` → 原 `CliGateway` → `bundle-guard/profile/rows/state` → 实际 YAML/JSON 文件事务。公开的变更通知、进度状态、失败回滚和重试都通过真实客户端状态服务验收。
2. 原 SSH HTTP routes → 原 `HostStore` → 原 `SshEngine` → 原连接池与 tunnel 模块。隧道真实监听 `127.0.0.1` 临时端口，删除/配置变化后必须关闭实际监听并使旧连接失效。

起始副本注入四处回归：重复挂载保护失效、CLI reconciliation 后重复 bundle 未剥离、安装结束后客户端进度一直处于进行中，以及配置变化只关闭连接但留下隧道。

可修改范围只有以下四个来源文件，不改变原公开导出和协议：

```text
starter/upstream/packages/dsh-plugin-manager/src/mount-once.ts
starter/upstream/packages/dsh-plugin-manager/src/host/gateway.ts
starter/upstream/packages/dsh-plugin-manager/src/client/index.ts
starter/upstream/packages/dsh-ssh/src/engine.ts
```

## 验收契约

1. 同一包即使来自不同 apply 闭包或重复安装，生命周期内仍只注册一次；拥有者卸载后可以重新挂载。
2. CLI 重建 bundles 列表时，已被上层 patch row 挂载的既有包不能再次作为 bundle 挂载；保留已有 dependency、其他 bundles、用户注释和原备份/原子写入路径。
3. 安装失败必须完成已声明回滚，并通过原客户端 face 拒绝、复位 idle；失败不广播成功变更。随后重试成功才广播一次，卸载完成后列表及状态一致。
4. 修改 SSH 连接相关字段或删除别名时，所有兄弟隧道监听、旧连接和旧池记录都被释放；重新添加/连接使用新配置。非法更新原子拒绝，现有配置和有效连接不受破坏。
5. 非法 CLI 参数不得到达进程边界；“CLI 退出 0”不能代替实际落盘安装/卸载验证。
6. 已完成 gateway job 记录保持原来的 100 条上限；真实本地 HTTP 服务和所有临时隧道在检查结束时关闭。

## 固定运行方式

```text
node --experimental-transform-types --test --test-reporter=tap "public-tests/**/*.test.mjs"
```

Node 24.14.1，768 MB，60 秒，禁止外网。YAML 2.9.0 来自固定提交的 `pnpm-lock.yaml`，完整离线 parser/dist 与许可证已随题提供，不需要 npm install，也不依赖宿主偶然安装的包。

边界明确如下：官方 DSH 安装 CLI 由原源码已有 `spawnImpl/findBinary` 注入点替换为只操作本题临时 profile 的脚本；SSH 远端传输由合成 `Client` 替换，绝不读取真实 SSH config/agent 或连接远端；终端 WebSocket upgrade 明确拒绝。React `PluginManagerTab.tsx` 保留原源码但不在本题渲染，验收实际使用该页面提供的原状态 face；浏览器 DOM 另由核心前端题验证。其余网关、路由、协议解析、YAML、存储、池和真实 localhost 隧道全部执行保留的原代码。

`upstream-tests/` 保留相关原始回归源码（`.txt` 内容与冻结提交一致）；Node 检查移植本题相关既有断言并新增跨模块故障注入，不声称原仓库全量宿主/React 测试已通过。

五个功能评分组都有真实检查；八个预声明缺陷检测项必须拦住 starter，而固定来源参考恢复和不同实现的替代修复必须通过。质量证据缺失时总分仍待定，宿主验收不能冒充容器正式成绩。
