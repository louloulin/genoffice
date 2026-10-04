import { describe, expect, it } from 'vitest'
import {
  createDataflareTranslationStorage,
  TRANSLATION_GLOSSARY_PATH,
  TRANSLATION_MEMORY_PATH,
  type StorageRequest,
} from '../src/storage'

/** Records every call and answers with a canned `Result` envelope. */
function fakeRequest(
  data: unknown = [],
  overrides: { ok?: boolean; status?: number; code?: number; message?: string } = {},
) {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const request: StorageRequest = async (path, init) => {
    calls.push({ path, ...(init ? { init } : {}) })
    const code = overrides.code ?? 0
    return {
      ok: overrides.ok ?? true,
      status: overrides.status ?? 200,
      json: async () => ({ code, data, ...(overrides.message ? { message: overrides.message } : {}) }),
    } as unknown as Response
  }
  return { request, calls }
}

describe('translation storage client', () => {
  it('reads the glossary scoped to the current space', async () => {
    const { request, calls } = fakeRequest([{ sourceTerm: 'Invoice', targetTerm: '发票' }])
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => '1001' })

    const terms = await client.listGlossary({ targetLanguage: 'zh-CN', category: 'contract' })

    expect(terms).toHaveLength(1)
    const call = calls[0]!
    // A read without the space id answers with the tenant-wide set: correct
    // looking, and the wrong set inside a space.
    expect(call.path).toBe(`${TRANSLATION_GLOSSARY_PATH}?spaceId=1001&targetLang=zh-CN&category=contract`)
  })

  it('omits the space scope outside an embedded session', async () => {
    const { request, calls } = fakeRequest([])
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => null })

    await client.listGlossary()

    expect(calls[0]!.path).toBe(TRANSLATION_GLOSSARY_PATH)
  })

  it('drops empty filters instead of sending them to the host', async () => {
    const { request, calls } = fakeRequest([])
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => '1001' })

    await client.listGlossary({ targetLanguage: '', category: undefined })

    expect(calls[0]!.path).toBe(`${TRANSLATION_GLOSSARY_PATH}?spaceId=1001`)
  })

  it('reads the space id per call so a space switch cannot write into the old one', async () => {
    let spaceId: string | null = '1001'
    const { request, calls } = fakeRequest(0)
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => spaceId })

    await client.upsertGlossary({ sourceTerm: 'A', targetTerm: '甲' })
    spaceId = '2002'
    await client.upsertGlossary({ sourceTerm: 'B', targetTerm: '乙' })

    // Ids go on the wire as strings: a snowflake exceeds MAX_SAFE_INTEGER and
    // `Number()` would flatten its last digits.
    expect(JSON.parse(String(calls[0]!.init?.body)).spaceId).toBe('1001')
    expect(JSON.parse(String(calls[1]!.init?.body)).spaceId).toBe('2002')
  })

  it('sends an explicit null space on write when there is no space (tenant-shared is a choice)', async () => {
    const { request, calls } = fakeRequest(1)
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => undefined })

    await client.upsertGlossary({ sourceTerm: 'A', targetTerm: '甲', remark: 'r' })

    const body = JSON.parse(String(calls[0]!.init?.body))
    expect(body.spaceId).toBeNull()
    expect(body.remark).toBe('r')
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('treats a non-zero code in a 200 response as a failure', async () => {
    // This is the shape the host uses for business errors: returning `data`
    // from it would render an empty glossary as "no terms configured".
    const { request } = fakeRequest([], { code: 500, message: '无权访问云盘空间' })
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => '1001' })

    await expect(client.listGlossary()).rejects.toThrow('无权访问云盘空间')
  })

  it('surfaces an HTTP failure with its status', async () => {
    const { request } = fakeRequest([], { ok: false, status: 403 })
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => '1001' })

    await expect(client.listMemory()).rejects.toThrow('HTTP 403')
  })

  it('normalizes a non-array payload to an empty list', async () => {
    const { request } = fakeRequest(null)
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => '1001' })

    await expect(client.listGlossary()).resolves.toEqual([])
  })

  it('reads memory with its language filters', async () => {
    const { request, calls } = fakeRequest([])
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => '1001' })

    await client.listMemory({ sourceLanguage: 'en-US', targetLanguage: 'zh-CN', limit: 20 })

    expect(calls[0]!.path).toBe(
      `${TRANSLATION_MEMORY_PATH}?spaceId=1001&sourceLanguage=en-US&targetLanguage=zh-CN&limit=20`,
    )
  })

  it('defaults the memory save counts when the host omits them', async () => {
    const { request } = fakeRequest({ savedCount: 3 })
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => '1001' })

    const result = await client.saveMemory({
      targetLanguage: 'zh-CN',
      units: [{ sourceText: 'a', translatedText: '甲' }],
    })

    expect(result).toEqual({ savedCount: 3, skippedCount: 0 })
  })

  it('deletes a term by id on the dedicated route', async () => {
    const { request, calls } = fakeRequest(true)
    const client = createDataflareTranslationStorage({ request, getSpaceId: () => '1001' })

    await client.deleteGlossary(42)

    expect(calls[0]!.path).toBe(`${TRANSLATION_GLOSSARY_PATH}/delete?id=42`)
    expect(calls[0]!.init?.method).toBe('POST')
  })
})
