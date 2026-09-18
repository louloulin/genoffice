# GenOffice AI Chat Input — Workbuddy 风格统一计划

## 目标
把 5 个 app 的 chat input 统一到 packages/ui 共享的 AiComposer，对齐 Cursor/ChatGPT/Genspark/workbuddy 的最佳实践。
高内聚低耦合：packages/ui 提供 composer 逻辑 + palette UI；每个 app 只注入自己的命令表 / mention 列表 / 上下文数据。

## 当前状态（基线）
✅ 已实现：auto-grow textarea · Enter/Shift+Enter · send/stop morph · slash palette ·
mode switch (Ask/Craft/Plan) · skill chip · voice (Web Speech) · onEditLast ·
attachment tray · drag/paste files

❌ 缺口：@ mention picker · token counter · slash trigger button ·
suggestion chips · Cmd-K global palette · model picker 统一 ·
voice hook 提取 · 仅 slides 没用 AiComposer（自写 textarea）

## Phase 1 — packages/ui 共享 Composer 增强
1.1 `chat/mentions.ts` — MentionEntry model + activeMentionQuery 检测
1.2 `AiMentionMenu.tsx` — mention palette（复用 AiComposerMenu 的 listbox）
1.3 `AiComposer.tsx` 新增 props: `mentions`/`onMentionPick`/`mentionMenu*`/`mentionTrigger`
1.4 `SuggestionChips.tsx` — 回复下方的 follow-up chips
1.5 `chat/useVoiceInput.ts` — 把 docs 的 voice 逻辑抽成 hook
1.6 `chat/useEditLast.ts` — 通用 last-message 反向查找 hook
1.7 `chat/useTokenCounter.ts` — token 估算 + 阈值配色
1.8 AiComposer footer 显示 token counter（绿/黄/红）
1.9 AiComposer 在 textarea 为空时显示 `/` 触发按钮（点击打开 palette）
1.10 `chat/types.ts` 增加 `SuggestionEntry` / `MentionKind` / `MentionToken` 等公共类型

## Phase 2 — 5 个 app 统一接入
2.1 `pdf/src/renderer/ai/composer-commands.tsx` + 接线 AiPanel
2.2 `markdown/src/renderer/ai/composer-commands.tsx` + 接线
2.3 `html/src/renderer/ai/composer-commands.tsx` + 接线
2.4 `slides/src/renderer/ai/AiPanel.tsx` — 迁移自写 textarea → AiComposer
2.5 docs / sheets — 加 @ mention + token counter + slash 按钮

## Phase 3 — 验证 + 上线
3.1 packages/ui 新增单元测试（mentions、token counter、voice hook）
3.2 `tsc --noEmit` 通过 6 个 app + packages
3.3 `vitest run` 全绿
3.4 build docs/sheets/slides/pdf/markdown/html
3.5 webserver smoke test：启动 + 5 个 app 路由 + healthz
3.6 commit + push

## 设计约束
- **零侵入**：现有 docs/sheets 已接的功能（slash/mode/voice/edit-last）保持不动
- **单一来源**：AiComposer 是所有 app 的唯一入口；slide 的自写 textarea 必须迁移
- **app 只注入数据**：commands/mentions/modeRef 是数据；palette UI 在共享组件里
- **测试覆盖**：每个新功能先有 vitest case，再接 app
- **i18n 严格 20 shard**：新 key 必须 zh canonical → Record 校验

## 风险
- slides 自写 textarea 行为耦合（onCompositionStart、inputEditedSinceRunRef、deck-undo），
  迁移时要保留这些 hooks，不能直接替换
- mention picker 在 IME 下要保持 slash 行为（composing 时不弹）
- token counter 不能让 200k char 的粘贴把 UI 卡死（debounce + cap）

