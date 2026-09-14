# Agent Note: DSH 原始预设选择与报告后清理

Status: implemented

## Problem

用户要求裁判思考等级通过 .env 配置；自动作答命令支持标准、PTC、极简、创造，并独立调整模型与思考等级；报告输出到指定位置后清理其它本次运行产物。

## Decision

裁判现有 BENCH_JUDGE_REASONING_EFFORT/THINKING 映射已满足，补充 dotenv 到两轮请求的回归和配置示例；本机 .env 只追加缺失字段，保留既有值和凭据。

DSH SDK 没有原生 agentPreset initialize 字段，使用公开 launch patches、Agent preset mount/composeFrom 以及首条消息前的 agent/created 接入原始预设。标准、PTC、极简、创造实际 ID 分别为 standard、ptc、minimal、cordis。保存请求预设、实际选择事件和源预设指纹；选择未证实不能当作完成，同一预设发生变更则停止比较。

新增预设、单个思考等级与报告输出选项，保留既有 --modes 多思考等级接口。预设和思考等级形成独立组合，固定一个模型，保持各组合分别计分。每个实验使用独占临时根和 RunStore，DSH 会话/存储/附件/新预设输出重定向本次 scratch。最终作答、评分、裁判及分级证据打包 gzip JSON，逐文件和压缩文件回读校验，报告保存成功后才删除临时根。

## Alternatives considered

把工具模式标签改名不能产生四种真实预设；向 SDK 发不支持的初始化字段也无效，因此使用源码明确支持的 preset 作用域组合。删除共享 RunStore 会留下悬空索引，清扫共享 DSH home 会影响原配置和历史会话，因此仅清理带所有权标记的独占临时根。压缩 JSON 使用 Node 内置 zlib，不增加打包依赖。

## Consequences

正常结束（含已回收的失败/取消作答）只留下 report.md、experiment.json、evidence.json.gz。完整压缩证据可独立复核，比较不再写入默认 Web 的历史运行列表。回收未确认、写入/复制/校验失败或异常目录链接保留现场并明确报告，不能冒报清理完成。

原 DSH home 仍提供配置与认证，DSH 可能维护 profile 或迁移旧凭据，原配置不作为临时数据删除。SDK 回收只证明拥有的运行时退出，不证明所有脱离工具进程均退出。未调用真实作答模型或裁判，发布校准继续待定。

## Verification

- 裁判 providers.test.ts 42/42：dotenv 参数 high/max/disabled 正确进入两轮请求并区分指纹，无效组合拒绝。
- DSH adapter 13/13：原始预设资产、实际事件、初始化参数、取消/超时/回收与路径归属。
- 真实 DSH SDK 对 127.0.0.1 假 SSE：四预设各1次均 completed，工具数量为26/1/1/33，实际发送 deepseek-v4-flash、reasoning_effort=high、thinking.enabled；临时 home/workspace/runtime、HTTP 服务及 SDK 运行时全部关闭清理。验收代码通过 stdin 执行，没有遗留脚本或外部模型调用。
- 归档/清理与编排首轮定向8/8：含 Windows junction 拒绝、错误所有权、证据独立回读、输出失败保留、失败代码归档和最后评分阶段取消。
- 最终 `pnpm check` 通过：15个测试文件198项测试、类型检查、55题目录一致性、Web生产构建；包含同一思考等级下不同预设独立评分与预设指纹漂移回归。
- Windows CLI 首次预检发现 pnpm 的 PowerShell shim 将逗号列表转为空格，已针对性修复列表解析。四预设统一 High、中文“创造”与多题/多思考列表两种命令预检均通过，预检临时目录已自动清理，模型调用0。
