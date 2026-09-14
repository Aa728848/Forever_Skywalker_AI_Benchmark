# Agent Note: ARCH-02 题目包（Provider 元数据与运行时拆分）

Status: implemented

## Problem

“按运行环境拆包”最常见的错误是**用命名猜归属**：靠 id 前缀判断某个 provider 属于浏览器还是 Node。
一旦有人给共享模块取名 `browser-cache`（或者反过来把浏览器专属模块命名成 `web-telemetry`），
打包就会静默带错东西——Node 侧加载浏览器专属代码，或共享能力在某一侧凭空消失。

## Decision

- 冻结 `resolveProviders(catalog, runtime)` 与 `Provider.runtime` 元数据、两种错误类型。
- 缺陷族只有一条：**不看元数据、按 id 前缀猜**。重复 id 与非法元数据的校验在起始版本里就是对的，
  因此每阶段只失败与“运行时归属”相关的两项检查。
- 样本里刻意埋了两个反例：名字像浏览器、实际是 `shared` 的 `browser-cache`，以及浏览器专属但没有前缀的 `web-telemetry`。
- 参考实现只按 `runtime === 'shared' || runtime === 目标` 判定；替代实现先按运行时分区再拼接（结构不同）。

## Alternatives considered

- 保留前缀约定并在文档里写明“命名即契约”：这正是本题要否定的做法——归属必须是数据，而不是名字。
- 把重复 id 校验也做成缺陷：会让缺陷族扩散，违反一题一族。

## Consequences

- 中等档 10/12；核心题 25/48。
- 本题把“元数据是唯一事实来源”做成了可断言契约，后续的依赖边界类题目可以复用同一套反例设计手法。

## Verification

- `node scripts/task.ts verify ARCH-02`：六阶段通过——起始版本只被 4 个同族检出项判失败，
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

