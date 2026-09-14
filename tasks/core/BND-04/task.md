# BND-04 · 超深、超大和畸形输入的有界解析

题目版本：0.2.0；难度：extreme；运行时：Node.js 24 原生 TypeScript 类型剥离。

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

## 0.2.0 语法驱动的有界入口

先校验limits，再校验完整UTF-8字节预算。随后按JSON语法从左至右检查：需要key/colon/comma/结束符的位置不合法时立即SyntaxError，不能把缺少标点后的字符当作后续值消耗预算。合法值/键的token起点先计节点，再对容器计深度，随后检查token本身；在同一点同时超限时nodes优先depth。所有语法/预算检查完成前不得调用JSON.parse；非法输入亦不得先物化再验证。只允许JSON的空格、tab、CR、LF，数字/转义严格采用JSON语法，偏移仍是UTF-16下标。
