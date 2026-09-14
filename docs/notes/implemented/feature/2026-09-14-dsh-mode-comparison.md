# Agent Note: DSH 单命令模式对比

Status: implemented

## Problem

用户认为逐次导出题目、切换 DSH 会话、提交及手工选取报告过于繁琐，希望用更简单的方式比较 DeepSeek 模型不同模式。

## Decision

复用 DSH 已有 TypeScript SDK，新增单命令入口，默认同一模型 Off/High 配对作答。每次独立工作区和会话，串行执行且按重复轮次交换模式顺序；只有明确完成才进入现有 Linux 冻结评分管线。每次状态变化保存 JSON 和中文 Markdown。

提取已有 inspectRunSelection 以共享受信执行/裁判身份校验，原分级与重复题拒绝语义不变。模式表保留全部预定作答，缺测为 null，核心与来源集成题单列；不改评分核心或题包。SDK 子环境移除 BENCH_* 和 Node 注入变量，凭据由显式 DSH home 的既有配置负责。

## Alternatives considered

直接控制 DSH Web 界面需要持续依赖页面和交互状态；重新实现 agent 或 stdio 协议会扩大维护范围。现有同版本 SDK 已提供收题、完成区间与进程关闭，因此仅增加编排。当前不增加新 Web 表单或持久调度服务。

## Consequences

用户指定模型后即可自动作答、验证并查看模式表；已有中文面板仍展示逐次评分。支持推理等级比较，未复刻 Web 插件集合或计划模式审批。SDK 未提供完整可计费 usage 和可靠供应商返回模型，相关字段保持缺失。Windows DSH 的回收范围仅确认 SDK 运行时；Linux 容器负责评分隔离。真实模型调用仍由用户启动，发布校准未完成。

## Verification

- DSH 适配器、比较编排和评分汇总定向测试 14/14 通过：含模拟完成/错误/超时/取消、环境变量隔离、回收失败停止、全新会话与目录、真实本地参考/缺陷评分以及跨裁判身份拒绝。
- 本地预检发现 DSH SDK/CLI 0.1.5-rc.1、固定 Linux 镜像可用；裁判未配置。模型调用为 0。
- 补充“最后一次评分返回时取消”回归；最终 `pnpm check` 通过类型检查、55题目录一致性、14个文件185项测试及 Web 生产构建。
- 最终 `pnpm dsh:compare --model deepseek-v4-flash --check` 通过，含实际 SDK 动态导入；未启动 DSH、未发送模型请求。真实 DSH 初始化/作答、裁判认证和统计校准未运行。
