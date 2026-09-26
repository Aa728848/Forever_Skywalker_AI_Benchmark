# Agent Note: .env 遮蔽与网页直达入口

Status: implemented

## Problem

网页「配置」页签承诺「保存后立即生效，无需重启 API」，但在真实启动方式下失效。`apps/api/package.json` 的 dev 脚本带 `--env-file-if-exists=../../.env`，把 `.env` 载入 `process.env`；而 `env-file.ts` 的 merge() 语义是「trim 后非空的 OS 环境变量优先于 .env」，于是每个键都遮蔽了自己：保存确实写入了文件，同一进程再读仍是旧值。同时该迹象在界面上表现为满屏「被系统环境变量覆盖」——用户机器上其实没有任何 OS 级 BENCH_ 变量，提示指向了错误的方向。

另有一个使用摩擦：从零启动要经过交互向导的多级菜单才能到达网页，用户希望一条命令直达。

## Decision

1. API 的 dev 脚本移除 `--env-file-if-exists`，改由 ConfigProvider 自己读 `.env`。这样 `fileValues` 与继承环境才是两个真实不同的来源，source/shadowed 反映事实。**优先级规则不变**：真实 OS 变量仍然遮蔽 `.env`，只是「文件」不再被伪装成「环境」。CLI 的三个入口（start / bench / dsh:compare）保留 `--env-file`，那是 CLI 的既有设计。
2. 新增 `start-web.cmd` 与 `pnpm start:web`：非交互直达网页与 API，不进入向导。缺 `.env` 或关键配置时明确报错并退出，**不静默失败、不自动写 `.env`、不自动进入向导**。
3. 顺带修正两个被同一问题掩盖的测试缺陷：`app.test.ts` 的「未配置时不启用」用例静默继承了仓库真实 `.env`，断言失去意义（改为注入空的 configEnv 与临时根）；`launches.test.ts` 有两处竞态——sweeper 定时器与 supervisor 自登记写入都可能落在两次 GET 之间，破坏「GET 无副作用」的字节比较（sweeper 间隔改为可注入并调长，GET 前先等自登记落盘）。

## Alternatives considered

- **把 merge() 的优先级反过来让 .env 优先**：会破坏既有承诺（OS 变量优先，用于 CI 与临时覆盖），且用户在环境里显式设置的值被文件悄悄压过更难排查。问题不在规则，在于文件被伪装成环境。
- **保存后重启 API**：放弃「无需重启」这一已交付能力，也要求用户手工干预。
- **`start-web.cmd` 直接启动、缺配置也硬起**：会让网页起来但写操作全部 401、发起测评缺镜像，故障点离原因很远；改为预检后明确报错。

## Consequences

- 网页保存配置后，新任务立即按新值执行；运行中的任务仍按各自创建时冻结的配置，不受影响。
- `.env` 中仅有值的键显示 `source: file`、`shadowed: false`；真实 OS 变量遮蔽时仍显示 `source: environment`、`shadowed: true` 并给出警告。
- `start-web.cmd` 是纯启动入口，不做任何配置写入；补齐配置仍需 `pnpm start`。

## Verification

- 真实启动路径实测（`apps/api dev`，非 buildApp 直构）：修复前保存 `BENCH_JUDGE_DSH_PROVIDER=command-code` 后 API 仍读到 `deepseek-official`；修复后同一进程立即读到新值，且 `.env` 键的 source/shadowed 全部为 `file`/`false`。
- 反向验证：以真实 OS 变量 `BENCH_DSH_PRESETS=standard` 启动 API，仍正确报告 `source: environment`、`shadowed: true`。
- 新增守卫测试直接从启动脚本读事实（`scripts.dev` 不得含 `--env-file`），并断言「只有 .env 有值时保存后同进程立即生效」；把该标志加回去，该用例失败，去掉后通过。
- `app.test.ts` 与 `config.test.ts` 共 20 项通过；`launches.test.ts` 27 项通过；全量连跑 4 轮各 348 项通过（此前该竞态约每 5 轮失败 1 次）。
- `pnpm check` 通过、`pnpm test:e2e` 7 项通过。