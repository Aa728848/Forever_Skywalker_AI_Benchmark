# API-04 · 持久任务队列：并发领取、租约隔离与崩溃恢复

极度困难；独立核心题；TypeScript / Node.js 24（内置 `node:sqlite`）；版本 0.2.0。

## 场景

一个后台开发任务服务将请求写入本地文件，多进程 worker 从同一队列领取任务并提交结果。事故记录包含：客户端超时后重试收到不一致的结果；宿主退出后出现无法恢复的任务；旧 worker 的迟到结果影响了新执行。请修复 `starter/` 中实现，使下面的公开协议在真实文件和进程边界成立。

来源场景：deepseek-harness 的持久代际发布、会话写入所有权，以及 dsh-trading 的任务账本与启动恢复。该题为独立缩编场景，不需要安装或修改来源项目，也不代表原仓库所有实现具有相同缺陷。

## 文件边界

- `model.ts`：输入、结果与错误类型。
- `storage.ts`：SQLite 文件访问。
- `queue.ts`：请求、领取和完成协议。
- `worker.ts`：领取后执行外部工作，并尝试发布结果。
- `submit.ts`：已使用的旧提交接口，必须保留其回归行为。

允许调整内部实现与模块组织；公开导出及以下行为必须保持。不能用内存全局变量代替持久状态。只改 `starter/`，不引入第三方依赖；内置 SQLite 可用。不调用外网。时间由调用方传入，不依赖真实等待来判定租约。

## 新接口

```ts
type Lease = { taskId: string; worker: string; generation: number; expiresAt: number };
class DurableQueue {
  constructor(path: string, options?: QueueOptions);
  submit(key: string, payload: string): string;
  claim(worker: string, now: number, leaseMs: number): Lease | null;
  complete(lease: Lease, result: string, now: number): boolean;
  snapshot(): QueueSnapshot;
  close(): void;
}
runOne(queue, worker, clock, leaseMs, execute): Promise<'idle' | 'completed' | 'superseded'>;
```

完整类型以 `model.ts` 为准。存储文件内部表结构不冻结；各实现只需读回自己写出的文件。本题没有旧 SQLite 格式迁移要求。

## 行为契约

### 请求身份与确认

1. 新的非空 `key` 对应一个永久唯一任务 ID，初始为 `queued`，代际为 0，`owner` / `leaseUntil` 为 `null`。按首次提交成功的顺序排队。
2. 同键、相同原始字符串内容重试返回原 ID；同键、不同内容抛 `QueueError`，`code='conflict'`，没有任何状态变化。内容不做 JSON 归一化；空内容合法。键是数据，包括 Unicode、换行、`|` 和路径形字符串。
3. 确认返回前，任务、请求去重事实和修订必须一致地写入文件。提交过程中失败或进程退出，重启后不能出现只存在其中一部分的状态。
4. 已提交但确认丢失时，重试应识别已生效状态，不能创建第二条任务。进程内的 Promise 或 Map 不是跨进程提交证据。

### 领取、期限和代际

5. `claim` 选择最早提交的可领取任务：`queued`，或 `leased` 且 `leaseUntil <= now`。没有候选时返回 `null`。`completed` 永不再次领取。
6. 每次成功领取令该任务代际增加 1，写入 worker 和 `now + leaseMs`。并行进程对同一可领取状态至多有一个成功确认；另一个可返回 `null` 或抛 `QueueError('busy')` 后由调用者重试。不得用进程内锁假定其它进程不存在。
7. `complete` 只接受与存储中 taskId、worker、generation、expiresAt 全部相符的租约。未完成任务还必须满足 `now < leaseUntil`；过期、伪造、旧代际或未知任务返回 `false`，没有修改。
8. 接受完成时，结果、完成状态和修订同时生效。相同完成令牌及相同结果重试返回 `true`（允许确认重试时间晚于原期限），不增加修订；结果不同抛 `conflict`。已完成任务的其他代际仍返回 `false`。
9. 租约重领使旧执行失去提交权限，即使新旧 worker 名称相同。执行可能早已启动，不能仅通过“禁止启动第二次”代替完成令牌校验。

### 执行与一致快照

10. `runOne` 按注入的 `clock()` 领取，传入原始 payload 和租约调用 `execute`，执行成功后再次读取时钟提交结果。没有任务返回 `idle`；结果接收为 `completed`；已失去租约为 `superseded`。执行抛错原样传播，任务保留领取状态等待到期接管。
11. **保证边界**：任务与有效结果在本账本内幂等；外部副作用不在 SQLite 事务内。执行完成但记录前退出，之后可以再次执行，因此外部工作是可能重放的。不要宣称任意外部副作用恰好一次。
12. `snapshot` 返回独立副本：任务按首次成功提交顺序，结果按首次完成顺序。每次成功的新提交、领取、首次完成各增加一次 `revision`；拒绝、失败、空领取和幂等重放均不增加。快照不能把并发业务动作的一半拼成可见状态。
13. 重复重放不持续增大文件、任务或结果历史。关闭释放文件资源，重复 `close` 无害，关闭后其它方法抛 `QueueError('closed')`。

### 边界输入与诊断

14. 空键、空 worker、不安全/负数/非整数时刻、非正的 leaseMs、相加溢出抛 `QueueError('invalid')`，不得修改状态。`busyTimeoutMs` 默认 2000，允许 0..60000 的安全整数。
15. `QueueOptions.onCheckpoint` 是同步诊断屏障，允许抛错或使进程直接退出，必须继续支持这些语义位置：

| checkpoint | 语义 |
| --- | --- |
| `submit-written` | 新任务已在本次操作中暂存，提交尚未确认 |
| `claim-selected` | 已选出候选，领取状态尚未确认 |
| `claim-written` | 领取状态已暂存，提交尚未确认 |
| `result-written` | 结果已暂存，完成状态尚未确认 |
| `committed` | 本次实际变更已生效，API 尚未返回确认 |

只在发生对应动作时调用一次，不对空操作/幂等重试调用 `committed`。前四个屏障抛错时整个动作必须无效果；最后一个屏障出错视作确认丢失，已提交数据仍然有效。可以改变内部持久结构，不能跳过屏障来逃避故障场景。

## 旧接口回归

`TaskStore.read/write`、`SubmitError.key`、`TaskSubmitter(store).submit(key,payload): Promise<string>` 和只读 `committed` 保持现有约定。旧接口同键重试忽略新的 payload，返回原 ID；写入异常映射为 SubmitError，失败不增加 committed；跨实例不同键 ID 不重复。本题**新接口**的内容冲突规则不追溯改变旧接口。

## 运行与评分

```powershell
node --test --test-isolation=process --test-reporter=tap "public-tests/**/*.test.ts"
```

公开检查展示正常执行、内容冲突、租约和失败症状。未公开检查增加真实子进程中断、两个独立连接交错、固定种子状态机、确认丢失与资源不增长。五个功能评分组均有真实检查。任务契约验证通过不等于难度已经完成模型校准。

文件数据库的进程退出恢复属于本题；物理磁盘损坏、文件系统不兑现 fsync、断电硬件故障和分布式多机共识不在本题保证范围内。
