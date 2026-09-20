import { describe, expect, it, vi } from 'vitest'
import {
  createTabLiveness,
  decideOpen,
  dedupeTabs,
  deriveTabDescriptor,
  MODULE_LABEL,
  MODULE_OF_EXT,
  moduleFileName,
  moduleForPath,
  moduleUrl,
  openPathFromLocation,
  sweepTabs,
  TAB_STORAGE_KEY,
  loadTabs,
  saveTabs,
  type WebTab,
} from '../src/web-tabs'

/**
 * web-tabs: the protocol that keeps the browser TabBar honest.
 *
 * Everything here is a decision that, when wrong, was visible to the user as
 * "clicking a document does nothing" plus a duplicate tab bar entry. The two
 * host-side helpers (`decideOpen`, `sweepTabs`) and the guest's self-identity
 * (`deriveTabDescriptor`) are the parts that must never regress.
 */

const tab = (over: Partial<WebTab> = {}): WebTab => ({
  id: 'web-a',
  kind: 'docs',
  title: 'a.docx',
  windowId: 'web-a',
  ...over,
})

const memoryStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

describe('moduleForPath', () => {
  it('maps every supported extension to its editor', () => {
    expect(MODULE_OF_EXT.docx).toBe('docs')
    expect(MODULE_OF_EXT.xlsx).toBe('sheets')
    expect(MODULE_OF_EXT.xlsm).toBe('sheets')
    expect(MODULE_OF_EXT.xls).toBe('sheets')
    expect(MODULE_OF_EXT.csv).toBe('sheets')
    expect(MODULE_OF_EXT.pptx).toBe('slides')
    expect(MODULE_OF_EXT.ppt).toBe('slides')
    expect(MODULE_OF_EXT.pdf).toBe('pdf')
    expect(MODULE_OF_EXT.md).toBe('markdown')
    expect(MODULE_OF_EXT.markdown).toBe('markdown')
    expect(MODULE_OF_EXT.html).toBe('html')
    expect(MODULE_OF_EXT.htm).toBe('html')
  })

  it('is case-insensitive and survives directories with dots', () => {
    expect(moduleForPath('/tmp/DOC.DOCX')).toBe('docs')
    expect(moduleForPath('/tmp/my.dir/real.xlsx')).toBe('sheets')
    expect(moduleForPath('C:\\Users\\me\\a.PPTX')).toBe('slides')
  })

  it('returns null for unknown and extension-less paths', () => {
    expect(moduleForPath('/tmp/archive.zip')).toBeNull()
    expect(moduleForPath('/tmp/README')).toBeNull()
    expect(moduleForPath('/tmp/weird.')).toBeNull()
    expect(moduleForPath('')).toBeNull()
  })
})

describe('moduleFileName / moduleUrl', () => {
  it('takes the last segment of either separator style', () => {
    expect(moduleFileName('/tmp/files/report.docx')).toBe('report.docx')
    expect(moduleFileName('C:\\Users\\me\\report.docx')).toBe('report.docx')
    expect(moduleFileName(undefined)).toBe('')
  })

  it('routes pdf and html through the hash fragment', () => {
    expect(moduleUrl('pdf', '/tmp/a.pdf')).toBe('/pdf/?mode=tab#open=%2Ftmp%2Fa.pdf')
    expect(moduleUrl('html', '/tmp/a.html')).toBe('/html/?mode=tab#open=%2Ftmp%2Fa.html')
  })

  it('routes the editors through the open query parameter', () => {
    expect(moduleUrl('docs', '/tmp/a.docx')).toBe('/docs/?mode=tab&open=%2Ftmp%2Fa.docx')
    expect(moduleUrl('sheets', '/tmp/a.xlsx')).toBe('/sheets/?mode=tab&open=%2Ftmp%2Fa.xlsx')
    expect(moduleUrl('slides', '/tmp/a.pptx')).toBe('/slides/?mode=tab&open=%2Ftmp%2Fa.pptx')
    expect(moduleUrl('markdown', '/tmp/a.md')).toBe('/markdown/?mode=tab&open=%2Ftmp%2Fa.md')
  })

  it('encodes spaces and unicode so the path survives the round trip', () => {
    const path = '/tmp/my dir/报告 v2.docx'
    const url = moduleUrl('docs', path)
    const parsed = new URL(url, 'http://x')
    expect(openPathFromLocation({ search: parsed.search, hash: parsed.hash })).toBe(path)
  })
})

describe('deriveTabDescriptor', () => {
  it('derives the editor and file name from the tab URL alone', () => {
    expect(
      deriveTabDescriptor({
        pathname: '/sheets/',
        search: '?mode=tab&open=%2Ftmp%2Fa.xlsx',
        hash: '',
      }),
    ).toEqual({ kind: 'sheets', title: 'a.xlsx' })
  })

  it('reads the path from the hash for pdf and html', () => {
    expect(
      deriveTabDescriptor({ pathname: '/pdf/', search: '', hash: '#open=%2Ftmp%2Fa.pdf' }),
    ).toEqual({ kind: 'pdf', title: 'a.pdf' })
    expect(
      deriveTabDescriptor({ pathname: '/html/', search: '', hash: '#open=%2Ftmp%2Fa.html' }),
    ).toEqual({ kind: 'html', title: 'a.html' })
  })

  it('falls back to the module label for a new empty document', () => {
    expect(deriveTabDescriptor({ pathname: '/docs/', search: '?mode=tab', hash: '' })).toEqual({
      kind: 'docs',
      title: MODULE_LABEL.docs,
    })
  })

  it('returns null outside an editor route so the caller stays a plain page', () => {
    expect(deriveTabDescriptor({ pathname: '/', search: '?app=shell', hash: '' })).toBeNull()
    expect(deriveTabDescriptor({ pathname: '/settings/', search: '', hash: '' })).toBeNull()
  })

  it('ignores an unrelated leading path segment', () => {
    expect(deriveTabDescriptor({ pathname: '/unknown/docs/', search: '', hash: '' })).toBeNull()
  })
})

describe('createTabLiveness', () => {
  it('treats only recently-seen ids as live', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('web-a', 0)
    expect(liveness.isLive('web-a', 999)).toBe(true)
    expect(liveness.isLive('web-a', 1000)).toBe(false)
    expect(liveness.isLive('never-seen', 0)).toBe(false)
  })

  it('a fresh heartbeat revives an entry', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('web-a', 0)
    liveness.markLive('web-a', 5000)
    expect(liveness.isLive('web-a', 5000)).toBe(true)
  })

  it('pruneLive drops ids the caller no longer lists', () => {
    const liveness = createTabLiveness(10_000)
    liveness.markLive('keep', 0)
    liveness.markLive('orphan', 0)
    liveness.pruneLive(['keep'], 500)
    expect(liveness.isLive('keep', 500)).toBe(true)
    /* the orphan is gone from the ledger, not merely reported stale */
    expect(liveness.isLive('orphan', 0)).toBe(false)
  })

  it('pruneLive also drops ids that went stale', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('expired', 0)
    liveness.pruneLive(['expired'], 5000)
    expect(liveness.isLive('expired', 0)).toBe(false)
  })
})

describe('decideOpen', () => {
  it('opens when nothing owns the path', () => {
    const liveness = createTabLiveness(1000)
    expect(decideOpen([], 'docs', '/tmp/a.docx', liveness)).toEqual({
      action: 'open',
      duplicates: [],
    })
  })

  it('opens when no path was supplied', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('web-a')
    expect(decideOpen([tab()], 'docs', undefined, liveness)).toEqual({
      action: 'open',
      duplicates: [],
    })
  })

  it('focuses a live tab for the same path', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('web-a')
    const existing = tab()
    expect(decideOpen([existing], 'docs', '/tmp/a.docx', liveness)).toEqual({
      action: 'focus',
      tab: existing,
      duplicates: [],
    })
  })

  it('reports a cold row as a duplicate instead of focusing it', () => {
    /* The regression: a phantom whose window died without beforeunload. */
    const liveness = createTabLiveness(1000)
    const phantom = tab()
    expect(decideOpen([phantom], 'docs', '/tmp/a.docx', liveness)).toEqual({
      action: 'open',
      duplicates: [phantom],
    })
  })

  it('never lets a phantom in front of a live tab win the match', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('web-live')
    const phantom = tab({ id: 'web-dead', title: 'a.docx' })
    const live = tab({ id: 'web-live', title: 'a.docx' })
    const decision = decideOpen([phantom, live], 'docs', '/tmp/a.docx', liveness)
    expect(decision.action).toBe('focus')
    expect(decision.action === 'focus' && decision.tab.id).toBe('web-live')
    expect(decision.duplicates).toEqual([phantom])
  })

  it('lists every other row for the path so the caller can collapse them', () => {
    const liveness = createTabLiveness(1000)
    const a = tab({ id: 'web-1' })
    const b = tab({ id: 'web-2' })
    const c = tab({ id: 'web-3' })
    liveness.markLive('web-2')
    const decision = decideOpen([a, b, c], 'docs', '/tmp/a.docx', liveness)
    expect(decision.duplicates.map((t) => t.id)).toEqual(['web-1', 'web-3'])
  })

  it('does not match a tab from another module with the same filename', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('web-a')
    const sheet = tab({ kind: 'sheets', title: 'a.xlsx' })
    expect(decideOpen([sheet], 'docs', '/tmp/a.docx', liveness)).toEqual({
      action: 'open',
      duplicates: [],
    })
  })

  it('matches on filename, so a moved file reuses its tab', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('web-a')
    const existing = tab({ title: 'a.docx' })
    expect(decideOpen([existing], 'docs', '/other/a.docx', liveness).action).toBe('focus')
  })
})

describe('sweepTabs', () => {
  it('reports no change and keeps identity when every row is live', () => {
    const liveness = createTabLiveness(1000)
    liveness.markLive('web-a')
    const tabs = [tab()]
    const result = sweepTabs(tabs, liveness)
    expect(result.changed).toBe(false)
    /* same reference: callers use this on a timer and must not churn the UI */
    expect(result.tabs).toBe(tabs)
  })

  it('drops rows whose window stopped beating', () => {
    const liveness = createTabLiveness(1000)
    const live = tab({ id: 'web-live', title: 'live.docx' })
    const phantom = tab({ id: 'web-dead', title: 'dead.docx' })
    liveness.markLive('web-live')
    const result = sweepTabs([live, phantom], liveness)
    expect(result.changed).toBe(true)
    expect(result.tabs).toEqual([live])
  })

  it('sweeping an empty cache is a no-op', () => {
    expect(sweepTabs([], createTabLiveness(1000))).toEqual({ tabs: [], changed: false })
  })
})

describe('dedupeTabs', () => {
  it('keeps the winner in place and reports the rows it displaced', () => {
    const a = tab({ id: 'web-1' })
    const b = tab({ id: 'web-2' })
    const other = tab({ id: 'web-3', title: 'b.docx' })
    const { tabs, dropped } = dedupeTabs([a, b, other], b)
    expect(tabs).toEqual([b, other])
    expect(dropped).toEqual([a])
  })

  it('adds a winner that was not in the list yet, without duplicating it', () => {
    const a = tab({ id: 'web-1' })
    const fresh = tab({ id: 'web-2' })
    const { tabs, dropped } = dedupeTabs([a], fresh)
    expect(tabs).toEqual([fresh])
    expect(dropped).toEqual([a])
  })

  it('returns the input untouched when the winner is already unique', () => {
    const only = tab()
    const input = [only]
    const result = dedupeTabs(input, only)
    expect(result.dropped).toEqual([])
    /* same reference, so a no-op dedupe never churns the TabBar */
    expect(result.tabs).toBe(input)
  })
})

describe('storage helpers', () => {
  it('round-trips the tab list', () => {
    const storage = memoryStorage()
    const tabs = [tab()]
    saveTabs(storage, tabs)
    expect(storage.map.get(TAB_STORAGE_KEY)).toBe(JSON.stringify(tabs))
    expect(loadTabs(storage)).toEqual(tabs)
  })

  it('treats corrupt or absent storage as an empty list', () => {
    expect(loadTabs(memoryStorage())).toEqual([])
    expect(loadTabs(memoryStorage({ [TAB_STORAGE_KEY]: '{not json' }))).toEqual([])
    expect(loadTabs(memoryStorage({ [TAB_STORAGE_KEY]: '{"not":"an array"}' }))).toEqual([])
  })

  it('a storage that throws never breaks boot', () => {
    const hostile = {
      getItem: vi.fn(() => {
        throw new Error('denied')
      }),
      setItem: vi.fn(() => {
        throw new Error('quota')
      }),
    }
    expect(loadTabs(hostile)).toEqual([])
    expect(() => saveTabs(hostile, [tab()])).not.toThrow()
  })
})

/**
 * A minimal stand-in for the browser pieces `installTabGuest` touches. Using a
 * fake instead of jsdom keeps the test fast and lets it drive time and channel
 * traffic by hand, which is what the guest's behaviour actually depends on.
 */
function fakeGuestWorld(url: { pathname: string; search: string; hash: string }) {
  const posted: unknown[] = []
  const listeners = new Map<string, ((event: MessageEvent) => void)[]>()
  const winListeners = new Map<string, ((event: Event) => void)[]>()
  const docListeners = new Map<string, (() => void)[]>()
  let now = 0
  const timers: { fn: () => void; at: number; live: boolean }[] = []

  const channel = {
    postMessage: (msg: unknown) => posted.push(msg),
    addEventListener: (type: string, fn: (event: MessageEvent) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener: vi.fn(),
    close: vi.fn(),
  }

  const win = {
    location: url,
    document: {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (type: string, fn: () => void) => {
        docListeners.set(type, [...(docListeners.get(type) ?? []), fn])
      },
      removeEventListener: vi.fn(),
    },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    setInterval: (fn: () => void, ms: number) => {
      timers.push({ fn, at: now + ms, live: true })
      return timers.length - 1
    },
    /* Honoured for real: "dispose stops the heartbeat" is exactly the
     * behaviour under test, so a no-op stub would assert nothing. */
    clearInterval: (handle: number) => {
      const timer = timers[handle]
      if (timer) timer.live = false
    },
    addEventListener: (type: string, fn: (event: Event) => void) => {
      winListeners.set(type, [...(winListeners.get(type) ?? []), fn])
    },
    removeEventListener: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  }

  return {
    channel,
    win,
    posted,
    /** Deliver a host → guest message. */
    deliver(msg: unknown) {
      for (const fn of listeners.get('message') ?? []) fn({ data: msg } as MessageEvent)
    },
    /** Fire a DOM/window lifecycle event. */
    emitDoc(type: string) {
      for (const fn of docListeners.get(type) ?? []) fn()
    },
    emitWin(type: string, event: Event = new Event(type)) {
      for (const fn of winListeners.get(type) ?? []) fn(event)
    },
    /** Advance the clock, running any heartbeat that came due. */
    tick(ms: number) {
      now += ms
      for (const timer of timers) if (timer.live && timer.at <= now) timer.fn()
    },
    get last() {
      return posted[posted.length - 1] as Record<string, unknown>
    },
  }
}

describe('installTabGuest', () => {
  const editorUrl = { pathname: '/sheets/', search: '?mode=tab&open=%2Ftmp%2Fa.xlsx', hash: '' }

  it('registers immediately so the shell learns about the tab at once', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })
    expect(world.last).toMatchObject({ type: 'register', kind: 'sheets', title: 'a.xlsx' })
    expect(typeof world.last.id).toBe('string')
  })

  it('keeps beating so the shell never mistakes it for a phantom', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
      heartbeatMs: 1000,
    })
    const before = world.posted.length
    world.tick(1000)
    expect(world.posted.length).toBe(before + 1)
    expect(world.last.type).toBe('heartbeat')
  })

  it('answers a focus request, which is how the shell proves it is real', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    const guest = installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })!
    world.deliver({ type: 'focus-request', id: guest.id })
    expect(world.last).toMatchObject({ type: 'focus-ack', id: guest.id })
    expect(world.win.focus).toHaveBeenCalled()
  })

  it('ignores a focus request addressed to another tab', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })
    const before = world.posted.length
    world.deliver({ type: 'focus-request', id: 'someone-else' })
    expect(world.posted.length).toBe(before)
    expect(world.win.focus).not.toHaveBeenCalled()
  })

  it('retires itself when told another window owns the path', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    const guest = installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })!
    world.deliver({ type: 'close-request', id: guest.id })
    expect(world.win.close).toHaveBeenCalled()
    expect(world.last).toMatchObject({ type: 'unregister', id: guest.id })
  })

  it('re-registers when the shell syncs a list that lost it', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    const guest = installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })!
    world.deliver({ type: 'sync', tabs: [{ id: 'other', kind: 'docs', title: 'x.docx' }] })
    expect(world.last).toMatchObject({ type: 'register', id: guest.id })
  })

  it('stays quiet when the shell still knows about it', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    const guest = installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })!
    const before = world.posted.length
    world.deliver({
      type: 'sync',
      tabs: [{ id: guest.id, kind: 'sheets', title: 'a.xlsx', windowId: guest.id }],
    })
    expect(world.posted.length).toBe(before)
  })

  it('re-announces when the tab becomes visible again after throttling', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })
    const before = world.posted.length
    world.emitDoc('visibilitychange')
    expect(world.posted.length).toBe(before + 1)
  })

  it('says goodbye on close so the row does not linger as a phantom', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld(editorUrl)
    const guest = installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: editorUrl,
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })!
    world.emitWin('beforeunload')
    expect(world.last).toMatchObject({ type: 'unregister', id: guest.id })
    /* and it must not keep beating after the window is gone */
    const after = world.posted.length
    world.tick(10_000)
    expect(world.posted.length).toBe(after)
  })

  it('returns null outside an editor route so a plain page stays plain', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const world = fakeGuestWorld({ pathname: '/', search: '?app=shell', hash: '' })
    expect(
      installTabGuest({
        win: world.win as never,
        channel: world.channel as never,
        location: { pathname: '/', search: '?app=shell', hash: '' },
      }),
    ).toBeNull()
    expect(world.posted).toEqual([])
  })

  it('keeps its id across a reload via sessionStorage', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const first = fakeGuestWorld({
      pathname: '/sheets/',
      search: '?mode=tab&open=%2Fa.xlsx',
      hash: '',
    })
    const guest = installTabGuest({
      win: first.win as never,
      channel: first.channel as never,
      location: { pathname: '/sheets/', search: '?mode=tab&open=%2Fa.xlsx', hash: '' },
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })!
    first.win.sessionStorage.setItem('genoffice:tab-id', guest.id)

    /* same tab, page reloaded: fresh channel, same sessionStorage */
    const second = fakeGuestWorld({
      pathname: '/sheets/',
      search: '?mode=tab&open=%2Fa.xlsx',
      hash: '',
    })
    second.win.sessionStorage.setItem('genoffice:tab-id', guest.id)
    const revived = installTabGuest({
      win: second.win as never,
      channel: second.channel as never,
      location: { pathname: '/sheets/', search: '?mode=tab&open=%2Fa.xlsx', hash: '' },
      descriptor: { kind: 'sheets', title: 'a.xlsx' },
    })!
    expect(revived.id).toBe(guest.id)
  })

  it('adopts the id the host put in the URL', async () => {
    const { installTabGuest } = await import('../src/web-tabs')
    const loc = { pathname: '/pdf/', search: '?mode=tab', hash: '#open=%2Fa.pdf&tab=web-host-id' }
    const world = fakeGuestWorld(loc)
    const guest = installTabGuest({
      win: world.win as never,
      channel: world.channel as never,
      location: loc,
      descriptor: { kind: 'pdf', title: 'a.pdf' },
    })!
    expect(guest.id).toBe('web-host-id')
    expect(guest.id).toBe(world.last.id)
  })
})
