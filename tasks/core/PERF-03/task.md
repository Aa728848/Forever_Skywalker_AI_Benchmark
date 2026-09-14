# PERF-03 · 图统计和索引的规模增长控制

题目版本：0.2.0；难度：hard；运行时：Node.js 24 原生 TypeScript 类型剥离。

## 固定接口与契约

Vertex={id:string;dependencies:readonly string[]}；graphStats(vertices:readonly Vertex[]):{nodes:number;edges:number;inDegree:ReadonlyMap<string,number>;roots:readonly string[];missing:readonly string[]}。

重复顶点ID抛RangeError。每个源顶点的重复依赖只计一条边；只有已声明目标计入edges与inDegree，自环合法；roots为入度0的ID，missing为未声明依赖ID，两者去重后按JS默认字符串顺序排序。输入不改变，不同输入排列的统计等价。

必须用O(V+E)统计空间和扫描工作（输出排序成本除外），输入顶点和依赖数组的总元素读取不超过12*(V+E+1)。隐藏测量包含稀疏链/孤立图与密集图，同机正确参考配对测量，9000顶点样本中位耗时不得超过max(100ms,12*同机参考中位耗时)。发布前须单独校准噪声，当前阈值为题目开发预算。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。
调用者在两次调用间变更同一图对象时必须重新反映当前边，失败调用也不得污染后续结果。


## 增量索引事务（0.2.0）

starter/src/graph-index.ts 新增 GraphIndex(ids, reader)、apply(changes):number、snapshot():IndexedStats，其中 reader(id):readonly string[] 读取该顶点当前依赖；GraphChange={kind:'put'|'delete';id:string}，IndexedStats 为原 Stats 加 generation。

工作空间统计用于每次文件变更后的查询。修改一条依赖应删除旧入边索引；当前不存在的目标仍可能被引用，删除后重建也必须恢复正确入度。

- 构造时每个 id 读取一次；重复 id 抛 RangeError，generation 从 0 开始。输入数组、reader 返回依赖均须与外部后续修改隔离。
- apply 非空有效批次一次提交并增加一个 generation；空批次不变。put 新增/替换顶点，delete 删除已声明顶点。重复操作同 id、非法 kind、删除未知 id 均拒绝 RangeError，整个批次无修改。
- 只调用 reader 读取本批 put 的 id，每个恰好一次；不读取删除项或无关顶点。reader 抛错或返回非字符串数组时整个批次失败，保留原图、统计和代际；错误原样传播，非法数组抛 TypeError。调用方不能修改 reader 返回数组来改变已接受状态。
- 未声明依赖仍保留来源关系，在 missing 中报告。目标后来新增、删除或重建时，无需重读消费者也能恢复准确入度。边去重、自环、roots 排序沿用 graphStats。
- snapshot 返回一致已确认统计；所有返回对象/数组/Map 与索引独立，调用方篡改或后续提交不得改变已有快照和内部状态。
- 成功 apply 不重新获取全部依赖；允许为事务提交复制 Map 索引，但不以重新读取整个源图代替增量更新。专用配对性能负载覆盖持续局部修改、未解析目标创建/删除及统计查询，旧 graphStats 仍须回归。
