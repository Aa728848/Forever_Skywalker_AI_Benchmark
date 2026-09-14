# BND-04 · 超深、超大和畸形输入的有界解析

题目版本：0.1.1；难度：extreme；运行时：Node.js 24 原生 TypeScript 类型剥离。

## 固定接口与契约

parseBounded(text:string,limits:{maxBytes:number;maxDepth:number;maxNodes:number}):unknown；ParseLimitError拥有reason（bytes/depth/nodes）与offset（UTF-16下标）。

按JSON标准解析，正常结果与JSON.parse相同，畸形输入抛SyntaxError。限制必须是非负安全整数，否则RangeError。maxBytes计UTF-8字节数，超限reason=bytes、offset=0；maxDepth计数组/对象嵌套层数；maxNodes计每个容器、每个原始值和每个对象键字符串，关闭括号不计数。预算超限必须在调用JSON.parse/物化整棵树前拒绝，深度/节点错误offset指触发超限的token起点；先检查字节预算，再按从左到右token顺序检查节点和深度预算。字符串内部的括号、转义引号不能误计。不得用递归预扫描；允许预算内20000层嵌套输入。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。
解析拒绝后不得保留影响下一次调用的扫描状态。
