# KB / TM Open Format

`.genkb` and `.gentm` are tar-friendly archives with a JSON manifest
and a JSONL payload. The format is intentionally simple so it
round-trips between Node, the browser, and external tools.

## KB — `.genkb`

```
<archive>.genkb/
├── manifest.json     # { id, version, lang, embeddingModel, embeddingDim, createdAt }
├── entries.jsonl     # one JSON object per line: { q, a, source?, tags?, embedding? }
└── index.bin         # optional HNSW vector index (provider-specific binary)
```

Manifest version is `genoffice.kb.1`. Manifest validation rejects
missing required fields with `FormatError`.

## TM — `.gentm`

```
<archive>.gentm/
├── manifest.json     # { id, version, srcLang, tgtLang, domain?, createdAt }
└── pairs.jsonl       # one JSON object per line: { src, tgt, domain?, confidence?, tags? }
```

Manifest version is `genoffice.tm.1`.

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

## API endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/kb/import` | Upload a `.genkb` archive. |
| `GET`  | `/api/v1/kb/export/:id` | Download a `.genkb`. |
| `POST` | `/api/v1/kb/share` | Submit to the public KB library. |
| `POST` | `/api/v1/tm/import` | Upload a `.gentm` archive. |
| `GET`  | `/api/v1/tm/export/:id` | Download a `.gentm`. |

## Versioning

- `v1.x` (currently `genoffice.kb.1` / `genoffice.tm.1`) is the stable
  contract. Optional manifest fields may be added at minor versions.
- Renaming or removing required fields is a breaking change (v2).
