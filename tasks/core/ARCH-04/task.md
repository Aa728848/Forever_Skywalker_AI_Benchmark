# ARCH-04 · 插件热切换、失败回滚与资源归属

- 难度：极度困难；题型：独立核心题；能力域：耦合与解耦。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

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
