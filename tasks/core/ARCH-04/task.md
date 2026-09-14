# ARCH-04 · 插件热切换、失败回滚与资源归属

- 难度：极度困难；题型：独立核心题；能力域：耦合与解耦。运行时：TypeScript on Node.js 24。题目版本：0.2.0。

## 背景

`starter/src/plugins.ts` 负责插件热切换。当前实现**先释放旧插件再启动新插件**：
一旦新插件启动失败，旧插件已经没了（系统处于无插件状态），而新插件已经占用的资源也没人释放。
请在**不改变公开接口**的前提下修复，把切换做成可回滚的事务。

## 公开接口（冻结）

```ts
export interface Plugin { readonly id: string; setup(): void; teardown(): void }
export class SwitchError extends Error { readonly from: string; readonly to: string }
export class PluginHost {
  constructor(initial: Plugin);
  get active(): string;
  get released(): readonly string[];
  switchTo(next: Plugin): Promise<void>;
}
```

## 必须满足的行为契约

1. 切换成功：先 `setup` 新插件，成功后把 `active` 换成新插件并 `teardown` 旧插件；`released` 记录旧插件 id。
2. **切换失败必须回滚**：新插件 `setup` 抛错时，新插件必须被 `teardown`（释放它已占用的资源）并记入 `released`；
   旧插件**保持生效且不得被 `teardown`**，`active` 不变。失败以 `SwitchError`（带 `from`/`to`）拒绝。
3. 每个插件最多被 `teardown` 一次。
4. 切换到与当前 `active` 相同 id 的插件是空操作：不 `setup`、不 `teardown`、`released` 不变。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。

## 0.2.0 异步插件所有权与重入

保留旧 PluginHost 接口。在 starter/src/async-plugins.ts 实现 AsyncPluginHost；初始 active=null。AsyncPlugin={id, setup(context):void|Promise<void>}，SetupContext={signal, defer(cleanup)}；cleanup 可返回 Promise。replace(plugin) 返回 Promise<{id,status:"active"|"superseded"}>，dispose():Promise<void>。

- 最新 replace 调用代表最新意图；慢启动不能覆盖它，即使 setup 同步重入 replace/dispose。被替代的待启动 signal 必须立即中止，允许 setup 不响应中止，系统仍须等其结算后回收资源。选择当前 active 同 id 不重复 setup，但撤销其它待启动意图。
- 新插件完成 setup 才可成为 active。在此之前旧确认插件持续生效；启动失败以 PluginSetupError 拒绝（id 与 errors[0] 是原始启动错误），回收失败插件拥有的资源，旧插件不变。过期候选的普通启动失败按 superseded 结算；发生清理错误仍必须拒绝并保留错误。
- defer 在 setup 尚未结算时允许登记，包括中止请求后的迟到获取；结算后调用抛 ScopeClosedError。每个资源只清理一次，按登记反序逐个等待，某项失败仍释放其余项，再以 AggregateError 报告。清理失败不能回退已经提交的新 active。
- dispose 同步封闭宿主并清空 active，等待所有已开始（包括尚未发布）的 setup 与其异步清理；重复 dispose 共用结果，不重复清理。关闭后 replace 以 ScopeClosedError 拒绝。空白 id 以 RangeError 拒绝。
- 清理函数不得等待它正在清理的同一 replace/dispose，以免用户代码自行形成等待环。无真实时间或网络依赖；检查用明确 Promise 屏障与固定种子交错，而不是依赖竞态碰运气。
