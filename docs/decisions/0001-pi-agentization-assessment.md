# 0001 — pi 化评估：agent 实现向 pi 的迁移边界

- **编号**：0001
- **状态**：登记 · 暂不实施
- **登记日期**：2026-10-04
- **登记 change**：enterprise-office-ai

## 现状

GenOffice 的 agent 能力目前是**部分采用** pi（`@earendil-works/pi-*`），并非自研，也并非全面 pi 化：

| 包 | 角色 | 与 pi 的关系 |
|---|---|---|
| `packages/agent-core` | ReAct 循环（`loop.ts`）、skill 适配器 | **自研**，不依赖 pi |
| `packages/agent-runtime` | Office 应用会话封装 | 依赖 `pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-session-backend-sqlite-node` ^0.85.1 |
| `packages/agent-session` | 会话后端 | 依赖 `pi-agent-core` / `pi-session-backend-sqlite-node` ^0.85.1 |
| `packages/agent-telemetry` | span 导出 | 依赖 `pi-agent-core` / `pi-telemetry` ^0.85.1 |

即：**会话生命周期、编码 agent SDK、遥测协议已站在 pi 之上**；而 ReAct 主循环与工具契约仍是自研。

## 收益

- 上游 SDK 持续演进（工具调用、压缩、会话后端），自研部分随之减少。
- 与 pi 生态（扩展、telemetry、session backend）原生一致，降低胶水层。
- 本次 change 的 `agent-core/src/skill.ts` 适配器（A20/A66）已把 marketplace `SkillPackage`
  映射为 AgentLoop 工具——这是自研循环与 pi 工具协议对齐的第一步，迁移成本会随之下移。

## 风险

- **外部版本耦合**：`^0.85.1` 的语义版本漂移会直接进入运行时。已有真实案例——本机开发者全局
  pi 扩展 `pi-goal-x` 在会话 UI 上下文缺少 `ctx.ui.setStatus` 时抛未捕获异常，导致
  `@genoffice/agent-runtime` 的 vitest 非零退出（仓库外环境问题，非本 change 引入，详见
  `enterprise-office-ai` 的验证记录）。外部扩展的破坏面不可控。
- **自研循环质量高**：`agent-core/loop.ts` 已实现历史压缩、三类退化守卫、出站脱敏，且被
  A58 明确要求**本 change 内不得修改**。贸然替换会丢失这些经过验证的行为。
- **边界不应动摇**：所有企业级基建（认证/租户/配额/审计/加密/重试）已刻意做在 web-server 的
  HTTP/IPC 边界层，对 agent 实现零侵入。迁移 agent 内部实现不应穿透这层边界。

## 迁移边界（若将来启动）

1. 以 `packages/agent-runtime` 为**唯一接缝**：外部只经它触达 pi，`agent-core` 的自研循环可
   在接缝之后逐步替换为 pi 循环，调用方无感。
2. **不改边界层**：web-server 的 HTTP/IPC 与 packages 的协议层保持零侵入（与 enterprise-office-ai
   的架构声明一致）。
3. 先对齐**工具契约与遥测**（已由 A20/A66 适配器起步），再动主循环。
4. 任一阶段都要有回滚点：自研 `loop.ts` 保留在树内，直到 pi 循环通过等价的行为回归。

## 建议

**暂不全面迁移**。保持 `agent-core/loop.ts` 自研（本 change 亦不修改它，见 A58）；以
`agent-runtime` 为接缝继续局部采用 pi；待工具契约/遥测对齐稳定后，再立项评估主循环替换。

## 触发条件（满足其一即重新立项）

- pi 工具/SDK 契约稳定且版本进入 `1.x` 承诺。
- 自研循环的维护成本超过接缝替换成本（以季度人力衡量）。
- 需要 pi 独有的循环能力，自研无法低成本补齐。
