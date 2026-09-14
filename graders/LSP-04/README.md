# LSP-04 受信资产

来源：cwtools-vscode/src/LSP/JsonRpcProtocol.Tests.fsx、cwtools-vscode/src/LSP/DocumentStore.Tests.fsx、cwtools-vscode/src/Main/RefreshLockIntegration.Tests.fsx。

公开检查覆盖主要契约，隐藏检查改变输入规模、边界与交错；不引入题面之外的要求。参考与替代实现使用不同的数据组织或控制流程。

使用 node scripts/task.ts verify LSP-04 运行缺陷、参考补丁与替代实现的公开/隐藏六阶段检查。受信资产不向候选导出。
