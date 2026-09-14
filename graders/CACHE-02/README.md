# CACHE-02 受信侧资产与独立验证计划

本目录只对受信验证方可见。它不进入候选工作区：导出只复制 `tasks/core/CACHE-02/manifest.json`
中 `workspace.entries` 列出的资产；`packages/tasks` 在读取 manifest 时强制隐藏资产必须位于题目包之外，
导出时也不会写入任何未列出的路径。

## 资产

| 路径 | 用途 |
| --- | --- |
| `checks/keyed-loader.hidden.test.ts` | 未公开的边界值、调用排列与错误路径检查，检查 ID 与 manifest 一致 |
| `reference.patch` | 参考修复（unified diff，相对工作区根目录的 `starter/src/keyed-loader.ts`） |
| `alternative/starter/src/keyed-loader.ts` | 结构不同的替代实现，用于证明检查未绑定某一种写法 |

隐藏检查在导出之后由受信侧注入 `__checks__/`，只导入工作区中的 `starter/src/keyed-loader.ts`，
不导入工作区中的任何辅助模块（防止候选项改写检查依赖）。检查用可控 deferred 关卡构造重叠，
不依赖 sleep 或计时碰撞；`load` 必须在返回前调用 `source`，因此重叠可以在同一同步轮次内断言。

## 独立验证计划

1. 导出候选工作区到系统临时目录，并断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本：公开检查只应在声明的检出项上失败；隐藏检查只应在声明的检出项上失败。
3. 应用参考补丁后：公开检查与隐藏检查必须全部通过，退出码为 0。
4. 改用替代实现后：公开检查与隐藏检查必须全部通过，退出码为 0。
5. 任一阶段缺失检查 ID（进程崩溃、超时、检查被删除）都视为未取得结论，验证失败。

期望值记录在 manifest 的 `grader.defectDetectors`，不由检查文件自我声明。
本地与正式环境的固定命令都来自 manifest 的 `commands.public` / `commands.hidden`；
本地为规避受限沙盒的命名管道限制而使用 `--test-isolation=none`，该选项在正式 Linux 容器中同样有效。

## 运行

```powershell
pnpm task:verify CACHE-02
```

报告与各阶段原始 TAP 输出写入已忽略的 `data/task-runs/CACHE-02/<时间戳>/`。
本阶段的成绩口径：只判定检查通过或失败，不产出正式分数；代码质量评审接入前总分保持待定。
