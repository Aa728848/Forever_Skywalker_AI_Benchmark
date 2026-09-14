# CACHE-04 · 并发冷启动、持久化和版本隔离

题目版本：0.1.1；难度：extreme；运行时：Node.js 24 原生 TypeScript 类型剥离。

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
