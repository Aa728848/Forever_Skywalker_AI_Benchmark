# Agent Note: GitHub 公开预览发布

Status: implemented

## Problem

用户要求提交全部项目改动并发布 GitHub，随后明确选择公开仓库。当前 Git 历史尚无远程，发布目标为 Aa728848/Forever_Skywalker_AI_Benchmark。

## Decision

保留本地历史与当前 master 分支，提交所有项目源码、题目、受信资产和文档；按 .gitignore 排除私有 .env、依赖安装目录、测试运行数据和构建输出。使用 v0.1.0-preview.1 预览标签，明确真实模型及评分校准仍待完成。

发布审查发现通用 dist/ 规则遗漏 INT-WEB 的固定 YAML 离线依赖。新增仅针对该 vendor 目录的例外，使干净检出与本机工作区拥有同一组必需题目资产；其它构建目录仍按原规则排除。

## Alternatives considered

不使用强推、重写历史或删除现有提交。尚未完成校准，不能将此预览冒称正式评分发布。也不能直接复制整个本地目录上传，否则会混入凭据或机器运行产物。

## Consequences

发布包含全部题目源码、公开检查和受信验证资产。使用 benchmark 作答时仍只向被测 AI 导出独立题目工作区，避免接触评分资产。来源模块保留原有许可证，未统一重新授权。GitHub 托管源码和预览版本，不自动部署需要本机 Docker 的评测服务。

## Verification

- 当前待发布文件及47个本地提交历史的高置信凭据检查未发现真实密钥；.env/data/node_modules未跟踪。
- 已创建公开仓库 https://github.com/Aa728848/Forever_Skywalker_AI_Benchmark ，保留当前 master 与既有历史。
- 补齐153个 YAML dist 文件，连同许可证和元数据共155个文件的声明哈希全部一致；行尾检查未发现来源源码、DLL或61份参考/缺陷补丁的字节变更。
- 从 Git 暂存树 e1036b68082365e3d193576f7283ba9bc4b55a85 导出独立临时目录，确认无.env且YAML运行时存在；按锁文件安装依赖与供应链校验通过。
- 干净目录中 `pnpm check` 198/198、类型/目录/构建，`pnpm test:e2e` 2/2，`pnpm task:verify INT-WEB` 6/6检查阶段均通过。之后仅更新发布文档，不改变程序与题目资产。
- 预览发布使用 v0.1.0-preview.1；远程 master、标签及 GitHub Release URL 作为最终公开发布凭据。
