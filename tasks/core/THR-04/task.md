# THR-04 · 多线程代际发布与中断恢复

题目版本：0.2.0；难度：extreme；运行时：Node.js 24 原生 TypeScript 类型剥离。

## 固定接口与契约

Job={id:string;value:number;gate?:SharedArrayBuffer;crash?:boolean}；Publisher.build(generation:number,jobs:readonly Job[],signal?:AbortSignal):Promise<boolean>；snapshot():{generation:number|null;values:ReadonlyMap<string,number>}。固定worker.ts对每个任务实际执行value*2，支持Atomics.wait共享屏障和真实异常，禁止修改。

每次build登记严格递增安全整数代际（首次>=0），重复job id或非法代际拒绝RangeError。候选必须用真实worker；直到本代所有worker成功退出才原子发布整个快照。新代登记后旧代晚完成返回false，绝不覆盖新快照。已取消信号不启动线程；在途取消返回false，清理所有本代worker且保留前次已确认快照。任务异常拒绝build、终止同代其它线程，不发布半成品；下一代仍能恢复。snapshot返回的Map由调用方修改不得污染内部状态。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。

## 0.2.0 跨代执行预算与关闭

Publisher(maxWorkers=4) 新增实例级线程预算，参数必须为1..8整数。不同generation共享同一活跃worker上限；每任务仍由冻结worker真实执行。高于窗口的工作在本实例排队，不能先创建被阻塞线程充当队列。新代成功登记后，撤销旧代未启动工作、终止其在途线程；旧build在全部自有线程退出后返回false，不必等待外部gate放行。新代也必须遵守旧线程尚未退出时的共享窗口。

close():Promise<void> 幂等并返回同一Promise：立即拒绝随后build（错误含closed），撤销已接受工作，等待全部worker退出及build结算，保留最后确认快照。预取消build不启动线程也不消耗generation；重复id和非法generation先拒绝，不能取消有效在途构建。禁止修改worker.ts。不要求调用者通过墙钟超大负载证明并行，检查直接观测线程创建、exit、共享屏障及代际交错。
