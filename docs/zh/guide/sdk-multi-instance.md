# SDK 多实例（Multi-instance）

> SDK 2.0 Kestrel M1（sdk1.md §B.5.1 #1、§11.38、§11.80）。已合入 `release0919`。

在单个宿主页面挂载**两个或更多**独立的 GenOffice 编辑器 —— 用于分屏对比、左右对照翻译、主从视图、或任何需要并排展示多个文档的场景。

## 你能拿到什么

每个编辑器获得一个**稳定的 per-instance id**，可以从宿主代码的**任意位置**查到对应 handle，无需把 `EditorHandle` 透传到 React props 或回调里。

```ts
import { createEditor, getEditor, listEditors } from '@genoffice/web-sdk'

const editorA = createEditor({
  container: '#left',
  documentId: 'doc-1',
  jwt,
  host,
  instanceId: 'split-left',       // 可选 —— 省略时 SDK 自动 mint
})

const editorB = createEditor({
  container: '#right',
  documentId: 'doc-2',
  jwt,
  host,
  instanceId: 'split-right',
})

// 宿主代码任意位置：
getEditor('split-left').command('setTheme', { theme: 'dark' })

const live = listEditors()        // [editorA, editorB]，按插入顺序
console.log(`本页有 ${live.length} 个编辑器`)
```

## 契约保证

SDK 强制三项保证，让你不用手写 iframe 管理逻辑：

| 保证 | 原因 |
|---|---|
| `EditorHandle.instanceId` 始终是非空字符串 | 可通过 `getEditor(id)` 任意位置查询 |
| `<iframe name>` 格式为 `genoffice-{instanceId}` | embed script 用 `iframe.name` 派发 postMessage，不再依赖脆弱的 `event.source === iframe.contentWindow` 检查 |
| `destroy()` 从注册表移除 handle | `getEditor(id)` 之后返回 `undefined` —— 不会留下已销毁的"幽灵" handle |

两次 `createEditor()` 用同一个 `instanceId` 会抛带 remediation 提示的错误：先调 `getEditor(id).destroy()`。

## 在线 Demo

仓库自带可运行的双 iframe demo：
[`examples/sdk-multi-instance/`](https://github.com/genspark-ai/genoffice/tree/main/examples/sdk-multi-instance/)。
页面并排挂载两个独立编辑器，每个都能独立 save、isDirty、destroy：

![multi-instance 分屏布局 —— 两个编辑器并排，各有独立的 Save / isDirty / Destroy 按钮与共享事件日志。](/assets/sdk-multi-instance-demo.png)

上图演示的就是这个布局：两个编辑器框 + 状态栏 + 每边一组按钮 + 共享事件日志（带 `instanceId`，让你看清事件正确分发到对应编辑器）。

### 本地运行

```sh
# 1. 构建 SDK UMD 包
pnpm --filter @genoffice/web-sdk build

# 2. 启动 web-server
pnpm --filter @genoffice/web-server dev    # http://localhost:18082

# 3. Mint 两个 JWT（sub 相同即可）
JWT_A=$(curl -s -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'content-type: application/json' \
  -d '{"sub":"demo-user","scope":["files:read","files:write"],"ttl":3600}' \
  | jq -r .token)

JWT_B=$(curl -s -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'content-type: application/json' \
  -d '{"sub":"demo-user","scope":["files:read","files:write"],"ttl":3600}' \
  | jq -r .token)

# 4. 提供 demo 静态服务
cd examples/sdk-multi-instance
python3 -m http.server 8080
# 打开 http://localhost:8080 ，把 JWT_A / JWT_B 粘进表单
```

### Demo 验证了什么

- **`listEditors()` 实时反映挂载状态。** 点击 mount 后状态栏显示
  `2 editors: split-left, split-right`（自动 mint 的 id 是 `ed_<base64url>`
  形态；用 `instanceId` 显式固定后，跨刷新保持稳定）。
- **`getEditor(id)` 不依赖 prop 透传。** 点 "isDirty A" 按钮 —— 按钮通过
  `getEditor('split-left')` 直接读 `editorA.isDirty()`，按钮本身不需要
  handle 引用。
- **`destroy()` 是 per-instance 的。** 点 "Destroy A" —— editor B 继续工作。
  `listEditors()` 现在返回 `[editorB]`。
- **postMessage 不会串话。** 共享事件日志显示
  `[saved] instanceId=split-left` 与 `[saved] instanceId=split-right`，
  即使两个编辑器在同一秒内 save。embed bridge 按 `genoffice-{instanceId}`
  iframe `name` 分发，事件永远不会送错编辑器。

## 测试锚点

行为被两组单元测试钉死（共 23 个）：

- `apps/sdk/test/kestrel-multi-instance.test.ts` —— 11 个
  （auto-mint 唯一性 / 显式 id verbatim / `getEditor` 命中与未命中 /
  destroy 后从注册表移除 / iframe `name` 形状 等）
- `apps/sdk/test/multi-instance-isolation.test.ts` —— 9 个
  （并发 mount / destroy / save / isDirty round-trip，证明 handle 之间
  不共享状态）

本地跑：

```sh
pnpm --filter @genoffice/web-sdk test
```

## API 一览

| 函数 | 返回 | 说明 |
|---|---|---|
| `createEditor(options?)` | `EditorHandle` | `instanceId` 可选；省略时自动 mint |
| `getEditor(instanceId)` | `EditorHandle \| undefined` | destroy 后返回 `undefined` |
| `listEditors()` | `EditorHandle[]` | 每次返回新数组；按插入顺序 |
| `editor.destroy()` | `void` | 同步执行；销毁 iframe + 从注册表移除 |

完整类型见 [SDK 参考](/zh/api/sdk-typescript)。
