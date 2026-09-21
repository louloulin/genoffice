# KB / TM 开放格式

`.genkb` 与 `.gentm` 是带 JSON manifest 与 JSONL payload 的 tar 友好归档。格式有意做得简单，能在 Node、浏览器、外部工具之间双向流通。

## KB — `.genkb`

```
<archive>.genkb/
├── manifest.json     # { id, version, lang, embeddingModel, embeddingDim, createdAt }
├── entries.jsonl     # 每行一个 JSON 对象：{ q, a, source?, tags?, embedding? }
└── index.bin         # 可选的 HNSW 向量索引（与 provider 相关的二进制）
```

Manifest 版本为 `genoffice.kb.1`。Manifest 校验会用 `FormatError` 拒绝缺必填字段的情况。

## TM — `.gentm`

```
<archive>.gentm/
├── manifest.json     # { id, version, srcLang, tgtLang, domain?, createdAt }
└── pairs.jsonl       # 每行一个 JSON 对象：{ src, tgt, domain?, confidence?, tags? }
```

Manifest 版本为 `genoffice.tm.1`。

## Reader / Writer

```ts
import {
  makeKbManifest, readKbArchive, writeKbArchive,
  makeTmManifest, readTmArchive, writeTmArchive,
  FormatError,
} from '@genoffice/translation-core'

const kb = {
  manifest: makeKbManifest({ id: 'company-glossary', lang: 'en' }),
  entries: [{ q: 'CEO', a: 'Chief Executive Officer' }],
}
writeKbArchive('./out.genkb', kb)
const back = readKbArchive('./out.genkb')
```

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/kb/import` | 上传 `.genkb` 归档。 |
| `GET`  | `/api/v1/kb/export/:id` | 下载 `.genkb`。 |
| `POST` | `/api/v1/kb/share` | 提交到公共 KB 库。 |
| `POST` | `/api/v1/tm/import` | 上传 `.gentm` 归档。 |
| `GET`  | `/api/v1/tm/export/:id` | 下载 `.gentm`。 |

## 版本策略

- `v1.x`（目前是 `genoffice.kb.1` / `genoffice.tm.1`）是稳定契约。小版本可以新增可选 manifest 字段。
- 重命名或删除必填字段是破坏性变更（v2）。
