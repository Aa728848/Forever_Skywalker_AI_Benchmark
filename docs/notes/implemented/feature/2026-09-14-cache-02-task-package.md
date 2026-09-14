# Agent Note: CACHE-02 真实题目包与三向验证

Status: implemented

## Problem

M0 只交付了 55 道题的元数据目录：题目没有独立起始仓库、没有参考补丁、也没有可执行检查。
交接文档因此把 M1-01 定为“制作 CACHE-02 的真实任务包”，并要求同时给出
“起始缺陷被检出、参考修复与替代实现满足同一契约”的对照证据，且隐藏资产必须由导出逻辑排除，
不能仅靠目录命名暗示保密。

## Decision

按“候选题目包 + 受信资产 + 支撑代码”三层落地：

- `tasks/core/CACHE-02/`：对候选可见的题目包。
  - `task.md`：冻结公开接口（`KeyedLoader` 的构造、`load`、`has/delete/size/clear`）、
    10 条行为契约（缓存命中、同键合并、同步启动、成功缓存、失败传播、失败恢复、同步抛出、
    键身份、不同键并行、缓存 API 语义）与限制（仅可擦除语法、无第三方依赖、不得修改公开检查）。
  - `manifest.json`：运行时、固定命令、17 个检查 ID 及其分组权重与关键项、
    资源预算（60s / 512MB / 1 CPU / 关闭外网）、导出白名单 `workspace.entries` 与隐藏资产位置。
  - `starter/`：可独立运行的缺陷版本。缺陷是“加载失败后在途记录未清理”，
    于是被拒绝的 Promise 被永久复用；同一处失败路径还让 `source` 的同步抛出从 `load` 逃逸。
  - `public-tests/`：随工作区发布的 8 项公开检查。
- `graders/CACHE-02/`：只对受信侧可见的资产。
  - `checks/keyed-loader.hidden.test.ts`：9 项未公开检查（不同键名、三方并发、
    非 Error 拒绝值的同一性、失败后重试再次合并、delete/clear 与在途加载的关系、
    连续失败的保留有界性）。
  - `reference.patch`：参考修复（unified diff，相对工作区根目录）。
  - `alternative/`：结构不同的替代实现（显式 attempt 记录 + 手动兑现/拒绝）。
  - `README.md`：独立验证计划。
- `packages/tasks`（新包）：manifest 校验、白名单导出、受信检查执行、TAP 解析与三向验证。
  - 导出只复制 `workspace.entries` 列出的路径，未列出的资产不会被复制，
    不依赖 `graders` 这个目录名保密。
  - manifest 校验强制隐藏资产位于题目包之外，把 `reference.patch` 放进题目包会直接报错。
- `packages/contracts`：新增 `TaskManifestSchema`（0.1.0）。现有 Task、Assessment、
  ScoreResult、PreviewReport 协议与评分常量未改动。

检查用可控 deferred 关卡构造重叠：契约要求 `load` 返回前调用 `source`，
所以“同键只调用一次”“不同键不串行”都能在同一同步轮次内断言，不依赖 sleep 或计时碰撞。
隐藏检查不导入工作区的任何辅助模块，避免候选项改写检查依赖。

## Alternatives considered

- 只用目录命名（例如 `graders/`）暗示保密：不满足“不能只靠目录名暗示保密”，
  导出与校验因此改为 manifest 白名单加显式断言。
- 把公开检查写成只 import `node:assert` 的自定义运行器：可去掉测试运行器依赖，
  但候选项无法用 `node --test` 自行运行公开检查，检查 ID 还要另建映射。
- 让检查在题目包内就地运行：无法证明导出结果本身正确，也不能验证“冻结快照上运行”的路径。
- 在 M1-01 就扩展题目执行状态（例如新增 ready/fixture 状态）：会把现有 0.1.0 数据
  静默解释成新协议；交接文档把状态扩展归入 M1-02 至 M1-04，本次只在生成的目录头部
  说明题目包位置，状态字段继续只表示设计阶段。

## Consequences

- CACHE-02 具备可执行的正反对照：缺陷版本只被声明的 4 个检出项判失败，
  参考补丁与替代实现在公开与隐藏检查上全部通过。
- 本次只产出检查通过/失败，不产出分数；代码质量评审接入前总分保持待定。
- 检查命令使用 `node --test --test-isolation=none`，并用文件描述符而不是命名管道采集子进程输出：
  该做法在受限沙盒与完整权限下都可用，且在正式 Linux 容器中同样有效；同进程运行的代价是
  单个检查文件崩溃会终止整批检查，进程级隔离留给 M1-03。
- 参考补丁应用依赖 `git apply`；题目包工具用 `node`（Node 24 原生类型剥离）而不是 tsx，
  不给题目包工具链引入构建器依赖。受限沙盒下 esbuild/vite 无法以管道创建子进程时，
  `node scripts/catalog.ts --check` 与 `node scripts/task.ts verify` 仍可直接运行；
  本次最终在完整权限下跑通 `pnpm check`。
- 容器执行、提交与冻结、完成事件入口、代码质量评审仍未实现，M1-02 至 M1-04 待做。

## Verification

- `node scripts/task.ts verify CACHE-02`：exit 0。

  | 阶段 | 退出码 | 失败项 |
  | --- | ---: | --- |
  | starter-public | 1 | public/retry-after-failure、public/sync-throw-becomes-rejection |
  | starter-hidden | 1 | hidden/no-cache-of-rejected-attempt、hidden/retry-then-coalesce-again |
  | reference-public | 0 | 无 |
  | reference-hidden | 0 | 无 |
  | alternative-public | 0 | 无 |
  | alternative-hidden | 0 | 无 |

  各阶段均无缺失检查；导出结果只有 TASK.md、package.json、starter/src/keyed-loader.ts 与
  public-tests/keyed-loader.test.ts，不含 `__checks__`、`graders/` 或 `reference.patch`。
  原始 TAP 输出与 report.json 位于已忽略的 `data/task-runs/CACHE-02/<时间戳>/`（最近一次运行 2026-09-14T04-49-39-444Z）。
- `pnpm check`：exit 0。类型检查、55 题目录一致性检查、28 项 vitest 测试（含本包 8 项，
  其中三向验证 1 项）与生产构建全部通过。
- `node scripts/catalog.ts --check`：通过 55 题的协议、唯一性、四级覆盖与 Markdown 一致性检查
  （受限沙盒下 tsx 不可用时先用它替代）。
- `node` 复算 `packages/tasks/src/tasks.test.ts` 的全部断言：通过（临时脚本，未进入仓库）。
- `pnpm test:e2e`：exit 0，1 项浏览器端到端测试通过（覆盖现有筛选与预览面板，与本次题目包无关，
  用于确认基线未受影响）。
- 未完成：Linux 容器与正式执行器不存在，本次结果来自本机 Node 24.14.1，
  不能当作正式隔离成绩。
