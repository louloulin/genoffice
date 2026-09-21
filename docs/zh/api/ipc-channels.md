# IPC 通道

GenOffice 暴露 **514 条**类型化 IPC 通道，从主进程（或独立模式下的 web-server）到 renderer。每条通道通过 `registerHandle(name, handler)` 注册，可通过 HTTP 以 `POST /api/ipc/:channel` 调用，请求体形如 `{ "args": [...] }`。

## 自动生成的参考

完整列表按能力目录分组，含文件位置与从源码抽取的 JSDoc，每个发布版本由 [`tools/gen-ipc-docs.mjs`](https://github.com/genspark-ai/genoffice/blob/main/tools/gen-ipc-docs.mjs) 重新生成。

> 📄 [浏览全部 514 条通道 →](./ipc-channels-auto.md)

自动生成的文件也会提交进仓库的 `apps/web-server/IPC_CHANNELS.md`，方便本地 grep：

```sh
grep -A 3 '^### `workbook:save`' apps/web-server/IPC_CHANNELS.md
```

## 通道命名约定

`<area>:<verb>` —— 例如：

- `docs:save` · `docs:open` · `docs:create-document`
- `sheets:read-range` · `workbook:save` · `sheets:list-sheets`
- `slides:apply-txn` · `slides:save` · `slides:save-as`
- `pdf:save` · `pdf:export-images`
- `markdown:save` · `markdown:open`
- `html:save` · `html:save-file`
- `ai:chat` · `ai:capabilities` · `ai:fetch-image`
- `files:upload` · `files:read` · `files:delete`
- `home:recents` · `home:starred`
- `web:save-file` · `web:read-file-bytes`

## 参数编码

传输层编码规则在 `@genoffice/ipc-bridge/transport`（`encodeTransportValue` / `decodeTransportValue`）。字节数组以 `{ __ipcBytes: '…', b64: '…' }` 形式双向流通。Promise 等不可序列化值会以 `INVALID_ARGUMENT` 拒绝。

## 新增通道

1. 找到合适的能力目录（`apps/web-server/src/<area>`）。
2. 在 `registerHandle(...)` 调用上方加 JSDoc 描述契约。
3. 跑 `node tools/gen-ipc-docs.mjs` 重新生成参考。
4. 在 `apps/web-server/tests/` 下加集成测试。
