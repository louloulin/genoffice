# 决策记录（Decision Records）

> 本目录登记**已识别但暂不实施**的架构债务与迁移决策。与 `docs/rfcs/` 不同：RFC 描述将要落地的
> 协议级设计（含 14 天评审窗口），这里只做**事实登记**——编号、现状、影响、建议与触发条件。
> 每条一旦启动实施，应在 RFC 或实现 PR 中升级为正式设计。

## 索引

| 编号 | 标题 | 状态 | 登记的 change |
|---|---|---|---|
| [0001](./0001-pi-agentization-assessment.md) | pi 化评估（agent 实现向 pi 迁移） | 登记 · 暂不实施 | enterprise-office-ai |
| [0002](./0002-main-process-dual-track-debt.md) | 主进程双轨债（shell vs web-server） | 登记 · 择机收敛 | enterprise-office-ai |
| [0003](./0003-desktop-safestorage-debt.md) | 桌面 API key 明文债（safeStorage） | 登记 · 明确非目标 | enterprise-office-ai |

## 约定

- 编号 `NNNN` 单调递增，删除后不重用。
- 每篇必须写清：**编号 · 现状（含可核验的数字）· 影响 · 建议 · 触发条件**。
- 登记不等于承诺排期；触发条件满足时再立项。
