# 0003 — 桌面端 API key 明文债（Electron safeStorage）

- **编号**：0003
- **状态**：登记 · **明确非目标**（见 A39）
- **登记日期**：2026-10-04
- **登记 change**：enterprise-office-ai

## 现状

| 存储位置 | 内容 | 现状 |
|---|---|---|
| web-server `DATA_DIR/ai-settings.json` | provider `apiKey` | **已加密**（AES-256-GCM，`common/secret-store.ts`，本次 change 交付 A4/A36/A37/A38） |
| 渲染层 `localStorage`（六应用） | AI settings（含 `apiKey`） | **明文** |
| 桌面 `userData/app-settings.json` | 非密偏好（analytics、路径等） | 明文（不含 key；`apps/shell/src/main/app-settings.ts` 定义的是扁平非密对象） |
| Electron `safeStorage` | — | **0 处引用**（全仓 `grep -rn safeStorage` 为空） |

要点：**服务端一侧的密钥已加密落盘并在读取 API 上 redacted**；缺口集中在**桌面/渲染层仍把
`apiKey` 以明文写进 `localStorage`**，且未启用 Electron 的 `safeStorage`（OS 级凭据加解密）。

## 影响

- 桌面端用户机器上，明文 `apiKey` 可被同机进程 / 备份 / 同步盘读取。
- 与已加固的服务端侧形成**不一致的安全基线**：同一套设置在两处一密一明。

## 为什么是明确非目标（重要）

- A39 原文即把"桌面端明文 localStorage 已登记债（Non-goal），不在本 capability 内"写入验收范围。
- enterprise-office-ai 的目标是**服务端 / 嵌入优先**；桌面渲染层的持久化改造属于 Electron 宿主
  的独立工作面，硬塞进本 change 会扩大范围并掩盖 77 项验收信号。

## 建议（若将来启动）

1. 桌面主进程接管密钥持久化：渲染层**不再**写 `apiKey` 到 `localStorage`；改为主进程经
   Electron `safeStorage.encryptString` 落盘（`app-settings.json` 或独立密钥文件）。
2. 迁移既有明文：首次升级时读取旧 `localStorage` 值 → 加密入库 → 清除明文键。
3. Web（浏览器）宿主**无** `safeStorage`：维持"密钥不下发渲染层、由服务端代理持有"的嵌入姿态
   （本次 change 已实现，见 A2/A5/A38），浏览器侧不落明文 key。
4. 与服务端 `secret-store.ts` 的 keyId/轮换语义对齐，避免两套加密生命周期。

## 触发条件

- 桌面端被纳入安全基线要求（合规 / 客户审计）。
- 出现明文 `localStorage` key 的实际泄露事件。
- 有独立排期承接 Electron 宿主改造。
