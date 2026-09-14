# THR-02 · 有界线程池与任务异常

题目版本：0.1.1；难度：medium；运行时：Node.js 24 原生 TypeScript 类型剥离。

## 固定接口与契约

Job={id:string;value:number;crash?:boolean;gate?:SharedArrayBuffer}；ThreadPool(size:number)；submit(job):Promise<number>；close():Promise<void>。size为1..8整数。

固定worker.ts必须真实执行每个任务并返回value*2，crash任务实际抛异常，对应submit拒绝但队列继续排空。任意时刻活跃worker不能超过size。可用SharedArrayBuffer gate控制真实线程交错：worker对下标0执行Atomics.wait，外侧将其设为1并notify后解除。不得修改worker.ts。

close立即停止接受新任务（后续submit拒绝且错误含closed），等待此前已接受的排队和在途任务以及所有worker退出；重复close幂等。结果按提交promise对应，不能依赖返回顺序，不得吞掉单任务异常或在异常后停掉整个队列。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。
