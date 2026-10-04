/**
 * Read/write access to Dataflare's **translation storage** — the space-scoped
 * glossary and translation memory that back the editor's translation.
 *
 * This is the client half of a deliberately narrow contract: Dataflare stores,
 * GenOffice translates. The editor never talks to those tables directly, it
 * asks the host to replay one HTTP call on its behalf (the iframe holds no
 * credential of its own), and the host decides what the editor may reach.
 *
 * Three rules this module exists to enforce, each of which has a silent
 * failure mode if it is left to the caller:
 *
 *   1. **Every read is scoped.** A term list fetched without the space id
 *      returns the tenant-wide set, which looks like a correct answer and is
 *      the wrong one inside a space — the editor would offer terms the space
 *      never approved. The space id therefore comes from the embed context and
 *      is attached by the client, not passed by each call site.
 *   2. **Writes carry the same scope.** A term saved without a space id lands in
 *      the tenant-shared table, where every space can read it back. Sharing
 *      that has to be an explicit choice, so the default is "this space".
 *   3. **A non-zero `code` is an error.** The host answers with a `Result`
 *      envelope; a 200 carrying `{ code: 500, … }` is a failure, and returning
 *      `data` from it would show an empty glossary as "no terms configured".
 */

/** Host endpoint for the space-scoped glossary (Dataflare route, not GenOffice's). */
export const TRANSLATION_GLOSSARY_PATH = '/crmapi/drive/translation/glossary'
/** Host endpoint for the space-scoped translation memory. */
export const TRANSLATION_MEMORY_PATH = '/crmapi/drive/translation/memory'

/** One glossary row, as Dataflare returns it. */
export interface GlossaryTerm {
  id?: number
  sourceTerm: string
  targetTerm: string
  sourceLang?: string
  targetLang?: string
  category?: string
  remark?: string | null
  /** null = tenant-shared; a number = private to that drive space. */
  spaceId?: number | null
}

/** One memory row, as Dataflare returns it. */
export interface MemoryEntry {
  id?: number | null
  sourceText?: string | null
  translatedText?: string | null
  sourceLanguage?: string | null
  targetLanguage?: string | null
  scene?: string | null
  /** null = tenant-shared; a number = private to that drive space. */
  spaceId?: number | null
  createTime?: string | null
}

/** The storage operations the editor needs during translation. */
export interface TranslationStorageClient {
  listGlossary(params?: { targetLanguage?: string; category?: string }): Promise<GlossaryTerm[]>
  upsertGlossary(term: GlossaryTerm): Promise<void>
  deleteGlossary(id: number): Promise<void>
  listMemory(params?: { targetLanguage?: string; sourceLanguage?: string; limit?: number }): Promise<MemoryEntry[]>
  saveMemory(payload: {
    sourceLanguage?: string
    targetLanguage: string
    units: Array<{ sourceText: string; translatedText: string }>
  }): Promise<{ savedCount: number; skippedCount: number }>
}

/** The one host capability this client needs: dual-mode HTTP (see the SDK). */
export type StorageRequest = (path: string, init?: RequestInit) => Promise<Response>

export interface TranslationStorageDeps {
  request: StorageRequest
  /**
   * Current drive space, or null/undefined outside an embedded session.
   * Read per call rather than captured: the user can move between spaces
   * without a reload, and a captured id would keep writing into the space they
   * just left.
   */
  getSpaceId: () => string | null | undefined
}

/** Dataflare's `Result` envelope. */
interface ResultEnvelope<T> {
  code?: number
  data?: T
  message?: string | null
  msg?: string | null
}

function unwrap<T>(envelope: ResultEnvelope<T> | null | undefined, what: string): T {
  // `code` 0 / absent = success. Anything else is a failure even on HTTP 200 —
  // that envelope is exactly how the host reports a business failure.
  const code = envelope?.code ?? 0
  if (code !== 0) {
    throw new Error(envelope?.message || envelope?.msg || `${what}失败（code=${code}）`)
  }
  return envelope?.data as T
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${what}失败：HTTP ${response.status}`)
  }
  const body = (await response.json()) as ResultEnvelope<T>
  return unwrap(body, what)
}

/** Build a query string, dropping empty values so the host applies its own defaults. */
function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * The Dataflare-backed client.
 *
 * The space id is attached here rather than at each call site, which is what
 * makes "scoped by default" a property of the client instead of a convention
 * someone has to remember.
 */
export function createDataflareTranslationStorage(
  deps: TranslationStorageDeps,
): TranslationStorageClient {
  const scopeQuery = (): string => {
    const spaceId = deps.getSpaceId()
    return spaceId ? `spaceId=${encodeURIComponent(spaceId)}` : ''
  }

  return {
    async listGlossary(params = {}) {
      const search = query({
        ...(scopeQuery() ? { spaceId: deps.getSpaceId() } : {}),
        targetLang: params.targetLanguage,
        category: params.category,
      })
      const response = await deps.request(`${TRANSLATION_GLOSSARY_PATH}${search}`)
      const rows = await readJson<GlossaryTerm[]>(response, '读取术语库')
      return Array.isArray(rows) ? rows : []
    },

    async upsertGlossary(term) {
      const spaceId = deps.getSpaceId()
      const response = await deps.request(TRANSLATION_GLOSSARY_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceTerm: term.sourceTerm,
          targetTerm: term.targetTerm,
          sourceLang: term.sourceLang ?? 'auto',
          targetLang: term.targetLang ?? 'en-US',
          category: term.category ?? 'general',
          ...(term.remark ? { remark: term.remark } : {}),
          // `null` 是「与全租户共享」的显式选择；带上 id 就把词条收进那个空间。
          //
          // **id 必须以字符串下发，不能 `Number()`。** 云盘 id 是雪花号
          // （`2106454674846117890` ≈ 2.1e18），超过 JS 的
          // `Number.MAX_SAFE_INTEGER`（9.0e15），`Number()` 之后末位被抹平：
          // 实测 2106454674846117890 变成 2106454674846118000。宿主桥的空间校验
          // 拿它与会话里的真实 id 逐字比较，于是每一次「加术语 / 存记忆」都被判
          // 「space not allowed」—— 而 JSON 里它看着就是一个正常的数字，两端日志
          // 都只有一句 403。后端 `Long?` 反序列化字符串同样成立。
          spaceId: spaceId ?? null,
        }),
      })
      await readJson<number>(response, '保存术语')
    },

    async deleteGlossary(id) {
      const response = await deps.request(`${TRANSLATION_GLOSSARY_PATH}/delete${query({ id })}`, {
        method: 'POST',
      })
      await readJson<boolean>(response, '删除术语')
    },

    async listMemory(params = {}) {
      const search = query({
        ...(scopeQuery() ? { spaceId: deps.getSpaceId() } : {}),
        sourceLanguage: params.sourceLanguage,
        targetLanguage: params.targetLanguage,
        limit: params.limit,
      })
      const response = await deps.request(`${TRANSLATION_MEMORY_PATH}${search}`)
      const rows = await readJson<MemoryEntry[]>(response, '读取翻译记忆')
      return Array.isArray(rows) ? rows : []
    },

    async saveMemory(payload) {
      const spaceId = deps.getSpaceId()
      const response = await deps.request(TRANSLATION_MEMORY_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetLanguage: payload.targetLanguage,
          ...(payload.sourceLanguage ? { sourceLanguage: payload.sourceLanguage } : {}),
          units: payload.units,
          // 同 `upsertGlossary`：字符串下发，`Number()` 会丢雪花号的末几位。
          ...(spaceId ? { spaceId } : {}),
        }),
      })
      const result = await readJson<{ savedCount?: number; skippedCount?: number }>(
        response,
        '保存翻译记忆',
      )
      return { savedCount: result?.savedCount ?? 0, skippedCount: result?.skippedCount ?? 0 }
    },
  }
}
