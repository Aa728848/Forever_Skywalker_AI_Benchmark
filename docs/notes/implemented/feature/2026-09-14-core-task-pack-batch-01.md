# Agent Note: 核心题批量制作 · 第 1 批（CACHE-01）

Status: implemented

## Problem

M2 的目标是把核心题从 8 道试点扩到 48 道。此前的题目包都集中在试点（四档各 2 道），
简单档还差 10 道。批量制作需要一个可复制的流程，而不是每道题各写一套脚手架。

## Decision

- 沿用试点已经验证过的结构：`tasks/core/<ID>/`（task.md、manifest.json、starter、public-tests）
  + `graders/<ID>/`（checks、reference.patch、alternative、README.md），
  每题都必须通过 `node scripts/task.ts verify <ID>` 的六阶段。
- 本批交付 **CACHE-01 · TTL 与有界淘汰**：注入时钟的 `TtlCache`，缺陷集中在两处
  （TTL 边界用 `now > expiresAt`、`ttlMs: 0` 被逻辑或吞掉退回默认 TTL），
  外加逐出用插入顺序而不是最近使用顺序、命中不刷新顺序。
- 可验证性上的做法与试点一致：时间全部来自注入时钟（不用 sleep 撞边界）、
  隐藏检查自带辅助函数、替代实现换成“显式 touched 序号 + 线性选 victim”证明检查没绑定写法。
- 题目状态在 `catalog/tasks.json` 标为 `fixture-ready`，生成目录同步刷新。

## Alternatives considered

- 让缺陷同时覆盖“负 TTL 不校验”：那会让 `public/negative-ttl-is-rejected` 也失败，
  把不相关的健壮性问题混进同一缺陷族；改为在起始版本里补上校验，只保留 TTL/逐出这两处缺陷。
- 用真实时钟 + sleep 测过期：不稳定，被注入时钟取代。
- 用请求库/第三方 LRU 实现：题目是零依赖评测，候选也不允许第三方依赖。

## Consequences

- 核心题已有 9 道（简单档 2/12、中等 2/12、困难 2/12、极度困难 2/12 + CACHE-01），其余 39 道仍待制作。
- 每道题的检查数在 13–14 项之间，覆盖 behavior/boundary/state/regression/resources 五组，
  保证评分桥能算出五个分组的明细。
- 制作节奏：一批 1–3 道，逐题验证后提交，避免一次性堆出无法验证的资产。

## Verification

- `node scripts/task.ts verify CACHE-01`：六阶段通过（缺陷端只被 8 个声明检出项判失败，
  参考补丁与替代实现全部通过，导出结果不含隐藏资产）。
- 全部 9 个题目包逐一 `verify`：通过 9 题、失败 0 题。
- `pnpm check`：exit 0（68 项 vitest，含题目状态与题目包资产一致性检查；`fixture-ready` 计数 9）。
- `node scripts/catalog.ts --check`：55 题目录与元数据一致。

