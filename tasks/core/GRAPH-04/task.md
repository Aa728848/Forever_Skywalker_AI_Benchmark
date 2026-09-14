# GRAPH-04 · 依赖图批次更新与诊断快照原子发布

- 难度：极度困难（待真实作答校准）；独立核心题；TypeScript on Node.js 24；版本：0.2.0。

## 现场

语言服务接收一批文件变化，更新依赖关系，在后台重算诊断，最后把一致的图与诊断交给查询方。
编辑器出现了以下故障：改走另一条依赖后仍重算旧消费者；连续两批改动漏算第一批；后台旧任务完成后，
查询又看到较旧的状态。删除文件时其消费者仍然存在，删除和随后重建必须反映在诊断里。

修复 starter 的行为，保留既有 Invalidator 接口及兼容行为。graph.ts 与 workspace.ts 是实现入口；
内部组织可调整。不要依靠任务到达次序或一次只会有一个 prepare 的假设。

此题提炼自 cwtools-vscode 固定提交的诊断失效、刷新代际及分离构建/原子发布机制，
是独立复现，不是对完整 LSP 仓库的一次集成运行。

## 冻结接口

workspace.ts 导出：

```ts
interface Document { readonly id: string; readonly deps: readonly string[]; readonly value: string }
type Change = { readonly kind: 'put'; readonly document: Document } | { readonly kind: 'delete'; readonly id: string };
interface Diagnostic { readonly id: string; readonly value: string }
interface Snapshot { readonly generation: number; readonly documents: readonly Document[]; readonly diagnostics: readonly Diagnostic[] }
interface Prepared { readonly generation: number; readonly affected: readonly string[] }
type Evaluate = (document: Document, get: (id: string) => Document | undefined) => string | Promise<string>;
class DependencyWorkspace {
  constructor(documents: readonly Document[]);
  get generation(): number;
  apply(changes: readonly Change[]): number;
  snapshot(): Snapshot | null;
  prepare(evaluate: Evaluate): Promise<Prepared>;
  commit(ticket: Prepared): boolean;
}
```

invalidation.ts 的 Node / UnknownNodeError / Invalidator 仍是公开接口。

## 接受编辑与依赖关系

- 文档 id 按原字符串区分；deps 是集合，重复依赖等价于一条边。构造参数含重复 id 抛 TypeError。
- generation 从 0 开始。非空有效批次整批接受并且仅增加 1；空批次不变。
- put 可新增或替换文档；delete 删除当前已接受图中的文档，目标不存在抛 UnknownNodeError。
  同批重复操作一个 id 抛 TypeError。失败批次不改变图、代际、待算集合、发布状态；操作顺序不改变有效批次的结果。
- **依赖允许暂未存在的文档**；get 返回 undefined。删除目标不会自动删除消费者的 deps；
  之后新增这个目标必须重新影响这些消费者。Invalidator 旧接口仍拒绝未知节点。
- 单批受影响集合是变化 id 本身，加变化前后依赖图中所有直接或间接消费者的并集。
  环、钻石、孤立节点都适用；结果去重并按 JavaScript 字符串字典序排序。
- 未成功发布的多批受影响集合必须累计，包括已删除的 id。构造时全部文档待算。
  每次接受的 Document 都与调用方可变对象隔离。

## 计算与发布

- 初始 snapshot 为 null。apply 和 prepare 不改变已发布的 snapshot。
- prepare 在调用时捕获图、代际和完整待算集合。对其中仍存在的文档调用 evaluate **恰好一次**，
  不调用无关文档，也不调用已删除文档；调用顺序与是否并行不作要求。
  get 及 document 始终来自这同一捕获状态，即使 await 期间或回调重入时 apply 了新批次。
- 准备结果包含准确的 affected（包括删除项）。候选诊断保留未受影响项，替换重算项，移除删除项。
  evaluate 的字符串可来自外部存储或异步计算；本题不规定具体诊断内容。
- 任意 evaluate 抛错或拒绝，prepare 拒绝；已经接受的编辑保留，发布快照不变，全部工作仍可重试。
- commit 只有在 ticket 是本实例实际签发、对应当前代际、且从该次 prepare 开始尚无其它成功发布时才成功。
  伪造/跨实例/陈旧/重复/同代晚完成的其它 ticket 返回 false，且不改变任何状态。
  成功时图和完整诊断一起发布，清空本代待算集合。旧代完成不能确认新代工作。
- 已返回的输入视图、ticket、snapshot（含嵌套数组/记录）不可被调用方篡改，也不能在后续编辑中发生变化。
  这表示单 Node 进程的异步并发与回调重入契约，不要求共享内存多线程同步。

## 规模与兼容

- 受影响计算不得无限递归或栈溢出。旧 Invalidator 必须处理 20,000 节点深链/环，
  返回自身及全部传递消费者，未知 changed/deps 抛 UnknownNodeError，各次调用不互相污染。
- 工作空间包含至少 12,000 个无关文档时，连续 80 次孤立单点编辑只允许总计 80 次诊断调用；
  环内更改只重算环及其消费者一次。受信检查在回调外计数，不采信自报性能值。
- 内存/总时间遵守 manifest。此题允许为事务快照复制索引，不限定实现算法；
  性能分另结合客观测量与代码评审，功能门禁针对无关诊断重算和资源终止。
- 只改 starter/，不引入第三方依赖；使用 Node 原生 TypeScript 支持的语法。

## 开发检查

```powershell
node --test --test-isolation=process --test-reporter=tap "public-tests/**/*.test.ts"
```

公开样例演示初次发布、钻石传播和文件删除/恢复。验收还覆盖错误批次、异步故障、
跨代/同代竞争、读快照隔离，以及种子化编辑序列相对独立全量重建的差分。
