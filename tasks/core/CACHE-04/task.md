# CACHE-04 · 并发冷启动、持久化和版本隔离

题目版本：0.2.0；难度：extreme；运行时：Node.js 24 原生 TypeScript 类型剥离。

## 固定接口与契约

Storage.read():Promise<string|null>；Storage.writeAtomic(text:string):Promise<void>；Scope={workspace:string;model:string;rules:string}；PersistentCache(storage,scope)；get(key):Promise<string|undefined>；set(key,value):Promise<void>。

同实例并发首次访问共享一次磁盘读取；读取失败向调用者传播，下一次可重试。只有null、无效JSON或无效schema/entries格式按空缓存恢复，不得吞掉权限/IO异常。持久化格式为{schema:1,entries:[[compositeKey,value],...]}，compositeKey=JSON.stringify([workspace,model,rules,key])，键和值都是字符串。模型/规则/工作区变更隔离缓存，但写回保留其它域条目。

写操作串行、先由writeAtomic确认再更新可见缓存；失败不得改变内存/磁盘已确认值，后续写仍可完成。get等待当前已排队写。重建实例可读回已落盘条目。每个文件一次只允许一个写入实例；Storage保证失败写保留原文件，题目负责缓存层提交次序。测试会使用真实临时文件和注入的读取/写入故障。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。


## 批量提交、刷新与真实文件（0.2.0）

后台投影缓存会把多个相关结果一起提交，另有外部刷新触发重新读取磁盘。此前逐键成功、刷新晚到或确认前内存生效会让查询看到没有持久化依据的混合状态。

PersistentCache 增加 setMany(entries: readonly (readonly [string,string])[]): Promise<void>、refresh():Promise<void> 和 snapshot(keys:readonly string[]):Promise<readonly {key:string;value:string|undefined}[]>。

- setMany 在调用时复制全部键值；重复键或非二元字符串条目拒绝 TypeError，整个批次无效；空批次不写磁盘。一次非空批次恰好调用一次 writeAtomic，所有条目一起确认后可见，失败时没有部分修改。
- set、setMany、refresh 和 snapshot 按调用顺序排队。snapshot 是排到该点的一致已确认切面，不等待之后追加的操作，返回记录与数组冻结，keys 在调用时复制；允许重复查询键。
- refresh 在排队位置重新读取当前存储，成功才整体替换内存；合法空/损坏缓存按原规则恢复为空，IO失败原样传播并保留原已确认值。排队不能因为一次失败永久中断。
- 同文件单个活动写入实例约束不变；refresh 面向已经完成的外部文件更新，不要求多进程读改写冲突合并。域隔离、保存其它域条目及冷启动合并都仍须成立。

starter/src/file-storage.ts 新增 AtomicFileStorage(path,onCheckpoint?) 实现 Storage，直接使用真实文件；父目录已存在。

- read 对不存在文件返回 null，其余 IO 错误传播。写操作串行，用 UTF-8 写出完整数据并在主文件替换前确认文件内容已同步，不能直接截断主文件。成功无本次遗留临时文件。
- 同步 onCheckpoint 可在 temporary-written（暂存内容写出、尚未同步）与 before-rename（暂存已同步、主文件尚未替换）抛错或使进程退出。普通异常失败保留旧主文件并清理本次暂存文件，后续显式写可继续。
- 进程在任一屏障退出后，重启只读到完整旧主文件；成功完成替换后进程退出则重启读取完整新文件。不把暂存文件当确认结果；退出残留单个暂存文件允许后续写覆盖/清理。
- 测试会启动真实子进程中断。本题要求同一文件系统上的进程故障恢复；不承诺断电或文件系统损坏恢复，也不要求多个独立写入实例竞争。
