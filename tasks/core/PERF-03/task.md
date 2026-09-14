# PERF-03 · 图统计和索引的规模增长控制

题目版本：0.1.1；难度：hard；运行时：Node.js 24 原生 TypeScript 类型剥离。

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
