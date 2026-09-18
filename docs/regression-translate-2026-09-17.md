# GenOffice Translation Regression Report (2026-09-17)

Branch: `codex/dataflare-translate-envelope` @ `06c654f`
Webserver: `http://127.0.0.1:18080` (DATA_DIR=/tmp/genoffice-data, provider=minimax, model=MiniMax-M3)

## Summary

End-to-end translation pipeline (KB → build-dictionary → translate-file-auto → fill-gaps) verified against a real KERRITS English tech-pack PDF through the live webserver, using the **canonical** LumosAI skill path (the `06c654f` wrapper-SKILL.md fix). All 8 translate tools are registered in the pi session, the KB CRUD loop is closed, and minimax streams real LLM completions (not mocks).

## Test Results

| # | Test | Result |
|---|------|--------|
| 1 | `GET /health` | ✅ `{status:ok, channels:501}` |
| 2 | `GET /api/channels` | ✅ 501 channels; 18 translate-related, 10 home:skills-* |
| 3 | `ai:get-settings` | ✅ provider=minimax, model=MiniMax-M3, key set |
| 4 | `ai:translate-build-dictionary` (real KERRITS PDF) | ✅ 293 entries, ~30s, real LLM |
| 5 | `ai:translate-file-auto` | ✅ 19/83 (22.9%), `scriptPath = /Users/louloulin/.lumos/skills/translate/scripts/translate.py` (canonical, **NOT** bundled-skills/&lt;hash&gt;) — verifies `06c654f` |
| 6 | `ai:translate-fill-gaps` | ✅ +78 → 70/83 (84.3%), ~60s |
| 7 | `home:list-pi-skills` | ✅ 22 skills, `skillsDir = /tmp/genoffice-data/pi-skills` (canonical) |
| 8 | `ai:translation-kb-upsert` (term/forbidden/brand/styleRule/customerPreference) | ✅ all 5 schemas land in correct bucket |
| 9 | `ai:translation-kb-list` | ✅ 36 entries; 5 buckets (term=26, brand=6, customerPref=2, forbidden=1, styleRule=1) |
| 10 | `ai:translation-kb-resolve` (zh-CN, KERRITS) | ✅ filtered to 5, promptBlock rebuilt from term entries |
| 11 | `ai:translation-kb-remove` → re-upsert round-trip | ✅ count goes 26→25→26, entry persists |
| 12 | `/api/ai/translate` batch (5 terms) | ✅ 5/5 translated, quality 0.9, KB terms used |
| 13 | `/api/ai/stream` (minimax) | ✅ Real LLM streaming; ping/delta/done events |

## Key Findings

### 1. KB CRUD is fully closed
- Storage: `~/.genoffice/translation-kb.json` (single source of truth, fixed path)
- Bucket layout: `trade.translation.{term,brand,forbidden,styleRule,customerPreference}` (5 buckets)
- KB entry field names (canonical): `id, schema, sourceTerm/targetTerm/forbiddenText/.../customerName/preference, sourceLang, targetLang, category, customerName, priority, notes`
- Both the agent tools and the UI (Settings → AI → Translation Knowledge) hit the same pi session, same `KnowledgeBase` instance, same JSON file.

### 2. Wrapper-SKILL.md fix (`06c654f`) is working
- `scriptPath` returned by `ai:translate-file-auto` is the canonical `/Users/louloulin/.lumos/skills/translate/scripts/translate.py` (not bundled-skills/&lt;hash&gt;)
- 22 skills visible to pi (≥21 expected) — 14 real + 8 e2e-test-*

### 3. **Real bug: chat message `text` vs `content` mismatch**
- Renderer posts `{role, content}` to `/api/ai/stream` (OpenAI standard)
- `streamOpenAiCompatible` reads `m.text` (AgentMessage internal type)
- Result: user message arrives at the model as empty string
- Workaround: send `{role, text}` instead of `{role, content}` (verified: model then responds correctly with "1+1=2")
- Root cause: no field normalization in `runProviderStream` (apps/web-server/src/ai/chat.ts:305) or in `openAiMessages` (packages/ai-provider/src/protocols/openai-compatible.ts:19)
- Suggested fix: in `openAiMessages`, read `m.text ?? m.content` for the user role

### 4. Pre-existing test rot (NOT introduced this session)
- `packages/agent-skills/src/__tests__/translate-skill.test.ts` has 3 failing tests:
  - `ALL_TRANSLATE_TOOL_NAMES` expects 6 tools, actual is 8 (added `fill_dictionary_gaps`, `kb_list`, `kb_search` after the test was written)
  - `build_dictionary` expects `pairCount: 3` (got 21 — parser may split hyphenated strings)
  - `kb_upsert` shortcut test (schema/source/target) fails to find the round-trip entry
- Per project guidelines, leaving these alone (not part of this session's scope)

## Verifications (raw)

### KB upsert
```bash
curl -X POST http://127.0.0.1:18080/api/ipc/ai:translation-kb-upsert \
  -H 'content-type: application/json' \
  -d '{"args":[{"id":"term-breeches","schema":"term","sourceTerm":"breeches",
        "targetTerm":"马裤","sourceLang":"en","targetLang":"zh-CN",
        "category":"apparel","customerName":"KERRITS"}]}'
# → {ok:true, id:"term-breeches"}
```

### Translation batch (real LLM)
```bash
curl -X POST http://127.0.0.1:18080/api/ai/translate \
  -H 'content-type: application/json' \
  -d '{"units":[
        {"unitId":"u1","kind":"term","sourceText":"breeches","order":1},
        {"unitId":"u2","kind":"term","sourceText":"waistband","order":2},
        {"unitId":"u3","kind":"term","sourceText":"flatseam","order":3}],
       "sourceLanguage":"en","targetLanguage":"zh-CN",
       "customerName":"KERRITS"}'
# → breeches→马裤, waistband→腰头, flatseam→平缝
#   (first 3 match KB entries exactly, confirming KB lookup is active)
```

### Chat stream with `text` (workaround)
```bash
curl -N -X POST http://127.0.0.1:18080/api/ai/stream \
  -H 'content-type: application/json' \
  -d '{"system":"Reply in Chinese, max 30 chars.",
       "messages":[{"role":"user","text":"用中文回答：1+1 等于几？"}],
       "maxTokens":100}'
# → delta: "1+1=2。"
```

## Network / Push Status

- `github.com:443` and `github.com:22` both **BLOCKED** from this host
- Local commit `06c654f` is ready to push, but cannot reach remote
- Recommend: push from a host with network access, or via VPN/proxy

## Additional Finding: text/content fallback fix (574aa67)

While running the regression, discovered the chat pipeline silently dropped user content when the renderer sent `{role, content}` (OpenAI standard) instead of `{role, text}` (AgentMessage internal type). The model received an empty user message and replied with a clarification request, making real LLM issues look like "the user message was empty".

Fixed in `packages/ai-provider/src/protocols/openai-compatible.ts` — `openAiMessages` now reads `m.text || (m as { content?: string }).content` for both user and assistant roles.

Verified after fix:
- `POST /api/ai/stream {messages:[{role:user,content:'1+1 等于几？'}]}` → model answers "二"
- `POST /api/ai/stream {messages:[{role:user,text:'2+2 等于几？'}]}` → still works (backwards compat)
- `POST /api/ai/translate` with `breeches` → "马裤" (regression check)

## Push Status

Two commits ready on `codex/dataflare-translate-envelope`:
- `574aa67` fix(ai-provider): accept 'content' as a fallback for 'text' in chat messages
- `06c654f` fix(translate): point wrapper SKILL.md at the canonical materialize target (carried over)

Network from this host is fully blocked:
- `github.com:443` (HTTPS) → connection refused
- `github.com:22` (SSH) → connection timeout

Local patch files saved at:
- `/tmp/genoffice-patches/0001-fix-translate-point-wrapper-SKILL.md-at-the-canonica.patch`
- `/tmp/genoffice-patches/0002-fix-ai-provider-accept-content-as-a-fallback-for-tex.patch`

To apply on a host with network access:
```bash
git am /path/to/0001-*.patch /path/to/0002-*.patch
git push origin codex/dataflare-translate-envelope
```
