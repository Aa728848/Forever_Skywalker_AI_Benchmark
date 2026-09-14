# FE-03 · 长会话流式渲染与重连

题目版本：0.1.1；难度：hard；运行时：Node.js 24 原生 TypeScript 类型剥离。

## 固定接口与契约

Message={id:string;text:string}；mount(root:HTMLElement,onRetry:()=>void):StreamView。返回snapshot(sequence,messages)、append(sequence,id,chunk)（bool）、fail(message)、dispose()、lastSequence()。Node公开检查会在真正Chromium/Edge浏览器执行该模块，需BENCH_BROWSER_EXECUTABLE或受支持的浏览器路径。

初始序号0，非负安全整数。snapshot为服务端确认的完整消息列表，旧序号忽略；同序号快照可重放。append只接受下一序号，已接收序号忽略（false），跳号抛gap错误且不推进状态。重连快照与后续增量不能重复/丢字。重复快照ID拒绝RangeError并保持旧内容。

每条消息是article[data-message-id]，按快照顺序显示；同ID在快照和增量后必须保留同一个真实DOM节点，文本使用安全DOM文本写入。root为滚动容器：更新前位于底部时跟随底部，阅读历史时保持scrollTop。fail显示role=alert的文字和可聚焦重试button，不能删除已确认内容；点击或Enter各调用一次onRetry。dispose移除自身DOM和事件，迟到事件不再产生变化。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。
