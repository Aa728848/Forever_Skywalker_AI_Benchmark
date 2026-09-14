# API-04 · 重启后任务提交与事务一致性

- 难度：极度困难；题型：独立核心题；能力域：后端与服务协议。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/submit.ts` 处理任务提交。当前实现**不使用幂等键**：同一个提交键重复提交会生成新的 taskId 并覆盖写，
重启后重试更会直接产生第二条任务。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface TaskStore { read(key: string): string | null; write(key: string, value: string): void }
export class SubmitError extends Error { readonly key: string }
export class TaskSubmitter {
  constructor(store: TaskStore);
  get committed(): readonly string[];
  submit(key: string, payload: string): Promise<string>;
}
```

## 必须满足的行为契约

1. 首次提交写入存储并返回新的 taskId，记入 `committed`。
2. **幂等**：同一提交键重复提交必须返回**同一个** taskId，且不得再写第二条记录。
3. **重启一致**：新建 submitter 读同一份存储时，提交已存在的键同样返回原 taskId，存储里始终只有一条。
4. **事务性**：`store.write` 抛错时不得留下半条记录（`committed` 不推进、存储条目数不变），调用方重试应当成功。
5. 不同提交键得到不同 taskId；空键抛 `SubmitError`（`key` 为空串）。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
