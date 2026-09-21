# postMessage 协议 v1.0

宿主页面与嵌入 iframe 之间的线协议格式。

## 信封

任意方向的所有消息都使用同一形状：

```ts
interface Envelope {
  v: '1.0'
  dir: 'host→editor' | 'editor→host'
  kind: 'event' | 'command' | 'command-result'
  correlationId?: string   // command / command-result 必填
  payload: unknown
}
```

## 出站事件（`editor → host`）

| `payload.name` | 触发时机 |
|---|---|
| `ready` | iframe 已启动。 |
| `saved` | 一轮保存往返完成。 |
| `dirtyChanged` | 编辑缓冲区状态变更。 |
| `selectionChange` | 光标或选区移动。 |
| `error` | 可恢复的错误。 |
| `closed` | 编辑器关闭（返回导航或显式关闭）。 |

## 入站命令（`host → editor`）

`payload` 形如 `{ name, args }`。编辑器**必须**回复一条带相同 `correlationId` 的 `command-result` 信封。

| 名称 | 参数 |
|---|---|
| `setTheme` | `{ theme }` |
| `setLang` | `{ lang }` |
| `setMode` | `{ mode }` |
| `setContent` | `{ text?, html?, immediate? }` |
| `getContent` | (无) → `{ text?, html?, bytes? }` |
| `insertImage` | `{ url, width?, height?, alt? }` |
| `insertText` | `{ text }` |
| `print` | (无) |
| `focus` | (无) |
| `aiRewrite` | `{ instruction, selection? }` |
| `aiTranslate` | `{ target, source? }` |
| `aiSummarize` | `{ length? }` |

## Origin 校验

SDK 仅接收满足 `event.source === iframe.contentWindow` 且 `event.data.v === '1.0'` 的入站 `postMessage`。嵌入端以 `targetOrigin: '*'` 向 `window.parent` 发送 `ready` — 宿主页面应通过 CSP 的 `frame-ancestors` 指令限制访问。

## 版本策略

信封版本 `1.0` 在 v1 契约生命周期内冻结。新增 `kind` 值或 `payload.name` 值是非破坏性的；重命名或删除既有值才是破坏性变更。
