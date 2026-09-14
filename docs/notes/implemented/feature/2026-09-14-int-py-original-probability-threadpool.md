# Agent Note: 真实 Python 裁判模块的概率、缓存与线程池集成题

Status: implemented

## Problem

INT-PY 原来没有执行资产，且本机来源目录已不存在。需要恢复固定来源并验证原概率聚合、真实线程池、缓存与 PPT 选择，不能把新写的算法当作来源实现，也不能为测试读取私人模型凭据。

## Decision

从[来源仓库固定提交](https://github.com/llm-as-a-verifier/llm-as-a-verifier/tree/8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770)取得 fine_grained_reward.py、pivot_tournament.py、pyproject.toml 与 MIT 许可。SOURCE.json 记录四个原始文件 SHA-256、来源 URL 和 Python 语义变体；受信 baseline 保留原文件。

使用新题生成器生成 INT-PY 0.1.0，预声明五组九项检查及五个缺陷检出项。starter 仅注入概率别名错误累加、奇数 rep 方向未恢复、PPT 并列取高下标三个缺陷；参考恢复原源码，替代用不同条件表达保持相同语义。

检查通过 importlib.util 载入两个真实文件，只替换外部 call_verifier 传输端口；源 score_pair_criterion、extract_score、ThreadPoolExecutor、磁盘缓存、directed_reward、select_best 全部实际执行。无需安装 SDK、tqdm 或读取凭据。两个线程用 Barrier 确定性重叠，验证实际峰值和 max_workers 上限。

题面明确 Python 聚合变体：同标量 token 别名概率取 max 后归一化；方向敏感缓存；奇数 rep 结果恢复候选顺序；并列最低下标；random.Random(seed).shuffle；故障 tie 仅当次有效且不写缓存。这些被测库语义不改变平台质量证据缺失时保持 null 的规则。

## Alternatives considered

没有用 TypeScript 或新写 Python 聚合器替代来源算法。没有导入整个包的 SDK 初始化入口或安装外部模型依赖。没有把不同随机实现的序列强行视为相同，也没有通过事后调整缺陷集合使验证变绿。

## Consequences

题包可以离线验证原裁判内部模块，集成成绩独立报告。原仓 SDK、CLI、真实模型端点及全仓测试不在本题声明范围；正式 Linux 容器执行仍需单列验收。

## Verification

- 原始源码基线：CPython 3.13.3，公开 4、隐藏 5 全部通过；证据 `data/task-runs/INT-PY/upstream-baseline/report.json` 及原始 stdout。
- `node scripts/newtask.ts <临时 INT-PY 规格> --no-docs`：由目录唯一写者执行，六阶段全部通过；starter 失败集合与五个预声明检出项一致，参考/替代全通过，无缺失检查。生成器通过后才推进 fixture-ready；原始记录 `data/task-runs/INT-PY/2026-09-14T10-21-22-753Z/report.json`。
- 四个原始文件 SHA-256 与来源记录全部一致，原文件位于 `graders/INT-PY/baseline/`。
- `pnpm typecheck`：通过。临时来源副本和生成规格在复制受信基线后清理。
