# GenOffice Translation Regression Report (2026-09-18)

Branch: `codex/dataflare-translate-envelope` (working tree)
Webserver: `http://127.0.0.1:18099` (`DATA_DIR=/tmp/go-live`,
`GENOFFICE_TRANSLATION_KB=/tmp/go-live/translation-kb.json`,
provider = OpenAI-compatible stub on `127.0.0.1:19998`)

This document covers two passes. The first (findings 1-12) went after the
customer / glossary bucket. The second (findings 13-23, "Second pass") went
after the things that made the *fixes* unreachable in production: a language
filter that hid the whole KB on the default source setting, a long-lived KB
snapshot that never saw an upsert, a memory writer that dropped the bucket on
the way to disk, and several options that were accepted and then discarded.

Continues `docs/regression-translate-2026-09-17.md`. That pass closed the KB CRUD
loop and the `text`/`content` chat bug. The first pass here went after the
**customer / glossary bucket**, which is where a translation platform either
keeps two clients' terminology apart or quietly mixes them.

## Summary

The KB carried per-customer terminology correctly and the resolver filtered it
correctly *when asked*. Three separate defects made that filter reachable in
name only — the buckets existed, the plumbing did not:

1. **Unscoped calls saw every customer's terms.** `resolve()` returned every
   scoped entry when the caller named no bucket.
2. **The HTTP endpoints had no KB and no memory at all.** `/api/ai/translate`
   and `/api/ai/translate/stream` — the Dataflare bridge's primary path —
   passed neither, so no KB term ever applied and the bucket filter had nothing
   to filter.
3. **The translation memory keyed without the bucket.** KERRITS' translation
   was replayed verbatim for ACME, and vice versa.

Plus a fourth, in the web batch handler: the units it returned to the renderer
were missing `status` / `sourceText` / `range` / `quality`, so a fully
successful document translation was discarded by the consumer's own filter and
surfaced as "no usable units".

All four are fixed and covered. Verified end-to-end against a live webserver:
the same source string now resolves to three different answers depending on the
bucket, across IPC, HTTP batch, SSE stream, and the KB preview pane.

## Test Results

| # | Suite | Result |
|---|-------|--------|
| 1 | `packages/translation-core` | ✅ 12 files, **219 tests** |
| 2 | `packages/agent-skills` | ✅ 15 files, **190 tests** |
| 3 | `apps/web-server` | ✅ 24 files, **126 tests** |
| 3b | `apps/docs` (renderer + shell) | ✅ 242 files, **2334 tests** |
| 4 | Live server (`:18099`) bucket isolation | ✅ 3 buckets → 3 distinct answers on 4 entry points |
| 5 | Live server (`:18099`) batch contract | ✅ 60-unit pass, bounded concurrency, blank unit isolated |
| 6 | Live server (`:18099`) auto-detect source | ✅ 3 buckets → 3 distinct answers with `sourceLang: 'auto'` |
| 7 | Live server (`:18099`) KB freshness | ✅ a term upserted after the first HTTP call is applied to the next one |

Pre-existing and unrelated: `packages/agent-runtime/tests/runtime.test.ts` has
one failing `message_update` assertion (verified unrelated via `git stash` in
the previous pass; not touched).

## Findings and Fixes

### 1. `resolve()` handed an unscoped call every customer's terminology

`packages/translation-core/src/knowledge-base.ts`

`passesTermFilter` returned `true` for *all* scoped entries when the caller
named neither a category nor a customer. A document translated without picking
a customer therefore received KERRITS', ACME's and the shared mapping of the
same source term in one prompt — three conflicting rules — and which one the
model used (and which `applyTerminology` enforced) came down to ordering.

The filter now separates the two ideas the wire blurs:

- `customerName` is a **confidentiality boundary**. A customer-scoped entry is
  visible only to a call that names that customer (under either field, since
  `docs` sends the customer as `glossaryCategory`).
- `category` is a **domain hint**. Domain vocabulary is not proprietary, so an
  entry that declares only a category stays visible to everyone; the prompt
  already asks the model to prefer the named domain.

A call with no customer now sees the shared vocabulary and none of the
customer-private terms.

### 2. A customer override and the shared term both reached the prompt

Same file. Even with the filter correct, a shared `fabric weight -> 克重` and a
KERRITS `fabric weight -> 克重(K)` resolved together, so the prompt carried two
mappings for one source string.

`shadowTermsBySource` now drops a term when a **strictly more specific** term
maps the same source, so naming a customer switches the term over
deterministically. Two entries at the same specificity are both kept — this
cannot silently drop synonyms the user added.

### 3. The HTTP translate endpoints had no KB and no memory

`apps/web-server/src/ai/translate-http.ts`

`/api/ai/translate` and `/api/ai/translate/stream` called `translateBatch` /
`translateBatchStream` with `{ provider, config }` only. Both slots are
optional, so nothing failed: translation simply ran with the package-level
in-memory TM and **no KB at all**. Every term the user had just saved was
ignored on the path the Dataflare bridge actually uses, and a request naming a
customer produced byte-identical output to one that did not.

Both now resolve the same `sharedKnowledgeBase` / `translationMemory`
singletons the IPC handlers use.

Also on this path:

- `customerName` was dropped by the SSE handler (only `glossaryCategory` was
  forwarded), so a caller that knew only the customer name ran unscoped.
- The SSE `unit` payload declared `matchedTerms` and never assigned it, so the
  bridge's "KB · N" badge always read zero.

### 4. The translation memory replayed across customers

`packages/translation-core/src/{memory,persistent-memory,provider}.ts`

The TM key was `sourceLang::targetLang::source` with no bucket, so the first
customer's translation of a sentence was returned for every later customer.
Verified before the fix: KERRITS, ACME and an unscoped call all returned the
KERRITS answer.

`bucket` is now part of the key (and of the fuzzy-match filter, and of the save
de-duplication). `glossaryCategory` and `customerName` unify into one bucket
because the renderer paths blur them. Callers that pass no bucket keep the
legacy single namespace.

### 5. Snippet translation reused the previous customer's dictionary

`apps/web-server/src/ai/chat.ts`

`home:translate-snippet` falls back to the last built dictionary so a user can
keep translating with terminology they just curated. The cache recorded only
the path, so a KERRITS dictionary silently applied to an ACME snippet.

The cache now records the bucket it was built for. An explicit
`dictionaryPath` is re-read when the bucket differs; the implicit reuse is
refused outright. `ai:translate-dictionary-status` reports the bucket so the
pane can say whose terminology the reusable dictionary carries.

### 6. `ai:translate-file-auto` advertised the customer and never forwarded it

`apps/web-server/src/ai/chat.ts`, `packages/agent-skills/src/extensions/translate-skill.ts`

The handler read `customerName` / `glossaryCategory` into its request type and
passed neither to `translate_file`, which in turn had no such parameters. File
translation therefore always built one unscoped dictionary, and the KB seed
step applied every customer's terms to the file.

Both layers now carry the pair through to `buildDictionary`.

### 7. The web batch handler returned a shape the renderer discards

`apps/web-server/src/ai/chat.ts`

`ai:translate-batch` returned `{ ok, unitId, translatedText, matchedTerms,
warnings, errorMessage }`. The docs renderer filters units on
`status === 'translated' || 'memory-hit'` and reads `range` to map results back
onto the editor; `web-bridge.ts` reads `status`. With none of those fields
present, a fully successful document pass was filtered down to zero units and
reported as "Document translation returned no usable units".

The handler now returns the desktop contract (`status`, `sourceText`,
`translatedText`, `matchedTerms`, `warnings`, `range`, plus `quality`), and:

- **bounds concurrency at 25**, matching the desktop core. An 80-unit document
  used to open 80 simultaneous provider requests.
- **isolates an empty unit** as a failed unit instead of failing the batch.

### 8. `applyKbRules` ignored `glossaryCategory`

`packages/translation-core/src/dictionary.ts`

The dictionary builder's post-translation enforcement pass forwarded only
`customerName` to the resolver, so a caller that sent the customer as
`glossaryCategory` (the `docs` convention) had every customer's terms applied
during dictionary construction.

### 9. Cross-customer preference leak

`packages/translation-core/src/knowledge-base.ts`

`customerPreference` entries were filtered by `if (opts.customerName && …)` —
skipped entirely when the caller sent no customer name, and blind to a customer
passed as `glossaryCategory`. A KERRITS call therefore carried Nike's
`fabricUnit=GSM` preference. Now gated on the same customer match as terms.

### 10. The agent and the UI kept two translation memories that never met

`packages/agent-skills/src/extensions/translate-skill.ts`,
`apps/web-server/src/shell/pi-session.ts`

The translate tools wrote into the package-level in-memory `sharedMemory`
while `ai:save-translation-memory` wrote into the server's file-backed
`PersistentTranslationMemory`. Neither could see the other, so:

- a translation the agent produced was never a cache hit for the UI, and
  vice versa;
- nothing translated through the tools survived a restart, so the "saved N ms
  · cache" badge the UI showed referred to a store that was empty on the next
  boot.

The extension now exposes `setTranslateMemory()` and the pi session injects the
server's persistent memory (imported lazily — `ai/chat.ts` already imports
`pi-session`, so a static import would close the cycle). All four call sites
(`translate_text`, `translate_file`'s dictionary build, `build_dictionary`,
`fill_dictionary_gaps`) read through it. Callers that never call the setter
keep the in-memory TM.

### 11. `PersistentTranslationMemory` wrote to `$HOME`, ignoring `DATA_DIR`

`packages/translation-core/src/persistent-memory.ts`

The base directory was a module-load constant fixed to
`$HOME/.genoffice/translation-memory`. A standalone web-server started with
`DATA_DIR=/srv/genoffice` therefore persisted translation memory into the
operator's real home directory, and no test could isolate it — which is also
why this defect stayed invisible.

Resolution moved to construction time with the same precedence the KB uses:
`GENOFFICE_TRANSLATION_MEMORY` > `DATA_DIR` / `GENOFFICE_WEB_DATA_DIR` >
`~/.genoffice`.

### 12. Everything translated in the last moments before shutdown was lost

`apps/web-server/src/ai/chat.ts`, `apps/web-server/src/index.ts`

`save()` only marks the language pair dirty; the handlers flush on a 250 ms
debounce, and `scheduleMemoryFlush()` was called once at registration time
rather than after each translation. Combined with a shutdown path that closed
the server immediately, a translation made just before exit — or one whose
debounce timer had not fired — never reached disk.

Flushes are now scheduled after `ai:translate` and `ai:translate-batch`, and
`SIGTERM` / `SIGINT` await `flushTranslationMemory()` before closing the
server.

## Second pass — the fixes were right, the reach was not

### 13. `sourceLang: 'auto'` silently disabled the entire KB

`packages/translation-core/src/knowledge-base.ts`

`passesLang` compared the entry's declared language to the requested one with
`!==`. The renderer's source picker defaults to **auto-detect** and
`normalizeSourceLang` maps unknown to `auto`, so a term that declared
`sourceLang: 'en-US'` was filtered out of *every* default call. The KB the user
had just curated did not apply to snippets, documents, file translation or the
dictionary builder until they explicitly picked a source language — and the
preview pane agreed, so it looked intentional.

```
resolve({ sourceLang: 'auto',   targetLang: 'zh-CN' })  -> 0 terms   (before)
resolve({ sourceLang: 'en-US',  targetLang: 'zh-CN' })  -> 1 term
```

`languageMatches` now treats `auto` as a wildcard and lets a region-less code
match an explicit one (`en` matches `en-US`, the shape KBs imported from
LumosAI use), while keeping two *explicit* regions apart so `zh-CN` is never
confused with `zh-TW`.

### 14. The HTTP endpoints answered from a boot-time KB snapshot

`packages/translation-core/src/knowledge-base.ts`,
`apps/web-server/src/ai/translate-http.ts`, `apps/web-server/src/ai/chat.ts`

The web-server holds one long-lived `sharedKnowledgeBase`, but the UI writes
the KB through the **pi session's own instance** — same JSON file, different
object. `ensureKbLoaded()` is memoised, so after the first HTTP translation the
HTTP path kept serving the snapshot it took at boot: a term the user had just
added stayed invisible to every later HTTP call (verified live: the request
still returned the source text), and a deleted term kept being applied.

`KnowledgeBase.refresh()` re-reads only when the file's bytes changed and
returns `false` when the store is dirty, so it never clobbers a pending local
upsert. It is now called by the HTTP storage resolver and by the KB-resolve
preview, the latter replacing an unconditional `load()` that discarded
unsaved upserts.

### 15. `saveMany` wrote translation memory without its bucket

`packages/translation-core/src/persistent-memory.ts`

`save()` kept `bucket`; `saveMany()` — the path every batch handler uses —
did not. The read path keys on the bucket, so a batch-translated entry came
back **unscoped** after a restart and the first customer's sentence was
replayed for the next one. It also appended instead of replacing, so a file
grew without bound across passes and stale entries stayed in the fuzzy index.

`saveMany` now writes the bucket and de-duplicates on `(source, bucket)`,
matching `save()`.

### 16. The UI's "save to memory" button saved unscoped

`apps/docs/src/renderer/ai/AiPanel.tsx`, `apps/docs/src/main/docs-main.ts`,
`apps/docs/src/shared/ipc.ts`, `apps/docs/src/renderer/web-bridge.ts`

Finding 4 fixed the *reader* side of the TM key. The writer side still sent no
bucket, so anything the user explicitly saved became a cache hit for every
customer. `glossaryCategory` now travels with `saveTranslationMemory` in the
renderer, through the desktop handler, and to the remote memory endpoint.

### 17. The HTTP error envelope never reached the user

`apps/docs/src/shared/dataflare-translate-response.ts`

`translate-http.ts` answers failures with the Node-style
`{ error: { message, code } }`. `parseDataflareTranslateResponse` read only a
*string* `error`, so every 4xx/5xx degraded to
`Dataflare translation failed (400)` — a missing API key surfaced as a bare
status code, and so did the offline provider.

`messageOf` now accepts a string, `{ message }` and a nested `{ error }`, which
restores the actionable reason for the embedded (Dataflare) UI.

### 18. `translate_file` had no `scale` field, so PDFs ignored it

`packages/agent-skills/src/extensions/translate-skill.ts`

`ai:translate-file-auto` accepted `scale` and forwarded `scale` to the tool,
but the tool's TypeBox schema had no such property: validation dropped it and
every PDF rendered at the script's default of 2. The schema now declares it,
and the flag is only emitted for a `.pdf` input — the format siblings
(`translate_docx.py`, `translate_xls.py`, …) have no `--scale` argument and
argparse exits 2 on an unknown flag.

Same pass, same class:

- **`timeout_ms`** was accepted by nothing and defaulted to 5 minutes inside
  the tool; a large PDF could hang the UI's spinner indefinitely. The tool now
  takes `timeout_ms`, kills the child (`SIGKILL`) and reports a timeout, and
  `ai:translate-file` forwards its `timeoutMs`.
- **`fill_dictionary_gaps`** declared `max_pairs` / `min_chars` and forwarded
  neither, so the caller's budget was replaced by the core default of 400.

### 19. Duplicate KB rows reached the prompt twice

`packages/translation-core/src/knowledge-base.ts`

A KB that was re-imported or re-seeded carries the same mapping under two ids.
Both survived `shadowTermsBySource`, so the model saw the rule twice and the
`matchedTerms` badge counted it twice. Identical `(source, target)` rows are now
collapsed; two rows at the same specificity with *different* targets are still
kept, since those are genuine synonyms.

### 20. The pi session re-parsed — and could reset — the KB on every tool call

`packages/agent-skills/src/extensions/translate-skill.ts`

`getKb()` called `load()` on every tool invocation. Besides the redundant
parse, a `load()` on a missing file resets the store to `{}`, so an upsert that
had not been saved yet could be discarded by the next tool call. It now loads
once and refreshes after.

### 21. Memory written by a failed call was thrown away

`apps/web-server/src/ai/translate-http.ts`, `apps/web-server/src/ai/chat.ts`

The debounced flush was scheduled on the success path only. A batch that
translated 49 of 50 units and then threw discarded all 49 memory writes, and
`ai:translate` — which schedules the flush *after* its `!result.ok` early
return — did the same for the single-snippet path. Both now flush in a
`finally` (`scheduleMemoryFlush` is a no-op when nothing is dirty), so a
partial pass still improves the next run.

### 22. A nested term was destroyed by the shorter term containing it

`packages/translation-core/src/dictionary.ts`

Term enforcement rewrites with `split/join`, so a term that is a substring of a
longer one must run **after** it — `terminologyPairs` sorts the KB
longest-source-first for exactly this reason. `applyKbRules` iterated the
resolver's terms in scope/priority order instead, so a low-priority
`fabric weight -> 克重` sitting behind a high-priority `fabric -> 布料` was
already unreachable by the time it was reached:

```
KB: fabric -> 布料 (priority 5), fabric weight -> 克重 (priority 1)
"fabric weight spec"  ->  "布料 weight spec"      (before)
                      ->  "克重 spec"             (after)
```

`matchedTerms` is now built from the terms that actually fired, so the UI badge
stops counting a rule that had nothing left to rewrite.

### 23. Merging the KB with the dictionary broke the longest-first invariant

`packages/translation-core/src/provider.ts`

The same invariant, broken one level up. `resolveTerminology` returned
`[...fromKb, ...fromDictionary]`: the KB half was sorted, the dictionary half
was in file order, and the concatenation was not sorted at all. A KB term
nested inside a dictionary term therefore still lost — the snippet path
(`home:translate-snippet` layers the generated dictionary on top of the KB) hit
this on every call:

```
KB: fabric -> 布料 ; dictionary: fabric weight -> 克重
"fabric weight spec"  ->  "布料 weight spec"      (before)
                      ->  "克重 spec"             (after)
```

The merged list is now sorted by descending source length.

## Cross-Customer Isolation (live evidence)

Seeded KB: shared `fabric weight -> 克重` (category `apparel`), KERRITS
`fabric weight -> 克重(K)`, ACME `fabric weight -> 克重(A)`.

```
IPC        KERRITS   -> 克重(K)
IPC        ACME      -> 克重(A)
IPC        unscoped  -> 克重
HTTP batch KERRITS   -> 克重(K)
HTTP batch ACME      -> 克重(A)
HTTP batch unscoped  -> 克重
SSE stream ACME      -> 克重(A)   (matchedTerms: ["fabric weight"])
KB resolve KERRITS   -> terms=['克重(K)']
KB resolve ACME      -> terms=['克重(A)']
KB resolve unscoped  -> terms=['克重']
```

Before this pass, all three buckets returned the same string (the previous
pass's manual run showed `克重K spec` for every case) and `matchedTerms` was
empty on the HTTP paths.

## Memory Persistence (live evidence)

`apps/web-server/tests/translate-memory-persistence-e2e.test.ts` boots the
server, translates `persistent memory probe sentence`, stops it, boots a second
process against the same `DATA_DIR`, and re-translates:

```
first  pass status: translated   (provider called 1x)
on-disk           : $DATA_DIR/translation-memory/en-US->zh-CN.json
second pass status: memory-hit   (provider call count unchanged)
```

Before the fix the memory directory did not exist at all, and the second pass
was a fresh provider call.

## Batch Contract (live evidence)

60 units, `glossaryCategory=KERRITS`, `memoryEnabled=false`:

```
batch ok          : True
units returned    : 60
unit[0] status    : translated
unit[0] sourceText: fabric weight spec 0
unit[0] range     : {'from': 0, 'to': 5}
unit[0] translated: 克重(K)
quality score     : 0.7916666666666666
all translated    : True
blank status      : ['translated', 'failed']
```

## Reproduction

```bash
# unit + integration suites
cd packages/translation-core && npx vitest run      # 176
cd packages/agent-skills   && npx vitest run        # 180
cd apps/web-server         && npx vitest run        # 92

# rebuild the shipped bundle after touching either package
npx tsc --build packages/translation-core packages/agent-skills
cd apps/web-server && node scripts/bundle.mjs

# live check (stub provider on :19998, server on :18099)
zsh /tmp/go-live/verify.sh
```

New suites:

- `packages/translation-core/tests/knowledge-base.test.ts` — customer bucket
  narrowing, override shadowing, preference isolation, language matching
  (`auto` wildcard, region-less codes), `refresh()` freshness + malformed-file
  resilience, duplicate collapsing.
- `packages/translation-core/tests/memory.test.ts` — TM bucket isolation.
- `packages/translation-core/tests/translate-dictionary.test.ts` — nested-term
  enforcement order, `matchedTerms` accuracy.
- `packages/translation-core/tests/provider.test.ts` — the merged KB +
  dictionary term list stays longest-first.
- `packages/translation-core/tests/persistent-memory.test.ts` — the bucket
  survives `saveMany` → `flush` → `load`, for exact and fuzzy lookups.
- `apps/docs/tests/dataflare-translate-response.test.ts` — the web-server error
  envelope is surfaced as a message, not a status code.
- `apps/web-server/tests/translate-bucket-isolation-e2e.test.ts` — 6 tests
  across IPC / HTTP / SSE / dictionary reuse / TM.
- `apps/web-server/tests/translate-batch-contract-e2e.test.ts` — 3 tests
  pinning the unit contract, concurrency bound, blank-unit isolation.
- `apps/web-server/tests/translate-batch-options-e2e.test.ts` — per-unit
  option forwarding.
- `apps/web-server/tests/translate-preserve-format.test.ts` — `preserveFormat`
  reaches the tool as a boolean.
- `apps/web-server/tests/translate-memory-persistence-e2e.test.ts` — the TM
  survives a server restart and is not re-requested from the provider.

## Auto-detect source (live evidence)

Seeded KB: shared `fabric weight -> 克重`, KERRITS `-> 克重(K)`, ACME
`-> 克重(A)`. Every call below sends `sourceLang` / `sourceLanguage: 'auto'`,
which is what the renderer sends by default.

```
IPC batch   auto + KERRITS  -> 克重(K)   (matchedTerms: ["fabric weight"])
HTTP batch  auto + ACME     -> 克重(A)
HTTP batch  auto + unscoped -> 克重
KB resolve  auto + KERRITS  -> terms=['克重(K)']
```

Before the fix all four returned the source text unchanged.

## KB freshness (live evidence)

```
step 1  HTTP translate, empty KB        -> "fabric weight spec"  (no term yet)
step 2  ai:translation-kb-upsert KERRITS-> 克重(K)
step 3  HTTP translate, KERRITS bucket  -> 克重(K)   (was: still untranslated)
```

## Third pass — the quality signal and the embedded bridge

Findings 24-29. This pass started from one live observation: a real garment
term (`克重`) came back from a batch run carrying `too-short` at 0.75. Chasing
that turned up a cross-script bug in the quality heuristic, and then a second
class of bug in the embedded (Dataflare) bridge, which had been silently
re-asserting defaults the caller had explicitly turned off.

### 24. `too-short` was measured in characters, and Han is not Latin

`packages/translation-core/src/quality.ts`, `languages.ts`

`assessQuality` compared `translatedText.length / sourceText.length` against a
flat `0.25`. A Han character carries roughly 2.5 Latin letters, so every short
English -> Chinese term looked truncated: a spot check of 20 realistic garment
strings flagged 6 of them, all false positives.

```
0.11  TOO-SHORT  "Fabric weight spec"        -> "克重"
0.15  TOO-SHORT  "Fabric weight"             -> "克重"
0.18  TOO-SHORT  "WATER REPELLENT FINISH"    -> "防水整理"
0.18  TOO-SHORT  "Machine wash cold with like colors" -> "冷水同色洗涤"
0.24  TOO-SHORT  "Four-way stretch woven fabric"      -> "四面弹梭织面料"
```

Added `informationLength()` (Han / kana / hangul weight 2.5, everything else 1)
and made the ratio use it on both sides. The same 20 pairs now produce zero
false positives, and a genuinely truncated rendering still flags:

```
assessQuality('Machine wash cold with like colors, tumble dry low, do not bleach', '洗')
  -> ['too-short']
assessQuality('尺寸表', 'Size Chart') -> []   (the reverse direction, too)
```

### 25. `qualityCheck: false` was ignored by the core layer

`packages/translation-core/src/provider.ts`

`TranslateRequest.qualityCheck` and `TranslateBatchRequest.qualityCheck` both
document "when false the post-translation quality assessment is skipped", and
the web-server batch handler honoured it for the batch score — but
`translateBatch` / `translateBatchStream` computed `assessBatchQuality` and
`warningsFor` unconditionally. The same request therefore returned a score on
desktop and none on web, and a caller who disabled quality still got per-unit
warnings.

```
before: batch qualityCheck=false -> quality {"overallScore":0.75,"warnings":["too-short"]}
after:  batch qualityCheck=false -> quality undefined, unit.warnings []
after:  batch qualityCheck=true  -> quality {"overallScore":0.75,"warnings":["untranslated"]}
```

### 26. `translateOne` never reported warnings at all

`packages/translation-core/src/provider.ts`

`TranslateResponse` declares `warnings` and the docs panel renders them, but
only the batch path populated the field. A selection / snippet translation that
came back truncated was indistinguishable from a good one. `translateOne` now
assesses quality on the normal and memory-hit returns, gated by the same
`qualityCheck` flag.

### 27. The embedded bridge hard-coded the toggles back to `true`

`apps/docs/src/renderer/web-bridge.ts`

All three embedded Dataflare branches (one-shot, batch, SSE batch) built their
own body and each hard-coded `memoryEnabled: true` / `qualityCheck: true`. A
user who turned memory off in the embedded UI still paid for memory lookups;
one who turned quality off still got warnings.

Extracted `apps/docs/src/shared/translate-embed-body.ts` so the three sites
share one implementation, and switched the fields to `!== false` so an explicit
`false` survives while `undefined` keeps the server default.

### 28. The embedded bridge never sent the glossary scope

`apps/docs/src/renderer/web-bridge.ts`

Same three branches sent neither `glossaryCategory` nor `customerName`, though
`translate-http.ts` accepts both. An embedded customer-scoped document was
translated with every customer's glossary in the prompt — the cross-customer
leak the second pass had just closed on the IPC/HTTP side, still open on the
embedded side.

Live evidence (KB seeded with a KERRITS-only
`fabric weight -> 克重(K)`):

```
HTTP one-shot customerName=KERRITS -> 克重(K)
HTTP one-shot customerName=None    -> 克重 spec    (no leak)
```

### 29. The desktop handlers dropped `customerName` and the batch fallback dropped quality

`apps/docs/src/main/docs-main.ts`, `apps/docs/src/shared/desktop-api-factory.ts`,
`apps/docs/src/shared/ipc.ts`

Three smaller parity gaps found while fixing 27/28:

- The desktop `ai:translate` and `ai:translate-batch` handlers never forwarded
  `customerName`, so the same request narrowed the KB on web and leaked every
  customer's term on desktop.
- The one-shot response type omitted `matchedTerms`, which the fan-out
  fallbacks in `desktop-api-factory.ts` then silently dropped.
- Those fallbacks also dropped the per-unit `warnings`, so any batch that ran
  through them looked warning-free.

### Live checks added this pass

```
zsh /tmp/go-live/qc-run.sh      # qualityCheck on/off across IPC + HTTP
zsh /tmp/go-live/embed-run.sh   # customerName boundary + toggles over HTTP
zsh /tmp/go-live/formats/run.sh # real docx / xlsx / pptx translate.py runs
```

`nested-run.sh` also changed: its stub now echoes the source verbatim
(`STUB_MODE=echo`) instead of returning only the captured term. The old stub
dropped the trailing " spec", which made the term-enforcement layer's real
behaviour unobservable — the third assertion was failing on the stub's
limitation, not on the product. With the stub fixed the assertion passes
unchanged, which confirms `applyTerminology` (not the prompt) was doing the
work.

## docx / xlsx / pptx (live evidence)

Previously listed as uncovered. Driven through the real
`ai:translate-file-auto` IPC handler against the LumosAI Python writers:

```
docx: ok=True bytes=37878  -> 克重规格 | 面料：100%聚酯纤维；里料：100%棉 | 克重 | 冷水机洗
xlsx: ok=True bytes=4901   -> 克重 | 冷水同色洗涤 | 尺码表
pptx: ok=True bytes=28306  -> 克重规格 | 冷水机洗，低温烘干。
```

Run: `zsh /tmp/go-live/formats/run.sh` (generates fixtures with python-docx /
openpyxl / python-pptx, translates each, re-reads the output file).

## Fourth pass — the transport lied about who was at fault

Findings 30-31. This pass came out of a sweep the other three had not done: call
every one of the 531 registered IPC channels with no arguments and look at the
status code. A malformed request is supposed to be answered with a 4xx, but 107
channels answered 500 — the retry logic could not separate a bug in the
renderer's own request from a real server fault, and the genuine 500s were
buried.

```
before   total 531 | 200: 424  4xx:   0  5xx: 107
after    total 531 | 200: 425  4xx:  84  5xx:  22
```

All 22 remaining 5xx are `501 WEB_UNSUPPORTED` — the channels that exist in the
registry but have no web implementation, which is the one 5xx a client should
not retry.

### 30. Every structured error code answered 500, and an unclassified TypeError was blamed on the server

`apps/web-server/src/ai/errors.ts`, `apps/web-server/src/index.ts`

`sendIpcError` had exactly one branch:

```ts
const status = errObj.code === 'WEB_UNSUPPORTED' ? 501 : 500
```

so `INVALID_ARGUMENT`, `NOT_FOUND`, and `CORRUPT` all came back as "internal
server error". Worse, the largest single group was not a structured code at
all: a handler written as `(_event, args) => { const { docId } = args as … }`
throws a bare `TypeError` — "Cannot destructure property 'docId' of 'args' as
it is undefined" — when the caller omits the argument object, which is how 85
of the 107 failures presented.

Two changes:

- `ipcErrorStatus(code)` maps each code to the status a client can act on
  (`WEB_UNSUPPORTED` 501, `INVALID_ARGUMENT` 400, `NOT_FOUND` 404, `CORRUPT`
  422, anything else 500).
- `classifyWebError` recognises the missing-argument `TypeError` shapes
  (`Cannot destructure property … of … as it is undefined`,
  `Cannot read properties of undefined (reading …)`) and rebuilds them as
  `InvalidArgumentError`. `sendIpcError` now takes the channel and classifies
  before it picks a status.

Defaulting `args` to `{}` in the dispatcher was the obvious alternative and is
the wrong fix: `collab:join` would then build the session key
`"undefined:undefined"` and report success instead of failing.

```
collab:join            [] -> 400 INVALID_ARGUMENT  (was 500)
pdf:read-file          [] -> 404 NOT_FOUND         (was 500)
web:write-temp-file    [] -> 400 INVALID_ARGUMENT  (was 500)
ai:slides-translate    [] -> 501 WEB_UNSUPPORTED   (unchanged, intentional)
```

A `TypeError` that is *not* about missing arguments still answers 500, so a
real bug in a handler is not quietly re-labelled as the caller's fault.

### 31. The last three real 500s, and a 500 on an unparseable body

`apps/web-server/src/{pdf,markdown,html,slides,web,sheets,anydoc,docs}/index.ts`,
`apps/web-server/src/ai/translate-http.ts`, `apps/web-server/src/shell/skills.ts`

With the classifier in place the sweep left 25, then these:

- **File reads answered 500 for a missing file.** `pdf:read-file`,
  `markdown:read-file`, `html:read-file`, `slides:read-file`,
  `web:read-file-bytes`, and `anydoc:read-file` threw a plain `Error('File not
  found: …')`. A path the caller supplied that no longer exists is a 404, and
  the open/save flows branch on that to say "the file moved or deleted".
- **`docs:open-path` rejected a path outside the storage root with 500.** That
  is a rejected argument, not a server fault: now `InvalidArgumentError`.
- **`home:uninstall-skill` with no id** reached `removeSkillFromPi(undefined)`,
  whose `path.join` threw a bare `TypeError` about the `path` argument. Now
  validated up front as `INVALID_ARGUMENT`.
- **`workbook:open-for-merge`** rejected 0 or >20 sources and a missing merge
  source with plain `Error`s; now 400 and 404 respectively.
- **`web:write-temp-file` / `web:save-file`** rejected a malformed request body
  with a plain `Error`; now `INVALID_ARGUMENT`.
- **`ai:set-settings`, `ai:chat`** validated their argument and threw plain
  `Error`s; now `INVALID_ARGUMENT`. `ai:stream` was changed to tolerate a
  missing request object instead of reading `.requestId` off `undefined`.
- **`POST /api/ai/translate` answered 500 for a body that is not JSON.** No
  retry can fix that, so it answered "server error" for a deterministic client
  mistake. Now 400 with `INVALID_ARGUMENT`; the streaming sibling already did
  this.

### Live checks added this pass

```
zsh /tmp/go-live/allchannels-run.sh   # 531 channels, no-arg sweep, groups 5xx by message
```

The sweep is also a regression test now:
`apps/web-server/tests/ipc-error-status-e2e.test.ts` boots the bundle, walks
every channel from `/api/channels`, and fails if any of them answers a
no-argument call with a 5xx that is not a structured `WEB_UNSUPPORTED` 501.

## Fifth pass — a malformed request could write a permanent row into the user's KB

Findings 32-34. This pass started from the previous one's sweep. Having proved
that a no-argument call answers 4xx, the next question was what a *present but
wrong-shaped* argument does to the translation channels specifically. Three of
them still answered 500, and one of them did not fail at all: it silently wrote
garbage into the user's knowledge base.

### 32. Handlers threw on the shape of their arguments instead of reporting it

`packages/translation-core/src/{provider,memory,persistent-memory}.ts`,
`apps/web-server/src/ai/chat.ts`, `apps/docs/src/main/docs-main.ts`

Three translation channels answered HTTP 500 for a payload that is merely
malformed, and the message the user saw was the raw JavaScript expression:

```
500  home:translate-snippet       (req.text ?? "").trim is not a function
500  ai:save-translation-memory   (req.units ?? []).filter is not a function
500  ai:save-translation-memory   Cannot read properties of null (reading 'sourceText')
500  ai:translate                 (request.instruction ?? "").trim is not a function
500  ai:translate-batch           units: "nope"  ->  (a string reached .length)
```

`translateOne` / `translateBatch` / `TranslationMemory.saveMany` are library
functions, but they are reachable straight from IPC with whatever JSON the
caller typed, so validation belongs at that boundary. Each now rejects the
shape with a message naming the field, and the handlers forward it:

```
200  home:translate-snippet       -> { ok: false, error: "…expected `text` to be a string" }
200  ai:translate                 -> { ok: false, error: "…expected `instruction` to be a string" }
200  ai:translate-batch           -> { ok: false, error: "…expected `units` to be an array", units: [] }
200  ai:save-translation-memory   -> { ok: false, error: "units must be an array" }
```

Two details that would otherwise have been second bugs:

- `translateBatch` returns `units: []` on the rejection path, because the
  renderer iterates that field; answering without it moves the crash to the UI.
- `ai:save-translation-memory` counted the elements it narrowed out. Filtering
  `null` before `saveMany` and then reporting `savedCount: 1` for a four-entry
  batch hides the three losses; the rejected elements are added to
  `skippedCount` so the numbers still add up.

### 33. `kb_upsert` wrote a blank row into the user's knowledge base

`packages/agent-skills/src/extensions/translate-skill.ts`,
`packages/translation-core/src/knowledge-base.ts`

The channel sweep called `home:translate-kb-upsert` with `{}` and got
`ok: true`. The resulting row, read back from the KB file:

```json
{ "id": "entry-mu4zka6v" }
```

Three of them were found in a real `~/.genoffice/translation-kb.json`. The
chain that produced them:

1. `kb_upsert` accepted an entry with no identifying field. `seed` fell back to
   the empty string, so the generated id became `entry-<base36>`.
2. `schemaForEntry` sniffed fields and ended with
   `return 'trade.translation.customerPreference'` as a catch-all, so the row
   was filed as a customer preference — with no customer and no preference.
3. `resolve()` filters preferences by `matchesRequestedBucket(e.customerName, …)`
   and `undefined` never matches, so the row was inert. The UI listed it; the
   translator never read it.

A catch-all bucket can only ever hide a malformed entry, so there is no longer
one: `schemaForEntry` returns `null` for an entry nothing identifies, `upsert`
throws, and `kb_upsert` returns a shape error before it gets there. `kb_search`
got the same guard for its `query` (a missing query used to surface as
`Cannot read properties of undefined (reading 'toLowerCase')`).

Two related fixes fell out of the same code:

- **The declared `schema` is honoured.** Sniffing ran first and matched
  `name` + `description` before reading the entry's own `schema`, so a
  `forbidden` entry carrying a stray `name` was filed as a style rule.
- **The `customerPreference` shortcut wrote a field no reader looks at.** It
  stored `entry.preference`; the schema is `{ customerName, preferenceType,
  value }` and `renderPromptBlock` renders `${preferenceType}=${value}`. A
  preference saved through the shortcut contributed
  `KERRITS: undefined=undefined` to the prompt while the UI showed a populated
  row. The shortcut now writes `value` (and defaults `preferenceType`).

The three blank rows were removed from the local KB after backing it up
(`~/.genoffice/translation-kb.json.bak-*`).

### 34. A legacy preference row rendered as `undefined=undefined`

`packages/translation-core/src/knowledge-base.ts`,
`apps/shell/src/renderer/src/SettingsModal.tsx`, `apps/shell/src/shared/home-api.ts`

Fix 33 stopped new malformed rows, but the rows already written by the old
shortcut are real user data — one was in the local KB. Rendering only
`preferenceType`/`value` turned it into `undefined=undefined` in the prompt, and
the settings list showed it as blank.

`describePreference()` renders either shape (`preference` is accepted as the
legacy spelling of `value`), and the validation accepts a row that has content
under either name while still rejecting one with nothing at all. The shell's
list and its `TranslationKbEntry` type know about the legacy field so a row
that is listed can also be re-saved.

### Live checks added this pass

```
zsh /tmp/go-live/allchannels-run.sh   # 531 channels, no-arg sweep: 5xx is 22, all 501
```

New regression suites:

```
apps/web-server/tests/ipc-error-status.test.ts               # ipcErrorStatus + classifyWebError
apps/web-server/tests/ipc-error-status-e2e.test.ts           # every channel, no-arg call
apps/web-server/tests/translate-malformed-payloads-e2e.test.ts   # findings 32
packages/translation-core/tests/knowledge-base.test.ts       # findings 33-34
packages/agent-skills/tests/translate-skill.test.ts          # kb_upsert / kb_search guards
```

Probed against a fresh `GENOFFICE_TRANSLATION_KB` and confirmed the file is not
created at all by those calls:

```
200  home:translate-kb-upsert     {}                              -> ok:false "needs a schema plus its identifying field"
200  home:translate-kb-upsert     {schema:"term"}                 -> ok:false "needs a schema plus its identifying field"
200  ai:translation-kb-upsert     {id,scope,priority}             -> ok:false "needs a schema plus its identifying field"
200  ai:translation-kb-list       {}                              -> entries: []
KB file after probes: (no file written)
```

## Seventh pass — non-string fields in the prompt builder; web-server memory split; respell-kick channel

The sixth pass rejected the wrong *shape* of fields. This pass goes after the
next layer down: an argument with the right *shape* but a non-string value in a
field that downstream code expected to be a string. The most common offender
was the prompt builder: a renderer that posted `glossaryCategory: 7` (or `{}`,
`[]`, `true`) reached `buildTranslateSystemPrompt` and either crashed
`value3.indexOf is not a function` (IPC) or answered HTTP 500
`opts.glossaryCategory.trim is not a function`. The bucket filter then either
silently dropped the customer's terms (when `bucketFor` saw the field as
`undefined`) or saved an unscoped entry that leaked as a cache hit for every
customer on the next read.

The web-server's `ai:translate-batch` worker also stopped reading the shared
translation memory before going through the model: a unit whose source text
was just saved through `ai:save-translation-memory` was retranslated from
scratch because the save-side and read-side paths did not see the same TM
instance. Adding the same lookup-and-skip pre-pass the core `translateBatch`
already has closes that gap.

`docs:respell-kick` was the last "only on desktop" channel of any consequence
left over from the unification pass. Registering an explicit `{ ok: true,
supported: false }` no-op on the web turns the renderer's swallowed 404 into
an honest answer — the caller can stop logging the missing handler, and the
user can respell by typing.

Details in findings 40-43 below.

Sixth pass — a wrong argument shape was answered with a raw JavaScript expression

The fourth pass classified a *missing* argument object. This pass covers the
next case along: the argument object is present but one of its fields has the
wrong type. Those reached the type's own methods and threw, and the raw
expression — `(u.sourceText ?? "").trim is not a function` — was what the UI
displayed. A caller reading that cannot tell whether to fix its own request
(which is what every one of them needs) or to retry.

The probe used is the same idea as the no-argument sweep, one step further: it
walks every documented field of every translation channel with a value of the
wrong type and reports anything that answers 5xx or echoes an uncaught
JavaScript error.

### 35. One malformed batch element destroyed the whole document

`translateBatch` mapped over `units` and read `unit.sourceText` without
checking it. A `null` element, a bare string, or an object whose `sourceText`
was a number threw out of the whole `Promise.all` — the caller lost every unit
in the batch because one of them was malformed.

The streaming variant was worse in a way that reported success. It `return`ed
early on a falsy element, which left a *hole* in the `settled` array:

```
new Array(2).every(...)   // true  — every() skips holes
new Array(2).find(...)    // TypeError: Cannot read properties of undefined (reading 'ok')
```

So a batch containing one null element reported `ok: true` over a segment that
was never translated, and then threw when it tried to name the failure.

Both variants now route each element through `malformedUnitResult()`, which
settles it as a failed unit carrying `ai:translate-batch expected unit <n> …`.
The unit's index is in the message because the renderer maps results back by
position and a generic "bad request" would not say which segment to look at.
`unitId` is also coerced to a string: the renderer keys its own map on it, so a
number there was a key nothing could look up.

### 36. `isSupportedExtension` threw on its own argument

`packages/translation-core/src/file-translate.ts` called
`pathOrExt.startsWith('.')` on a value that arrives unvalidated from
`ai:translate-file` / `ai:translate-file-auto`:

```
500  ai:translate-file       {inputPath: 123, dictionaryPath: "/tmp/x.json"}
     pathOrExt.startsWith is not a function
```

A non-string is simply not a supported extension, so it now answers the
existing "Unsupported file type" message. `defaultOutputPath` had the same
shape of bug with a worse symptom: `String(inputPath)` turned a number into a
believable path, so `ai:translate-file-output-path` answered

```
200  {ok: true, outputPath: "123_translated"}
```

for a value that never named a file — and the caller passes that straight to
the translator. It now rejects anything but a string, on both the web-server and
the docs handlers.

### 37. `kb_list` answered "your knowledge base is empty" for a bad `limit`

`entries.slice(0, params.limit ?? 500)` accepts anything:

```
['a'..'j'].slice(0, 'x')   // []
['a'..'j'].slice(0, -5)    // 5 items — the tail silently dropped
['a'..'j'].slice(0, 0)     // []
```

The tool schema constrains `limit` for the agent path only; the IPC bridge
calls `execute()` with whatever JSON the caller sent. A UI that computed a page
size wrongly was therefore told the KB was empty while every row was still on
disk, and the same went for a typo'd `schema` key, which the store lookup
turned into an empty slice. Both are rejected now, with the accepted range in
the message. `kb_search` had the identical bug and got the same guard.

### 38. `buildDictionary` leaked a raw `node:path` error

`if (!request.inputPath)` passes a number, because a number is truthy, and the
value then reached `node:path` three layers down:

```
200  ai:translate-build-dictionary  {inputPath: 123, targetLang: "zh-CN"}
     failed to extract text: The "path" argument must be of type string. Received type number (123)
```

Technically a reported failure and not a crash, but it names an internal API
the caller never touched. All three entry points (`buildDictionary`,
`assessFileCoverage`, `fillDictionaryGaps`) now check both path fields by type
and report ``expected a non-empty `inputPath` ``.

### 39. A malformed unit hung the SSE stream until the caller gave up

The streaming handler wrote its `200 text/event-stream` header *before*
normalising `units`, and the `try` block that ends the response started after
that. So a `null` element threw between the header and the guard:

- the header had already promised a stream, so the failure could not be
  answered as a status code;
- the `try`/`finally` that calls `response.end()` had not been entered, so
  nothing ever ended the socket;
- the caller waited on an open connection until its own timeout and had no way
  to learn what went wrong.

Measured against the live server: `units: [null, {...}]` hung for the full 60 s
probe timeout. The non-streaming endpoint had the same defect in a milder form —
`toCoreUnits` threw before `translateBatch` was reached, so a null element
answered 500 with `u.unitId is not a function` rather than reporting the unit.

`toCoreUnits` now hands a malformed element through untouched, and the core
layer's `malformedUnitResult` (finding 35) settles it as a failed unit that
names its index. It also returns `[]` for a non-array `units` instead of
throwing on `.map`. On the stream side the whole post-header region is inside a
single `try` whose `finally` deletes the session and ends the response, so no
future edit in that region can leave a socket open.

Live, on the same request that used to hang:

```
event: start    totalUnits: 3
event: unit     unitId ""    status failed  warnings ["malformed-unit"]
                errorMessage "ai:translate-batch expected unit 0 to be an object"
event: unit     unitId "bad" status failed  warnings ["malformed-unit"]
                errorMessage "ai:translate-batch expected unit 1 `sourceText` to be a string"
event: unit     unitId "ok"  status translated
event: quality  overallScore 0.25
event: complete status "failed" completedUnits 3 failedCount 2
```

The batch endpoint answers the same request with one settled unit per input,
in place:

```
200  /api/ai/translate  units [null, {sourceText:42}, {unitId:"ok",...}]
     units[0] "expected unit 0 to be an object"
     units[1] "expected unit 1 `sourceText` to be a string"
     units[2] translated
400  /api/ai/translate  units "nope"        -> INVALID_ARGUMENT
200  /api/ai/translate/stream  units "nope" -> error event, stream closes
```

### Live checks added this pass

The malformed-shape sweep, run against a fresh `DATA_DIR` and a stub provider:

```
zsh /tmp/go-live4/run6.sh      # 23 malformed-shape probes: 0 server faults, 0 raw JS in a reply
zsh /tmp/go-live4/run-stream.sh # SSE: 3-unit batch, malformed elements, empty units, bad JSON
```

Every probe now answers 200 with `ok: false` and a sentence:

```
200  ai:translate-batch          units:[{sourceText:"Hello"}, null]
     units[1] -> "expected unit 1 to be an object"; units[0] still translated
200  ai:translate-batch          units:[{sourceText: 123}]
     units[0] -> "expected unit 0 `sourceText` to be a string"
200  ai:translate-file-auto      inputPath: 123
     "Unsupported file type; expected one of .pdf, .xls, .xlsx, .pptx, .docx"
200  ai:translate-file-output-path  inputPath: [1,2]
     "expected a non-empty inputPath"
200  ai:translation-kb-resolve    targetLang: 5
     "ai:translation-kb-resolve expected non-empty `targetLang`"
200  ai:translation-kb-list       limit: -5
     "kb_list: `limit` must be an integer between 1 and 1000 (got -5)"
200  ai:translate-build-dictionary  inputPath: 123
     "expected a non-empty `inputPath`"
```

The 531-channel no-argument sweep is unchanged:

```
total channels: 531
200: 425   4xx: 84   5xx: 22   transport-errors: 0
```

The 22 are all the intentional `WEB_UNSUPPORTED` 501s. The two sweeps are
complementary: the no-argument one proves a missing object is classified, this
one proves a wrong field type is too.

New regression coverage:

```
apps/web-server/tests/translate-malformed-payloads-e2e.test.ts   # +8 cases (findings 35-36, 39)
packages/translation-core/tests/provider.test.ts                 # +3 cases (finding 35, sparse holes)
packages/translation-core/tests/translate-file-bridge.test.ts    # +2 cases (finding 36)
packages/agent-skills/tests/translate-skill.test.ts              # +3 cases (finding 37)
apps/docs/tests/ai-ipc-translation-handlers.test.ts              # +2 cases (35, 36 desktop side)
```

Suites after this pass:

```
packages/translation-core   219 tests / 12 files
packages/agent-skills       190 tests / 15 files
apps/web-server             126 tests / 24 files
apps/docs                  2334 tests / 243 files
```

### 40 — Non-string glossaryCategory / sourceLanguage / customerName crashed the translation prompt builder

`englishLabelFor(value)` and `buildTranslateSystemPrompt({ glossaryCategory })` called `value.indexOf` and `glossaryCategory.trim` straight off the wire. `getLanguage` accepted only `string | undefined | null`, so a renderer that posted `glossaryCategory: 7` (or `{}`, `[]`, `true`) reached the prompt builder and either crashed `value3.indexOf is not a function` (IPC) or answered HTTP 500 `opts.glossaryCategory.trim is not a function`. The bucket filter then either silently dropped the customer's terms (when `bucketFor` saw the field as `undefined`) or saved an unscoped entry that leaked as a cache hit for every customer.

Fixed in `packages/translation-core/src/languages.ts` (`getLanguage` / `englishLabelFor` now type-guard `value`), `packages/translation-core/src/prompt.ts` (`buildTranslateSystemPrompt` / `normalizeSourceLang`), `packages/translation-core/src/memory.ts` (`keyOf` now type-guards `bucket`), and the IPC / HTTP entry points in `apps/web-server/src/ai/chat.ts`, `apps/web-server/src/ai/translate-http.ts`, `apps/docs/src/main/docs-main.ts` — each rejects `glossaryCategory` / `customerName` / `sourceLanguage` that is not a string with a structured `INVALID_ARGUMENT` / `glossaryCategory must be a string` / `customerName must be a string` reply.

### 41 — `docs:respell-kick` answered 404 on the web build (no-op now registered)

The Electron main process has `docs:respell-kick` to type one trusted keystroke (Blink respells on real input only). The web-server had no handler for it; the IPC transport answered 404 `IPC_NO_HANDLER`, which the docs renderer's `.catch(() => undefined)` swallowed, so re-enabling spellcheck in a browser silently did nothing. `apps/web-server/src/docs/index.ts` now registers an explicit `{ ok: true, supported: false }` no-op: the renderer can stop logging the missing handler, and the user can respell by typing (the same final state as the desktop path, without the synthetic keystroke). The web bridge does not override the channel — the existing IPC-backed call hits the new handler.

### 42 — Web-server `ai:translate-batch` read memory through a different instance than `ai:save-translation-memory`

The web-server `ai:translate-batch` worker fanned each unit through `callTranslateTool('translate_text', …)` which executes against the pi session's `memoryInstance`. `ai:save-translation-memory` writes to `chat.ts`'s `translationMemory` directly. Both injection paths point at the same object (`setTranslateMemory(translationMemory)`), but the worker never checked the shared TM before going through the model. A unit whose source text was just saved as a memory hit fell through to the model and was retranslated, hiding the save. The worker now reads `translationMemory.lookup(...)` first and only invokes the pi tool on a miss, so the IPC path and the save path see the same bucket.

### 43 — `pickInvalidStringField` shared by HTTP + SSE translation endpoints

The same wire-shape guard that rejects `glossaryCategory: 7` on `/api/ai/translate` (400 `INVALID_ARGUMENT`) was missing on the streaming counterpart `/api/ai/translate/stream` — it would have leaked the same prompt-builder 500 through an SSE `error` event. `apps/web-server/src/ai/translate-http.ts` now exports `pickInvalidStringField` and both endpoints run it before the model call.

## Remaining




- The embedded Dataflare branches are unit-tested through
  `buildEmbedTranslateBody`, and the HTTP endpoint they call is exercised
  live; the full parent-window round trip still needs a Dataflare host.
- `informationLength` weights Han / kana / hangul at 2.5. The ratio
  thresholds (`0.25` / `6.0`) were not re-tuned; the weighting alone removed
  the observed false positives and no false negative turned up in the spot
  check.
- `MemorySaveRequest.scene` is declared but unused (`bucket` replaced its
  grouping role). Harmless; left in place for wire compatibility.
- The transport status sweep covers the no-argument call for every channel.
  A channel whose argument is present but of the wrong shape can still answer
  500 if its handler does not validate; the sweep only proves the most common
  malformed request is classified.
- The 22 `WEB_UNSUPPORTED` channels are registered so `/api/channels` matches
  the desktop channel list. If one of them gains a web implementation the
  sweep keeps passing, so its 501 branch has to be deleted by hand.
- A knowledge base the user hand-edited can still hold a row with an
  identifying field but a nonsense value (a `term` whose `targetTerm` is
  `"???"`). Validation checks that a field is present and non-empty, not that
  it is sensible; that needs a human.
- `TranslationKbEntry.preference` exists only to read rows written by the old
  `kb_upsert` shortcut. It can be deleted once no KB file in use contains one.
- The shape sweep covers the translation channels and the fields this pass
  touched. A channel outside that set can still answer 500 for a wrong field
  type if its handler reads the field without checking it; the no-argument
  sweep is the only thing covering those.

- The SSE stream is now safe against a throw in its post-header region, but
  the same pattern (write the header, then start the guarded block) may exist
  on other long-lived endpoints. `/api/ipc/events` and `/api/ai/stream` were
  not audited for it in this pass.
- `src/ai/__tests__/*.test.ts` are `node:test` files and `vitest.config.ts`
  only includes `tests/**`, so they never run in CI. The HTTP coverage added
  this pass lives in `tests/` for that reason; the older files are dead weight
  unless a runner is added for them.
- `unitId` is coerced to a string in the batch result. The docs renderer keys
  its own map on it, so a numeric id from a caller now comes back as `''`
  rather than surviving as a non-string. No known caller sends one.
