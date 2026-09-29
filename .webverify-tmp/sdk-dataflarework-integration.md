# GenOffice × DataflareWork 通过 SDK 接入 — 全面分析

> **分析对象**：
> - GenOffice `@genoffice/web-sdk` 0.9.0-beta.1（apps/sdk/）
> - GenOffice `apps/web-server` 0.8.0（HTTP IPC + SSE + 翻译管道）
> - GenOffice `apps/docs/src/shared/embed-bridge.ts`（iframe ↔ host 桥接，已实现但未发布为 SDK）
> - DataflareWork `frontend/src/views/ai/OfficeWorkspaceView.vue` + `frontend/src/utils/officeWorkspace.ts`（host 实现）
> - DataflareWork `backend/.../OfficeEngineProxyController.kt` + `OfficeEngineCookieAuthFilter`（反向代理 + Cookie 鉴权桥）
>
> **当前状态**：GenOffice 端骨架（iframe + postMessage envelope + 反向代理 `/office-engine/**` + Cookie 鉴权 + SSE 透传 + 多租户翻译记忆）**全部就位**；SDK 缺少 Dataflarework 专用 helper；bridge 代码还在 `apps/docs/src/shared/`（未发布到 `@genoffice/web-sdk`）。

---

## 0. 一句话结论

**DataflareWork 已经把 GenOffice 当作 "AI 文档编辑/翻译内核" 使用了**——通过三层栈：
1. **同源 iframe 嵌入** `/office-engine/docs/?embed=1`
2. **postMessage v1 envelope**（`genoffice-dataflare/v1`）跨上下文双向通信
3. **Cookie 鉴权桥**（`Manager-Office-Token`）让 iframe 内的 EventSource / fetch 自动认证

但这条链路上 **SDK 还没把 GenOffice 端桥接代码暴露出来**，DataflareWork 必须在它自己的前端写一整套 postMessage plumbing。这正是"通过 SDK 接入"要解决的核心：**让 DataflareWork host 端只需要 `import { createDataflareHost } from '@genoffice/web-sdk'` 三行就上墙**，而不是手写 400+ 行 envelope 处理。

---

## 1. 现有集成的全栈解剖（已就位部分）

### 1.1 GenOffice iframe 端（已实现，未发布）

`apps/docs/src/shared/embed-bridge.ts` 已经实现了完整的双向桥：

```ts
// 已存在但只在 apps/docs 内部用
export const DATAFLARE_EMBED_PROTOCOL = 'genoffice-dataflare/v1'

export type DataflareEmbedCommand =
  | { type: 'init'; context: DataflareOfficeContext; sessionId: string }
  | { type: 'set-readonly'; readonly: boolean }
  | { type: 'focus-ai'; prompt?: string }
  | { type: 'translate'; scope: 'selection'|'document'; sourceLanguage?; targetLanguage; preserveFormatting?; memoryEnabled?; qualityCheck?; glossaryCategory? }
  | { type: 'save' }
  | { type: 'dispose' }
  | { type: 'cancel-translation' }
  | { type: 'global-state-update'; state: DataflareGlobalState; revision? }

export type GenOfficeEmbedEvent =
  | { type: 'ready'; capabilities: string[] }
  | { type: 'document-dirty'; documentId? }
  | { type: 'document-saved'; documentId?; revision? }
  | { type: 'ai-progress'; requestId?; status; progress? }
  | { type: 'error'; code; message }
  | { type: 'global-state'; state; revision? }
  | { type: 'global-state-request'; revision? }
```

7 个信封种类：
| `kind` | 方向 | 用途 |
|---|---|---|
| `command` | host → editor | 业务命令（init / translate / save / focus-ai 等） |
| `event` | editor → host | 业务事件（ready / dirty / saved / progress / error） |
| `request` | editor → host | 让 host 代理一次 HTTP 请求（带 bytes 透传） |
| `response` | host → editor | 对 request 的回包（ArrayBuffer body） |
| `stream-request` | editor → host | 启动一次 SSE 代理（按 event 转发） |
| `stream-event` | host → editor | 单个 SSE 事件 |
| `stream-close` | host → editor | SSE 流结束（带 status） |

**这是完整的 RPC + pub/sub + HTTP proxy + SSE proxy 四件套**。

### 1.2 GenOffice web-server 端（已实现 + 上一轮已修）

- `POST /api/embed/nonce`（v1）：签发 `{sessionId, nonce, expiresAt}`
- `DELETE /api/embed/nonce`（v1）：释放 nonce session
- `POST /api/embed/verify-nonce`（v1）：host 端在 iframe ready 时校验 nonce 防 CSRF
- `GET /embed/<docId>?token=…&nonce=…&sessionId=…`：服务 HTML + Set-Cookie `auth_token` + nonce meta tag + bridge `<script>` 注入
- `POST /api/ai/translate/stream`：SSE 返回 `start → unit → quality → complete | error`
- `POST /api/ai/stream`：SSE Agent Loop 流
- `POST /api/ai/translate/stream/cancel`：按 `requestId` 取消

### 1.3 DataflareWork host 端（已实现，前端 Vue）

`frontend/src/views/ai/OfficeWorkspaceView.vue`：
- 渲染 `<iframe src="/office-engine/docs/?embed=1&documentId=…">`
- 监听 `message` 事件，处理 `genoffice-dataflare/v1` envelope
- 暴露 UI 按钮：AI 助手 / 保存文档 / 翻译选区 / 翻译全文 / 取消翻译
- 实时翻译预览条（每 unit 增量更新原文/译文 + 记忆命中标签）

`frontend/src/utils/officeWorkspace.ts`：
- `buildOfficeWorkspaceRoute(input)` → `{name:'AIOfficeWorkspace', query:{documentId, source, type, readonly}}`
- `syncOfficeEngineSessionCookie(token)` → `document.cookie = 'Manager-Office-Token=<token>; Path=/office-engine; SameSite=Lax'`
- `OFFICE_ENGINE_PATH_PREFIX = '/office-engine'`
- `OFFICE_ENGINE_SESSION_COOKIE = 'Manager-Office-Token'`

### 1.4 DataflareWork 反向代理（已实现，后端 Spring/Kotlin）

`backend/.../controller/OfficeEngineProxyController.kt`：
- 挂载 `/office-engine/**`
- 透传所有请求到 GenOffice web-server（保留 `Manager-Office-Token` Cookie → 还原 `Manager-Token` Header）
- 显式区分 SSE 流（`text/event-stream`）走 `StreamingResponseBody`，避免缓冲
- 不向 GenOffice 透传 `Manager-Token`（防止 token 泄露到上游日志）

`backend/.../config/security/filter/OfficeEngineCookieAuthFilter`：
- 拦截 `/office-engine/api/**`
- 把 `Manager-Office-Token` Cookie → `Manager-Token` Header
- 走现有 Spring Security 规则

---

## 2. 通过 SDK 接入要做的事（精确清单）

### 2.1 把 `apps/docs/src/shared/embed-bridge.ts` 升级为 `@genoffice/web-sdk` 一等公民

**当前路径**：`apps/docs/src/shared/embed-bridge.ts`
**目标路径**：`apps/sdk/src/dataflare-host.ts` + `apps/sdk/src/dataflare-guest.ts`

**操作**：
1. 在 `apps/sdk/src/index.ts` 新增：
   ```ts
   export {
     createDataflareHost,        // host (DataflareWork 侧) 用
     createDataflareGuest,       // guest (GenOffice iframe 侧) 用
     // 类型
     DataflareEmbedCommand,
     GenOfficeEmbedEvent,
     DataflareParentRequest,
     DataflareParentResponse,
     DataflareParentStreamRequest,
     DataflareParentStreamEvent,
     DataflareOfficeContext,
     DataflareGlobalState,
   } from './dataflare-protocol'
   ```
2. 内部按 host/guest 拆：
   - `dataflare-host.ts`：`createDataflareHost({ iframe, sessionId, token, onCommand })` 返回 `{postEvent, sendRequest, sendStreamRequest, destroy}`
   - `dataflare-guest.ts`：`createDataflareGuest({ sessionId, capabilities, onCommand })` 返回 `{postEvent, sendRequest, sendStreamRequest, destroy}`

**好处**：
- DataflareWork 端不再手写 `window.addEventListener('message', ...)` + envelope 校验
- 自动处理 `event.source === iframe.contentWindow` 和 `event.origin` 双校验
- 60s request timeout 自动管理
- SSE 流自动 cleanup on close

### 2.2 在 SDK 里加 `buildDataflareHostPage()` helper

**目标**：DataflareWork 端只需一个组件，不需要懂 iframe 装载。

```ts
// SDK 新 API
export async function buildDataflareHostPage(input: {
  baseUrl: string          // 例: '/office-engine'
  documentId: string
  documentType: 'docx' | 'xlsx' | 'pptx'
  token: string            // 当前 Dataflare 登录 token
  readonly?: boolean
  locale?: string
  theme?: 'light' | 'dark' | 'system'
}): Promise<{
  iframeUrl: string
  sessionId: string
  syncCookie: () => void   // 调一次 syncOfficeEngineSessionCookie
  // 后续用 createDataflareHost 接管通信
}>
```

**内部**：
1. POST `/api/embed/nonce`（走 v1 REST，需 JWT）→ 拿 `{sessionId, nonce, expiresAt}`
2. POST `/api/embed/verify-nonce` → 二次确认（host 端 handshake 第一段）
3. 构造 iframe URL = `${baseUrl}/docs/?embed=1&documentId=${id}&nonce=${nonce}&sessionId=${sessionId}&token=${token}&lang=${locale}&theme=${theme}`
4. 返回 `{iframeUrl, sessionId, syncCookie}` 三件套

### 2.3 在 SDK 里加 `runDataflareTranslation()` Observable 流

**目标**：DataflareWork 端拿翻译结果就像 RxJS Observable 一样用。

```ts
// SDK 新 API
import type { Observable } from 'rxjs'  // peer dep

export interface DataflareTranslationOptions {
  baseUrl: string                // '/office-engine'
  sessionId: string               // 来自 buildDataflareHostPage
  scope: 'selection' | 'document'
  sourceLanguage?: string
  targetLanguage: string
  units: Array<{ unitId: string; sourceText: string }>
  glossaryCategory?: string
  memoryEnabled?: boolean
  qualityCheck?: boolean
  preserveFormatting?: boolean
  signal?: AbortSignal
}

export interface DataflareTranslationEvent {
  type: 'start' | 'unit' | 'quality' | 'complete' | 'error'
  requestId: string
  // ... 各 type 字段
}

export function runDataflareTranslation(
  host: DataflareHostHandle,
  options: DataflareTranslationOptions,
): Observable<DataflareTranslationEvent>
```

**实现要点**：
- 内部用 `host.sendStreamRequest({method:'POST', path:'/api/ai/translate/stream', jsonBody:...})` 走 stream-request envelope
- 解析 SSE `event: start | unit | quality | complete | error`
- `AbortSignal` 触发 `host.sendStreamRequest(... {action:'cancel'})`
- 输出 `Observable<DataflareTranslationEvent>` —— DataflareWork 在 Vue 里用 `from(observable).subscribe(...)` 或直接 `subscribe()` 一行

### 2.4 在 SDK 里加 `runDataflareAgent()` 流

同上结构，对应 `/api/ai/stream`：

```ts
export interface DataflareAgentOptions {
  baseUrl: string
  sessionId: string
  messages: Array<{ role: 'system'|'user'|'assistant'; content: string }>
  tools?: Array<{ name: string; description: string; parameters: object }>
  maxTokens?: number
  signal?: AbortSignal
}

export interface DataflareAgentEvent {
  type: 'text' | 'tool-call' | 'tool-result' | 'done' | 'error'
  requestId: string
}

export function runDataflareAgent(
  host: DataflareHostHandle,
  options: DataflareAgentOptions,
): Observable<DataflareAgentEvent>
```

### 2.5 在 SDK 里加 `registerDataflareCommandHandler()`

```ts
// Host 端注册业务命令处理
host.registerCommandHandler('translate', (cmd) => {
  // DataflareWork 的业务逻辑：开 dialog、跑 runDataflareTranslation、上报 progress
})

host.registerCommandHandler('save', async (cmd) => {
  // 调 Dataflare 自己的 save API，然后 host.postEvent({type:'document-saved', revision})
})

host.registerCommandHandler('focus-ai', (cmd) => {
  // 在 DataflareWork 侧打开 AI 助手面板
})
```

---

## 3. DataflareWork host 端集成流程（用 SDK 后）

### 3.1 最小集成（5 步）

```ts
// 1. 安装
pnpm add @genoffice/web-sdk rxjs

// 2. iframe 装载
import { createDataflareHost, buildDataflareHostPage } from '@genoffice/web-sdk'

const page = await buildDataflareHostPage({
  baseUrl: '/office-engine',
  documentId: props.documentId,
  documentType: 'docx',
  token: userStore.token,
})

page.syncCookie()  // Manager-Office-Token Cookie 已设置

iframeRef.value.src = page.iframeUrl

// 3. 创建 host
const host = createDataflareHost({
  iframe: iframeRef.value,
  sessionId: page.sessionId,
  baseUrl: '/office-engine',
  token: userStore.token,
  onReady: (caps) => { ready.value = true },
  onDirty: (e) => { dirty.value = true },
  onSaved: (e) => { dirty.value = false },
  onError: (e) => { ElMessage.error(e.message) },
})

// 4. 注册业务命令
host.registerCommandHandler('translate', async (cmd) => {
  const translation$ = runDataflareTranslation(host, {
    baseUrl: '/office-engine',
    sessionId: page.sessionId,
    scope: cmd.scope,
    sourceLanguage: cmd.sourceLanguage,
    targetLanguage: cmd.targetLanguage,
    glossaryCategory: cmd.glossaryCategory,
    units: extractUnits(doc),  // 你自己的取段逻辑
  })
  translation$.subscribe({
    next: (e) => updateProgress(e),
    complete: () => host.postEvent({type:'document-saved', revision: newRev}),
  })
})

// 5. 卸载清理
onUnmounted(() => host.destroy())
```

### 3.2 完整集成（覆盖所有 envelope 类型）

```ts
import {
  createDataflareHost,
  buildDataflareHostPage,
  runDataflareTranslation,
  runDataflareAgent,
  type DataflareHostHandle,
} from '@genoffice/web-sdk'

export default defineComponent({
  setup() {
    const iframeRef = ref<HTMLIFrameElement>()
    const host = ref<DataflareHostHandle | null>(null)

    onMounted(async () => {
      const page = await buildDataflareHostPage({...})
      page.syncCookie()
      iframeRef.value!.src = page.iframeUrl

      host.value = createDataflareHost({
        iframe: iframeRef.value!,
        sessionId: page.sessionId,
        baseUrl: '/office-engine',
        token: useAuth().token.value,
        onReady: (caps) => console.log('GenOffice ready', caps),
        onDirty: () => dirty.value = true,
        onSaved: (e) => { dirty.value = false; message.success(`Saved r${e.revision}`) },
        onProgress: (e) => progressBar.value = e.progress,
        onError: (e) => message.error(`${e.code}: ${e.message}`),
      })

      // 翻译
      host.value.registerCommandHandler('translate', (cmd) => {
        runDataflareTranslation(host.value!, {...}).subscribe({
          next: (e) => {
            if (e.type === 'unit') livePreview.value = e.unit
            if (e.type === 'complete') {
              host.value!.postEvent({type:'document-saved', revision: e.completedUnits})
            }
          },
          error: (err) => host.value!.postEvent({type:'error', code:'TRANSLATE_FAIL', message:err.message}),
        })
      })

      // AI 助手
      host.value.registerCommandHandler('focus-ai', (cmd) => {
        aiPanelVisible.value = true
        if (cmd.prompt) aiPrompt.value = cmd.prompt
      })

      // 保存
      host.value.registerCommandHandler('save', async (cmd) => {
        const result = await api.saveDocument(docId.value, extractContent())
        host.value!.postEvent({type:'document-saved', revision: result.revision})
      })
    })

    onUnmounted(() => host.value?.destroy())
  },
})
```

---

## 4. GenOffice iframe 端集成流程（apps/docs 内部）

`apps/docs/src/renderer/App.tsx` 集成示例：

```tsx
import { createDataflareGuest } from '@genoffice/web-sdk'

export function DocsApp() {
  useEffect(() => {
    if (window.parent === window) return  // 不是 iframe 嵌入模式
    
    const guest = createDataflareGuest({
      sessionId: embedConfig.sessionId,
      capabilities: ['document-context', 'ai-translation', 'ai-assistant', 'host-commands', 'global-state'],
      onCommand: async (cmd) => {
        switch (cmd.type) {
          case 'init':
            applyContext(cmd.context)
            break
          case 'set-readonly':
            editor.setReadOnly(cmd.readonly)
            break
          case 'focus-ai':
            aiPanel.open(cmd.prompt)
            break
          case 'translate':
            // 委托给 host（host 会调 runDataflareTranslation）
            break
          case 'save':
            await editor.save()
            guest.postEvent({type:'document-saved', revision: getRev()})
            break
          case 'dispose':
            editor.destroy()
            break
        }
      },
      onGlobalState: (state, rev) => applyGlobalState(state, rev),
    })
    
    return () => guest.destroy()
  }, [])
  
  // ... 既有渲染逻辑
}
```

---

## 5. 安全 + 部署 checklist

### 5.1 必须保留的安全模型

| 层 | 谁负责 | 关键约束 |
|---|---|---|
| **iframe origin** | DataflareWork 后端 | nginx 同源代理 `/office-engine → genoffice:18081`；CSP `frame-src` 限定 |
| **postMessage origin** | 双侧 SDK | `event.origin === expectedOrigin` + `event.source === iframe.contentWindow`（双校验，SDK 已实现） |
| **Cookie 作用域** | DataflareWork 前端 | `Path=/office-engine; SameSite=Lax` —— 不会随其他接口外泄 |
| **iframe 内 EventSource** | GenOffice web-server | EventSource 无法设自定义 header，依赖 `auth_token` cookie（web-server 已自动设置） |
| **Token 不外泄** | 反向代理 | `OfficeEngineProxyController` 不向 GenOffice 透传 `Manager-Token` |
| **JWT 一次性** | web-server `files/:id/jwt` | oneTime=true 模式，verifyJwtWithRevocation 检查 jti 黑名单 |
| **Nonce 一次性** | web-server `embed/nonce` | LRU + 5min TTL，verifyEmbedNonce 防止重放 |
| **路径越界** | web-server `isManagedPath` | iframe 内能写的路径必须在 `DATA_DIR` 或 `WEB_TEMP_ROOT` 下 |
| **翻译记忆作用域** | web-server + translation-core | 共享 TM 只服务于**带作用域**的请求；无作用域一律失败关闭（见 5.1.1） |

#### 5.1.1 翻译记忆的作用域契约（本轮 W5 新增，含行为变更）

**规则**：共享翻译记忆（translation-core 的模块级 `sharedMemory`，以及 web-server 进程级的
`translationMemory`）**只在请求带显式作用域时才被读写**。作用域 = `cacheScope` ?? `glossaryCategory`
?? `customerName`（三者取第一个非空值，与 `bucketFor` 一致）。没有作用域时，请求**不再**退化到
"无 bucket 共享命名空间"，而是完全不使用共享缓存、直接走 provider。

**为什么**：`memory.ts` 的 `keyOf()` 只在 bucket 非空时拼 `::<scope>`；bucket 为空时键里**没有任何
作用域信息**。因此"无作用域 → 回退共享 TM"意味着**所有租户共用同一行**：租户 A 的译文会作为租户 B
的命中返回，B 的译文也会写回污染共享库。

**落点**（缺一不可，任一遗漏都会重新打开这条通路）：

| 位置 | 变化 |
|---|---|
| `packages/translation-core/src/provider.ts` | 新增 `memoryFor()`：`opts.memory` 照用（调用方自己的存储，天然按构造隔离）；模块级 `sharedMemory` 仅在 `bucket !== undefined` 时可用 |
| `apps/web-server/src/ai/translate-http.ts` | 新增 `hasCacheScope()`：`/api/ai/translate` 与流式端点仅在请求带作用域时把进程级 `translationMemory` 交给 core |

**对既有部署的影响（行为变更，需知会）**：单租户部署过去"不带 `cacheScope` 也能享受全局 TM 命中"
（省 provider 调用），此后不再命中——**命中率与 provider 调用量都会变化**。要保留共享缓存语义，调用方
必须下发 `cacheScope`（DataflareWork 的 `GenOfficeTranslationTools` 在有租户上下文时下发
`tenant:<id>`；无租户上下文时下发 `glossaryCategory`/`customerName`，仍然算有作用域）。

**仍未覆盖**（本轮显式不做）：`apps/web-server/src/ai/chat.ts` 的 `ai:translate-batch` IPC 处理器
自己直接查 `translationMemory`（chat.ts:957），未纳入 `hasCacheScope` 门禁。桌面/文档 UI 路径依赖
renderer 下发 `glossaryCategory`（AiPanel 默认 `'general'`）来隔离；**注意 `'general'` 是所有租户共用的
同一个 bucket**，多租户场景下这一跳仍需后续收紧。

### 5.2 CSP 必须包含

```nginx
# nginx 配置示例
location /office-engine/ {
    proxy_pass http://genoffice:18081/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;                       # SSE 必须
    proxy_cache off;                            # SSE 必须
    proxy_read_timeout 86400s;                  # 长 SSE
}

# HTML 响应头（DataflareWork 后端加）
Content-Security-Policy: 
  frame-src 'self' https://genoffice.app;
  script-src 'self' 'nonce-{随机}' https://genoffice.app;
  connect-src 'self' https://genoffice.app;
```

### 5.3 部署矩阵

| 场景 | 部署 | 鉴权 | 备注 |
|---|---|---|---|
| **开发** | DataflareWork Vue (5173) + GenOffice web-server (18081) 直接 | 关 WEB_TOKEN / JWT 都行 | iframe 用 `http://localhost:18081/docs/?embed=1` |
| **staging** | DataflareWork (8080) + nginx + GenOffice (18081) 内网 | WEB_TOKEN 启用，nginx 注入 `Manager-Office-Token` Cookie | iframe 同源 |
| **生产** | DataflareWork (HTTPS) + nginx + GenOffice (HTTPS) | 全套 JWT + 一次性 + nonce + CSP | iframe 同源 + HTTPS only |

---

## 6. 端到端测试 checklist（验收 4.2/4.3/4.4 后必跑）

### 6.1 iframe 装载

- [ ] `buildDataflareHostPage` 返回 `{iframeUrl, sessionId}` 不抛错
- [ ] iframe 加载后 host 收到 `ready` envelope + capabilities
- [ ] `syncCookie` 后 `/office-engine/api/ai/translate/stream` 不返回 401
- [ ] 没有 `Manager-Office-Token` Cookie 时 iframe 内 fetch 拿到 401

### 6.2 翻译管道

- [ ] `runDataflareTranslation` 收到 `start` → `unit`(N) → `quality` → `complete` 全序列
- [ ] AbortSignal 触发后 host 收到 `stream-close status=200` + 编辑器收到 cancel
- [ ] glossaryCategory 变更后下一次翻译的术语数变化
- [ ] 100 units 翻译的 `memoryHitCount > 0` 第二次跑

### 6.3 业务命令

- [ ] `host.postEvent({type:'document-saved'})` 后 guest 的 `dirty=false`
- [ ] `host.registerCommandHandler('save')` 触发后 GenOffice 收到 `save` 命令
- [ ] `host.postEvent({type:'error'})` 后 guest 写到 console error
- [ ] `host.destroy()` 后所有 listener 都被清理（无内存泄漏）

### 6.4 安全

- [ ] `event.origin !== expectedOrigin` 的 envelope 被 SDK 丢弃
- [ ] `event.source !== iframe.contentWindow` 的 envelope 被 SDK 丢弃
- [ ] 一次性 JWT 第二次使用返回 401 + audit log
- [ ] nonce session 被 release 后第二次 verify 返回 `unknown`
- [ ] `Path=/etc/passwd` 在 iframe 内任何 IPC 调用都返回 400/null

---

## 7. 推荐落地顺序（与 GenOffice 0.9.0 release 节奏对齐）

| 周 | 动作 | 验收 |
|---|---|---|
| **W1** | 把 `apps/docs/src/shared/embed-bridge.ts` 拆成 host/guest 两个模块，加到 `apps/sdk/src/`；保持 `apps/docs` 内部 import 路径不变 | SDK typecheck 通过；apps/docs E2E 不退化 |
| **W2** | 在 SDK 加 `buildDataflareHostPage` + `createDataflareHost` + `createDataflareGuest`；DataflareWork 集成切到 SDK 版本（保留 fallback 路径） | DataflareWork E2E 通过；OfficeWorkspaceView.vue 减小 200+ 行 |
| **W3** | 在 SDK 加 `runDataflareTranslation` (Observable) + `runDataflareAgent` (Observable) | 翻译 E2E 通过；术语/记忆/质量三套数据可在 DataflareWork UI 看到 |
| **W4** | 在 DataflareWork 后端加 `e2e/embed/iframe-mount.spec.ts`：模拟 iframe ready + 翻译 + 保存 完整链路；CI 必需 | CI 跑通；DataflareWork 可独立部署 |
| **W5+** | 公开文档：publish `docs/sdk/dataflarework-integration.md` + `@genoffice/web-sdk` 0.10.0 changelog | Dataflarework 自助接入时间 < 1 天 |

---

## 8. 现状差距（SDK 还没做的部分）

| 缺口 | 影响 | 建议放哪个 release |
|---|---|---|
| `embed-bridge.ts` 没 publish 到 SDK | DataflareWork 必须自己写 envelope | 0.10.0 |
| 没有 `buildDataflareHostPage` | host 必须手写 `nonce mint + iframe URL 拼装 + cookie 同步` | 0.10.0 |
| 没有 `runDataflareTranslation` Observable | host 必须自己解析 SSE 字符串 | 0.10.0 |
| 没有 `runDataflareAgent` Observable | AI 助手流得 host 手写 | 0.11.0 |
| 没有 `registerDataflareCommandHandler` typed 注册 | host 手写 `if (cmd.type === 'translate')` | 0.10.0 |
| 没有 `signRequest()` helper（host 调 `/api/v1/auth/jwt` + 续期） | host 必须自己处理 JWT 过期 | 0.10.0 |
| 没有 multi-tenant TM/KB API 的 SDK wrapper | DataflareWork 多租户必须直接调 `/api/v1/ai/capabilities` + `/crmapi/ai/translation/v1/memory` | 0.11.0 |
| 没有 quota / billing 钩子 | DataflareWork 不知道翻译耗多少 | 0.11.0 |

---

## 9. 风险与 mitigation

| 风险 | 概率 | 影响 | mitigation |
|---|---|---|---|
| GenOffice iframe 内 IPC 通道升级破坏 envelope 协议 | 中 | 高 | SDK 暴露 `ENVELOPE_VERSION`，host 端握手时协商 |
| DataflareWork 多租户 isolation 漏（iframe 跨租户访问） | 低 | 极高 | iframe URL 必带 `tenantId`，web-server 端按 tenant 隔离 FILES_DIR |
| 一次性 JWT / nonce 泄漏 | 低 | 高 | SDK 默认 refresh-on-init；TTL ≤ 5min；release on destroy |
| 反向代理 SSE 缓冲（nginx 默认 on） | 中 | 高 | 部署文档强制 `proxy_buffering off; proxy_cache off;` |
| CSP 不允许 'unsafe-inline' 导致 bridge 不工作 | 中 | 中 | bridge 改成外链 `.js` + nonce，去掉 inline |
| 父 shell env 隐式出网（web-server 静默代理到 Weknora） | 中 | 高 | AI provider 来源审计写进 `/api/v1/meta.integrations.ai.effectiveProviderUrl`，host 可拦截 |

---

## 10. 总结

**GenOffice × DataflareWork 通过 SDK 接入的核心价值**：

1. **DataflareWork 端从 400+ 行 envelope 处理代码降到 < 50 行**：`createDataflareHost + registerCommandHandler + runDataflareTranslation`
2. **GenOffice 端从私有模块变公开 API**：bridge 协议（`genoffice-dataflare/v1`）成为 SDK 契约，受 semver 保护
3. **AI 翻译能力以 Observable 形式暴露**：DataflareWork Vue / React 直接 `.subscribe()`，多租户 / 记忆 / 术语 / 质量一应俱全
4. **安全模型端到端封闭**：双 origin 校验 + Cookie 作用域 + JWT 一次性 + nonce 防重放 + 路径越界守卫，五道防线全部进 SDK

**当 SDK 0.10.0 发布 + DataflareWork 切换完成**：DataflareWork 集成 GenOffice 的工作量从 5 天降到 1 天，GenOffice 的 AI 翻译能力可以作为 "white-label office AI kernel" 给任意 SaaS 复用（不只是 DataflareWork）。

---

— END —