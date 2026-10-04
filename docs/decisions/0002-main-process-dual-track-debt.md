# 0002 — 主进程双轨债：shell 主进程 vs web-server

- **编号**：0002
- **状态**：登记 · 择机收敛
- **登记日期**：2026-10-04
- **登记 change**：enterprise-office-ai

## 现状

同一套 channel/IPC 契约在两个宿主里各有一份实现：

| 宿主 | 位置 | 规模（本次统计） |
|---|---|---|
| 桌面（Electron） | `apps/shell/src/main` | **7,668 行** TypeScript |
| Web（浏览器 / 嵌入） | `apps/web-server/src` | **538 个** 注册的 channel handler |

- **`WEB_UNSUPPORTED` 桩：29 处**——这些 channel 在 web 宿主上显式标为"不支持"，渲染层走桩返回。
- 两个宿主共享部分 `packages/*`（document-store、ipc-bridge 等），但**主进程 / 服务端的通道编排各写一遍**。

## 影响

1. **漂移**：同一 channel 在两端的行为可能不一致；修复一侧常需手工同步另一侧。
2. **Web 平权缺口**：29 个 `WEB_UNSUPPORTED` 即 29 个"桌面有、Web 无"的能力，直接影响
   Dataflare 式嵌入宿主的可用面。
3. **测试面**：web-server 已有 167 个测试文件覆盖其通道，shell 侧的等价覆盖更薄。

## 建议（收敛方向，非本 change 范围）

1. **确立 web-server 为契约参考实现**：新 channel 先在 `packages/*` 定义纯逻辑，再由两个宿主
   薄封装，避免编排逻辑复制。
2. **逐条消灭 `WEB_UNSUPPORTED`**：把 29 处作为可跟踪清单，按业务价值排序，能下沉到 `packages/*`
   的优先下沉。
3. **量化看板**：把 "shell 行数 / web-server handler 数 / WEB_UNSUPPORTED 数" 作为持续指标，
   收敛以指标下降为准，而非一次性大重构。

## 为什么不在本 change 内做

- enterprise-office-ai 的架构声明是"全部基建位于边界层，对 agent 实现零侵入"；主进程双轨是**跨宿主的
  结构性重构**，与本次企业级 AI 基建正交。
- 大重构会淹没本 change 的验收信号（77 项验收），违反"不扩大范围"。

## 触发条件

- 新增能力反复需要在两个宿主各写一遍且已出现行为漂移。
- 嵌入宿主（Dataflare 式）明确要求某 `WEB_UNSUPPORTED` 能力。
- 有独立排期窗口承接结构性重构。
