# FE-04 · 多工作区实时视图一致性与资源预算

题目版本：0.2.0；难度：extreme；运行时：Node.js 24 原生 TypeScript 类型剥离。

## 固定接口与契约

Row={id:string;text:string}；StreamEvent为snapshot(sequence,rows)、append(sequence,id,text)或error(message)。mount(root:HTMLElement,connect:Connect,limits:{maxRows:number;maxWorkspaces:number}):Viewer；Connect=(workspace,afterSequence,onEvent)=>unsubscribe。Viewer支持switchWorkspace(workspace)、dispose、stats（workspace/sequence/retainedRows/cachedWorkspaces）。

每次工作区切换或同工作区重连，先释放旧连接，按该工作区最后确认序号接续；旧连接的迟到事件始终忽略，任何时刻只保留一个订阅。缓存按最近访问工作区淘汰，回到已淘汰工作区从序号0开始。

snapshot序号不得回退，重复ID拒绝RangeError且不改变状态；append是该行完整新文本，仅接受下一序号，旧事件忽略，跳号显示role=alert的gap文字且不推进。错误事件可见但保留确认内容。行使用article[data-row-id]安全显示文本，每工作区只保留最近maxRows行（同ID更新不移动位置）；DOM仅挂载当前工作区，缓存最多maxWorkspaces个，两参数为正整数。dispose释放连接/DOM/缓存，迟到事件无效。

正式浏览器检查发送100000增量后重连接续100001，检查DOM行数上限；启用精确内存计数与强制GC测量保留堆增长，预算32MiB（开发阈值，正式发布需同机校准）。只保留窗口所需行，禁止用隐藏DOM/无限历史数组绕过预算。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。

## 0.2.0 同步连接回调与重入资源归属

connect与返回的unsubscribe都可能同步调用switchWorkspace/dispose。最新调用代表最新意图，旧调用后续不得覆盖新工作区、事件或取消句柄。必须在调用旧unsubscribe之前使旧事件失效；unsubscribe同步发出的旧事件也无效。

connect尚未返回时发生切换/关闭，待其返回后仍须恰好一次释放这个过期连接。每次外层switchWorkspace返回后只保留最新连接（连接创建函数内部尚未返回的短暂资源交叠由此迟到回收规则约束）。重复dispose不能再次释放。

connect同步抛错时传播同一错误、显示role=alert并保留该工作区已经确认的行与序号；后续可再次switchWorkspace重试。过期调用抛错不得覆盖新工作区的错误提示。unsubscribe按约定不抛错。原100000事件、LRU、堆预算及序号契约继续成立。
