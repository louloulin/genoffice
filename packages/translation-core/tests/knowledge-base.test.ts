import { describe, expect, it } from 'vitest'

import {
  KnowledgeBase,
  SCHEMA_IDS,
  SCOPES,
  type KnowledgeBaseFileSystem,
  type KBStore,
} from '../src/knowledge-base'

class MemoryFS implements KnowledgeBaseFileSystem {
  files = new Map<string, string>()
  async mkdir(p: string) {
    void p
  }
  async readFile(p: string) {
    const v = this.files.get(p)
    if (v === undefined) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return v
  }
  async writeFile(p: string, contents: string) {
    this.files.set(p, contents)
  }
  async rename(from: string, to: string) {
    const v = this.files.get(from)
    if (v !== undefined) {
      this.files.set(to, v)
      this.files.delete(from)
    }
  }
}

function makeFS(): MemoryFS {
  return new MemoryFS()
}

describe('KnowledgeBase', () => {
  it('upserts entries into the right schema by discriminator', () => {
    const kb = new KnowledgeBase({ filePath: '/tmp/kb.json', fileSystem: makeFS() })
    const termId = kb.upsert({
      id: 't1',
      scope: 'company',
      priority: 3,
      sourceTerm: '克重',
      targetTerm: 'GSM',
    })
    expect(termId).toMatchObject({ sourceTerm: '克重' })
    const brand = kb.upsert({
      id: 'b1',
      scope: 'global',
      priority: 5,
      word: 'YKK',
      policy: 'neverTranslate',
    })
    expect(kb.list({ schema: 'term' })).toHaveLength(1)
    expect(kb.list({ schema: 'brand' })).toHaveLength(1)
    expect(kb.list()).toHaveLength(2)
    void brand
  })

  it('rejects an entry no schema can classify instead of filing it as a preference', () => {
    // `schemaForEntry` used to end with `return customerPreference` as a
    // catch-all, so `{}` and `{ id }` were persisted as customer preferences
    // with no customer and no preference. Three such rows were found in a
    // real KB file, written by channel probes and indistinguishable from user
    // data once written. Nothing may be stored without an identifying field.
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    for (const entry of [{}, { id: 'blank-1' }, { id: 'blank-2', scope: 'company', priority: 5 }]) {
      expect(() => kb.upsert(entry as never), JSON.stringify(entry)).toThrow(/identifying field/)
    }
    expect(kb.list()).toHaveLength(0)
  })

  it('rejects a declared schema whose identifying fields are missing', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    // The shortcut form used by `kb_upsert` sends a schema before the payload
    // is filled in; without the payload the row would resolve to nothing.
    expect(() =>
      kb.upsert({ id: 't-blank', schema: 'term', scope: 'company', priority: 5 } as never),
    ).toThrow(/identifying field/)
    expect(() =>
      kb.upsert({
        id: 't-no-target',
        schema: 'term',
        scope: 'company',
        priority: 5,
        sourceTerm: 'fabric weight',
      } as never),
    ).toThrow(/identifying field/)
    expect(kb.list()).toHaveLength(0)
  })

  it('honours an explicit schema over field sniffing', () => {
    // A forbidden entry that also carries a `name` used to be filed as a
    // style rule, because sniffing matched `name` + `description` before the
    // entry's own `schema` was ever read.
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 'f-declared',
      schema: 'forbidden',
      scope: 'company',
      priority: 5,
      forbiddenText: 'all cotton',
      name: 'Also a style-rule field',
      description: 'Also a style-rule field',
    } as never)
    expect(kb.list({ schema: 'forbidden' })).toHaveLength(1)
    expect(kb.list({ schema: 'styleRule' })).toHaveLength(0)
  })

  it('does not treat a prototype key as a schema name', () => {
    // `'constructor' in KEY_TO_SCHEMA` is true through the prototype chain, so
    // a lookup by `in` handed back `Object.prototype.constructor` as if it
    // were a schema id and the entry was stored in a bucket derived from a
    // function. Reject the unknown name instead.
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    expect(() =>
      kb.upsert({
        id: 'x',
        schema: 'toString',
        scope: 'company',
        priority: 5,
        sourceTerm: 'a',
        targetTerm: 'b',
      } as never),
    ).toThrow(/identifying field/)
    expect(kb.list()).toHaveLength(0)
  })

  it('replaces an entry with the same id on upsert', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 't1',
      scope: 'company',
      priority: 3,
      sourceTerm: '克重',
      targetTerm: 'GSM',
    })
    kb.upsert({
      id: 't1',
      scope: 'company',
      priority: 3,
      sourceTerm: '克重',
      targetTerm: 'Weight (g/m²)',
    })
    expect(kb.list({ schema: 'term' })).toHaveLength(1)
    expect((kb.list({ schema: 'term' })[0] as { targetTerm: string }).targetTerm).toBe(
      'Weight (g/m²)',
    )
  })

  it('resolve() orders rules scope > priority > id', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 't-company-3',
      scope: 'company',
      priority: 3,
      sourceTerm: '克重',
      targetTerm: 'GSM',
    })
    kb.upsert({
      id: 't-customer-3',
      scope: 'customer',
      priority: 3,
      sourceTerm: '克重',
      targetTerm: 'Weight',
    })
    kb.upsert({
      id: 't-customer-9',
      scope: 'customer',
      priority: 9,
      sourceTerm: '面料',
      targetTerm: 'Fabric',
    })
    kb.upsert({
      id: 'f-company',
      scope: 'company',
      priority: 3,
      forbiddenText: 'all cotton',
      replacement: '100% cotton',
    })
    kb.upsert({
      id: 's-company',
      scope: 'company',
      priority: 3,
      name: 'formal',
      description: 'use formal business tone',
    })

    const r = kb.resolve({ sourceLang: 'en-US', targetLang: 'zh-CN' })
    // Highest priority (customer / 9) wins over the customer/3 entry.
    expect((r.terms[0] as { sourceTerm: string }).sourceTerm).toBe('面料')
    expect((r.terms[0] as { targetTerm: string }).targetTerm).toBe('Fabric')
    // The customer/3 entry still surfaces — the company-scope duplicate loses.
    const customerThree = r.terms.find(
      (t) => (t as { sourceTerm: string }).sourceTerm === '克重',
    )
    expect(customerThree).toBeDefined()
    expect((customerThree as { targetTerm: string }).targetTerm).toBe('Weight')
    expect(r.forbidden).toHaveLength(1)
    expect(r.styleRules).toHaveLength(1)
    expect(r.brands).toHaveLength(0)
    // customer-preference stays empty because customerName is unset
    expect(r.customerPreferences).toHaveLength(0)
    expect(r.promptBlock).toContain('Translation rules (en-US -> zh-CN)')
    expect(r.promptBlock).toContain('Weight')
    expect(r.promptBlock).toContain('100% cotton')
  })

  it('resolve() filters by language pair and customerName', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 't-1',
      scope: 'global',
      priority: 1,
      sourceTerm: 'pin',
      targetTerm: '别针',
      sourceLang: 'en',
      targetLang: 'zh-CN',
    })
    kb.upsert({
      id: 't-2',
      scope: 'global',
      priority: 1,
      sourceTerm: 'pin',
      targetLang: 'zh-CN',
      sourceLang: 'en',
      targetTerm: '徽章',
    })
    // Same source but different target lang — only the matching pair should resolve.
    kb.upsert({
      id: 't-3',
      scope: 'global',
      priority: 1,
      sourceTerm: 'pin',
      targetTerm: '針',
      sourceLang: 'en',
      targetLang: 'zh-TW',
    })
    kb.upsert({
      id: 'cp-1',
      scope: 'customer',
      priority: 5,
      customerName: 'Nike',
      preferenceType: 'fabricUnit',
      value: 'GSM',
    })
    kb.upsert({
      id: 'cp-2',
      scope: 'customer',
      priority: 5,
      customerName: 'Adidas',
      preferenceType: 'fabricUnit',
      value: 'g/m²',
    })

    const en = kb.resolve({ sourceLang: 'en', targetLang: 'zh-CN' })
    expect(en.terms.map((t) => (t as { targetTerm: string }).targetTerm)).toEqual(
      expect.arrayContaining(['别针', '徽章']),
    )
    expect(en.terms.find((t) => (t as { targetTerm: string }).targetTerm === '針')).toBeUndefined()

    const nike = kb.resolve({
      sourceLang: 'en',
      targetLang: 'zh-CN',
      customerName: 'Nike',
    })
    expect(nike.customerPreferences).toHaveLength(1)
    expect((nike.customerPreferences[0] as { customerName: string }).customerName).toBe('Nike')
  })

  it('refresh() picks up a write made by another process', async () => {
    const fs = makeFS()
    const kb = new KnowledgeBase({ filePath: '/tmp/kb.json', fileSystem: fs })
    await kb.load()

    // Another writer (the pi session's KB, in the web build) replaces the file.
    const other = new KnowledgeBase({ filePath: '/tmp/kb.json', fileSystem: fs })
    other.upsert({
      id: 't-shared',
      scope: 'company',
      priority: 5,
      sourceTerm: 'fabric weight',
      targetTerm: '克重',
    })
    await other.save()

    // A long-lived reader holds the boot snapshot until it refreshes.
    expect(kb.resolve({ sourceLang: 'en-US', targetLang: 'zh-CN' }).terms).toHaveLength(0)
    expect(await kb.refresh()).toBe(true)
    expect(
      kb.resolve({ sourceLang: 'en-US', targetLang: 'zh-CN' }).terms.map((t) => t.sourceTerm),
    ).toEqual(['fabric weight'])
    // Second call short-circuits on identical bytes.
    expect(await kb.refresh()).toBe(false)
  })

  it('refresh() keeps the last good store when the file is malformed', async () => {
    const fs = makeFS()
    const kb = new KnowledgeBase({ filePath: '/tmp/kb.json', fileSystem: fs })
    kb.upsert({
      id: 't-keep',
      scope: 'company',
      priority: 5,
      sourceTerm: 'pin',
      targetTerm: '别针',
    })
    fs.files.set('/tmp/kb.json', 'not json')
    expect(await kb.refresh()).toBe(false)
    // Degrading to slightly-stale terminology beats failing the translation.
    expect(kb.resolve({ sourceLang: 'en-US', targetLang: 'zh-CN' }).terms).toHaveLength(1)
  })

  it('resolve() collapses duplicate source→target rows but keeps synonyms', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    const term = (id: string, target: string) => ({
      id,
      scope: 'company' as const,
      priority: 5,
      sourceTerm: 'fabric weight',
      targetTerm: target,
    })
    // A re-imported / re-seeded KB carries the same mapping twice; that is
    // prompt noise and a double-counted matchedTerms badge.
    kb.upsert(term('dup-1', '克重'))
    kb.upsert(term('dup-2', '克重'))
    // Two rows agreeing on the source but disagreeing on the target are
    // synonyms the user added on purpose — never silently drop those.
    kb.upsert(term('syn-1', '克重(g/m²)'))
    const resolved = kb.resolve({ sourceLang: 'en-US', targetLang: 'zh-CN' })
    expect(resolved.terms.map((t) => (t as { targetTerm: string }).targetTerm).sort()).toEqual([
      '克重',
      '克重(g/m²)',
    ])
  })

  it('resolve() applies a language-scoped entry when the source is auto-detect', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 't-auto',
      scope: 'company',
      priority: 5,
      sourceTerm: 'fabric weight',
      targetTerm: '克重',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
    })
    // The renderer's source picker defaults to auto-detect, so this is the
    // common case: an entry that names its source language used to be filtered
    // out of every default call and the KB the user curated never applied.
    const auto = kb.resolve({ sourceLang: 'auto', targetLang: 'zh-CN' })
    expect(auto.terms.map((t) => t.sourceTerm)).toContain('fabric weight')
  })

  it('resolve() tolerates a missing region code in the entry', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 't-regionless',
      scope: 'company',
      priority: 5,
      sourceTerm: 'pin',
      targetTerm: '别针',
      sourceLang: 'en',
      targetLang: 'zh-CN',
    })
    expect(
      kb.resolve({ sourceLang: 'en-US', targetLang: 'zh-CN' }).terms.map((t) => t.sourceTerm),
    ).toContain('pin')
  })

  it('resolve() keeps two explicit regions of the same language apart', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 't-zh-hans',
      scope: 'company',
      priority: 5,
      sourceTerm: 'pin',
      targetTerm: '别针',
      sourceLang: 'zh-CN',
      targetLang: 'en-US',
    })
    const traditional = kb.resolve({ sourceLang: 'zh-TW', targetLang: 'en-US' })
    expect(traditional.terms.map((t) => t.sourceTerm)).not.toContain('pin')
  })

  it('resolve() narrows term entries by category or customerName', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 'term-generic',
      scope: 'company',
      priority: 10,
      sourceTerm: 'fabric weight',
      targetTerm: '克重',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'apparel',
    })
    kb.upsert({
      id: 'term-kerrits',
      scope: 'company',
      priority: 10,
      sourceTerm: 'fabric weight',
      targetTerm: '克重(KERRITS)',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'apparel',
      customerName: 'KERRITS',
    })
    kb.upsert({
      id: 'term-acme',
      scope: 'company',
      priority: 10,
      sourceTerm: 'fabric weight',
      targetTerm: '克重(ACME)',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'apparel',
      customerName: 'ACME',
    })

    // A caller that only knows the customer name (glossaryCategory carries
    // the customer) must see that customer's term and not the other's.
    const kerrits = kb.resolve({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'KERRITS',
    })
    const kerritsTargets = kerrits.terms.map((t) => (t as { targetTerm: string }).targetTerm)
    expect(kerritsTargets).toContain('克重(KERRITS)')
    expect(kerritsTargets).not.toContain('克重(ACME)')

    // The other customer's bucket excludes the first customer's term.
    const acme = kb.resolve({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'ACME',
    })
    const acmeTargets = acme.terms.map((t) => (t as { targetTerm: string }).targetTerm)
    expect(acmeTargets).toContain('克重(ACME)')
    expect(acmeTargets).not.toContain('克重(KERRITS)')

    // An explicit customerName narrows the same way.
    const byName = kb.resolve({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      customerName: 'KERRITS',
    })
    const byNameTargets = byName.terms.map((t) => (t as { targetTerm: string }).targetTerm)
    expect(byNameTargets).toContain('克重(KERRITS)')
    expect(byNameTargets).not.toContain('克重(ACME)')
  })

  it('renders a legacy `preference`-shaped row instead of undefined=undefined', () => {
    // The schema is `{ customerName, preferenceType, value }`, but the pi
    // `kb_upsert` shortcut wrote a single `preference` blob. Rows like that
    // exist in real KB files; rendering only `preferenceType`/`value` turned
    // them into "KERRITS: undefined=undefined" in the prompt.
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 'legacy-pref',
      schema: 'customerPreference',
      customerName: 'KERRITS',
      preference: '工艺单以马术服饰为主',
    } as never)
    kb.upsert({
      id: 'typed-pref',
      schema: 'customerPreference',
      customerName: 'ACME',
      preferenceType: 'fabricUnit',
      value: 'g/m²',
    } as never)

    const resolved = kb.resolve({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      customerName: 'KERRITS',
      category: 'KERRITS',
    })
    expect(resolved.promptBlock).toContain('KERRITS: preference=工艺单以马术服饰为主')
    expect(resolved.promptBlock).not.toContain('undefined')

    const acme = kb.resolve({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      customerName: 'ACME',
      category: 'ACME',
    })
    expect(acme.promptBlock).toContain('ACME: fabricUnit=g/m²')
  })

  it('rejects a preference row with no content at all', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    expect(() =>
      kb.upsert({ id: 'empty-pref', schema: 'customerPreference', customerName: 'ACME' } as never),
    ).toThrow(/identifying field/)
  })

  it('resolve() never leaks another customer\'s preferences', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 'cp-nike',
      scope: 'customer',
      priority: 5,
      customerName: 'Nike',
      preferenceType: 'fabricUnit',
      value: 'GSM',
    })
    kb.upsert({
      id: 'cp-adidas',
      scope: 'customer',
      priority: 5,
      customerName: 'Adidas',
      preferenceType: 'fabricUnit',
      value: 'g/m²',
    })

    // Regression: the filter used to be skipped whenever the caller left
    // `customerName` unset, so a KERRITS call (which passes the customer as
    // `category`) inherited *every* customer's preferences.
    const kerrits = kb.resolve({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'KERRITS',
    })
    expect(kerrits.customerPreferences).toHaveLength(0)

    const unscoped = kb.resolve({ sourceLang: 'en-US', targetLang: 'zh-CN' })
    expect(unscoped.customerPreferences).toHaveLength(0)

    const adidas = kb.resolve({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'Adidas',
    })
    expect(adidas.customerPreferences.map((p) => (p as { customerName: string }).customerName)).toEqual([
      'Adidas',
    ])
  })

  it('shadows a shared term with the customer\'s own mapping for that source', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 'shared-fabric-weight',
      scope: 'company',
      priority: 10,
      sourceTerm: 'fabric weight',
      targetTerm: '克重',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'apparel',
    })
    kb.upsert({
      id: 'kerrits-fabric-weight',
      scope: 'customer',
      priority: 10,
      sourceTerm: 'fabric weight',
      targetTerm: '克重(K)',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'apparel',
      customerName: 'KERRITS',
    })

    // Regression: both entries used to resolve together, so the prompt carried
    // two conflicting `fabric weight` rules and the winner was up to the model
    // (and to `applyTerminology` tie-breaking).
    const kerrits = kb.resolve({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      customerName: 'KERRITS',
    })
    expect(kerrits.terms.map((t) => (t as { targetTerm: string }).targetTerm)).toEqual(['克重(K)'])

    // The shared mapping still applies for everyone else.
    const generic = kb.resolve({ sourceLang: 'en-US', targetLang: 'zh-CN' })
    expect(generic.terms.map((t) => (t as { targetTerm: string }).targetTerm)).toEqual(['克重'])
  })

  it('keeps same-specificity synonyms for one source instead of dropping one', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 'pin-a',
      scope: 'company',
      priority: 10,
      sourceTerm: 'pin',
      targetTerm: '别针',
      sourceLang: 'en',
      targetLang: 'zh-CN',
    })
    kb.upsert({
      id: 'pin-b',
      scope: 'company',
      priority: 10,
      sourceTerm: 'pin',
      targetTerm: '徽章',
      sourceLang: 'en',
      targetLang: 'zh-CN',
    })
    const resolved = kb.resolve({ sourceLang: 'en', targetLang: 'zh-CN' })
    expect(resolved.terms).toHaveLength(2)
  })

  it('save() then load() round-trips', async () => {
    const fs = makeFS()
    const path = '/tmp/kb.json'
    const kb1 = new KnowledgeBase({ filePath: path, fileSystem: fs })
    kb1.upsert({
      id: 't-1',
      scope: 'company',
      priority: 3,
      sourceTerm: '克重',
      targetTerm: 'GSM',
    })
    kb1.upsert({
      id: 'b-1',
      scope: 'global',
      priority: 5,
      word: 'YKK',
      policy: 'neverTranslate',
    })
    await kb1.save()
    expect(kb1.isDirty()).toBe(false)

    const kb2 = new KnowledgeBase({ filePath: path, fileSystem: fs })
    await kb2.load()
    expect(kb2.list()).toHaveLength(2)
    expect(kb2.list({ schema: 'term' })).toHaveLength(1)
    expect(kb2.list({ schema: 'brand' })).toHaveLength(1)
  })

  it('load() returns an empty store when the file is missing', async () => {
    const fs = makeFS()
    const kb = new KnowledgeBase({ filePath: '/tmp/missing.json', fileSystem: fs })
    await kb.load()
    expect(kb.list()).toEqual([])
  })

  it('remove() deletes the entry from every schema bucket', () => {
    const kb = new KnowledgeBase({ fileSystem: makeFS() })
    kb.upsert({
      id: 'shared-id',
      scope: 'company',
      priority: 3,
      sourceTerm: '克重',
      targetTerm: 'GSM',
    })
    kb.upsert({
      id: 'shared-id',
      scope: 'global',
      priority: 5,
      word: 'YKK',
      policy: 'neverTranslate',
    })
    expect(kb.remove('shared-id')).toBe(true)
    expect(kb.remove('shared-id')).toBe(false)
    expect(kb.list()).toEqual([])
  })

  it('every schema + scope is enumerable', () => {
    expect(SCHEMA_IDS).toHaveLength(5)
    expect(SCOPES).toEqual(['session', 'customer', 'project', 'company', 'global'])
  })

  it('seed constructor populates the store', () => {
    const seed: KBStore = {
      'trade.translation.term': [
        {
          id: 't-1',
          scope: 'company',
          priority: 3,
          sourceTerm: '克重',
          targetTerm: 'GSM',
        },
      ],
    }
    const kb = new KnowledgeBase({ seed, fileSystem: makeFS() })
    expect(kb.list({ schema: 'term' })).toHaveLength(1)
  })
})
