// @vitest-environment jsdom
/**
 * Interaction tests for the composer upgrade.
 *
 * The pure trigger/ranking rules live in composer-commands.test.ts; what this
 * file proves is the *wiring*: that typing `/query` really opens the palette,
 * that arrows/Enter/Esc do what the menu promises, that a pick lands in the
 * host's state with the caret after it, and that mode pills report the pick.
 *
 * jsdom + react-dom/client because these are behaviours, not markup — a
 * static render cannot show them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { AiComposer } from '../src/AiComposer'
import type { ComposerCommandPick, ComposerModeOption } from '../src/AiComposer'
import type { ComposerCommand } from '../src/chat/composer-commands'
import type { ChatMode } from '../src/chat/modes'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const commands: ComposerCommand[] = [
  {
    id: 'summarize',
    trigger: 'sum',
    label: 'Summarize',
    description: 'Condense the document',
    group: 'Skills',
    kind: 'run',
    hint: 'doc.summarize',
  },
  {
    id: 'translate',
    trigger: 'tran',
    label: 'Translate',
    description: 'Translate the selection',
    group: 'Skills',
    kind: 'run',
  },
  {
    id: 'brief',
    trigger: 'brief',
    label: 'Task brief',
    group: 'Templates',
    kind: 'insert',
    insert: 'Goal: ',
  },
  { id: 'off', trigger: 'off', label: 'Unavailable', group: 'Skills', kind: 'run', disabled: true },
]

const modes: ComposerModeOption[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'craft', label: 'Craft' },
  { id: 'plan', label: 'Plan' },
]

interface Harness {
  setValue: (next: string) => void
  picks: ComposerCommandPick[]
  modeChanges: ChatMode[]
  stops: number
  sends: number
  editLasts: number
}

let container: HTMLDivElement
let root: Root

/** Mounts a stateful composer so picks/mode changes flow back into `value`. */
function mount(opts: { busy?: boolean } = {}): Harness {
  const harness: Harness = {
    setValue: () => undefined,
    picks: [],
    modeChanges: [],
    stops: 0,
    sends: 0,
    editLasts: 0,
  }
  function Host(): React.JSX.Element {
    const [value, setValue] = useState('')
    harness.setValue = setValue
    const [mode, setMode] = useState<ChatMode>('craft')
    return createElement(AiComposer, {
      value,
      busy: opts.busy ?? false,
      placeholder: 'Ask anything',
      hintIdle: 'Enter to send',
      hintBusy: 'Working',
      sendLabel: 'Send',
      stopLabel: 'Stop',
      commands,
      onCommandPick: (pick) => harness.picks.push(pick),
      commandMenuLabel: 'Commands',
      commandMenuEmptyLabel: 'Nothing here',
      modes,
      mode,
      onModeChange: (next) => {
        harness.modeChanges.push(next)
        setMode(next)
      },
      onChange: setValue,
      onSend: () => {
        harness.sends += 1
      },
      onStop: () => {
        harness.stops += 1
      },
      onEditLast: () => {
        harness.editLasts += 1
      },
    })
  }
  act(() => {
    root.render(createElement(Host))
  })
  return harness
}

/** Mount a composer and type `text`, the way a user reaches the palette. */
function mountAndType(text: string, opts: { busy?: boolean } = {}): Harness {
  const h = mount(opts)
  if (text !== '') type(text)
  return h
}

/** Type into the textarea the way a user would: value then caret at the end. */
function type(text: string): void {
  const ta = container.querySelector('textarea') as HTMLTextAreaElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set
    setter?.call(ta, text)
    ta.setSelectionRange(text.length, text.length)
    ta.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

function key(name: string, init: KeyboardEventInit = {}): void {
  const ta = container.querySelector('textarea') as HTMLTextAreaElement
  act(() => {
    ta.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }),
    )
  })
}

function rows(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('.ai-cmd-row')) as HTMLButtonElement[]
}

function activeRow(): string | null {
  const id = container.querySelector('textarea')?.getAttribute('aria-activedescendant')
  if (!id) return null
  // React `useId` ids contain guillemets, so match on the attribute instead
  // of a raw `#id` selector (and jsdom exposes no CSS.escape here)
  return (container.querySelector(`[id="${id}"]`)?.textContent ?? null)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('slash palette', () => {
  it('opens once a `/query` is typed and ranks the matching command first', () => {
    mount('')
    expect(container.querySelector('.ai-cmd-menu')).toBeNull()
    type('/su')
    expect(container.querySelector('.ai-cmd-menu')).not.toBeNull()
    expect(rows().map((r) => r.textContent)).toHaveLength(1)
    expect(rows()[0]?.textContent).toContain('Summarize')
  })

  it('shows the groups the command table declares', () => {
    mountAndType('/')
    const groups = Array.from(container.querySelectorAll('.ai-cmd-group')).map(
      (g) => g.textContent,
    )
    expect(groups).toEqual(['Skills', 'Templates'])
  })

  it('never opens inside a URL or a path', () => {
    mount('')
    type('https://example.com/docs')
    expect(container.querySelector('.ai-cmd-menu')).toBeNull()
    type('see /usr/local/bin')
    expect(container.querySelector('.ai-cmd-menu')).toBeNull()
  })

  it('reports no matches without inventing a fallback action', () => {
    mount('')
    type('/zzzz')
    expect(container.querySelector('.ai-cmd-empty')?.textContent).toBe('Nothing here')
  })

  it('walks the rendered order with the arrow keys, skipping disabled rows', () => {
    mountAndType('/')
    // Skills: summarize, translate, off(disabled); then Templates: brief
    expect(activeRow()).toContain('Summarize')
    key('ArrowDown')
    expect(activeRow()).toContain('Translate')
    key('ArrowDown')
    expect(activeRow()).toContain('Task brief') // the disabled row is skipped
    key('ArrowDown')
    expect(activeRow()).toContain('Summarize') // wraps
    key('ArrowUp')
    expect(activeRow()).toContain('Task brief')
    key('Home')
    expect(activeRow()).toContain('Summarize')
  })

  it('hover moves the keyboard cursor so the two can never diverge', () => {
    mountAndType('/')
    const target = rows().find((r) => r.textContent?.includes('Translate')) as HTMLButtonElement
    // React synthesises onMouseEnter from mouseover + relatedTarget, which is
    // exactly what a real pointer crossing the row boundary produces
    act(() => {
      target.dispatchEvent(
        new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
      )
    })
    expect(activeRow()).toContain('Translate')
  })
})

describe('picking a command', () => {
  it('runs a `run` command and consumes the `/query` text', () => {
    const h = mountAndType('/sum')
    key('Enter')
    expect(h.picks).toHaveLength(1)
    expect(h.picks[0]?.command.id).toBe('summarize')
    expect(h.picks[0]?.query).toBe('sum')
    expect(h.picks[0]?.value).toBe('')
    expect(container.querySelector('.ai-cmd-menu')).toBeNull()
  })

  it('inserts the template text for an `insert` command and leaves the caret after it', () => {
    const h = mountAndType('/brief')
    key('Enter')
    expect(h.picks[0]?.value).toBe('Goal: ')
    expect(h.picks[0]?.caret).toBe(6)
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.value).toBe('Goal: ')
    expect(ta.selectionStart).toBe(6)
  })

  it('clicking a row picks it too', () => {
    const h = mountAndType('/tran')
    const row = rows()[0] as HTMLButtonElement
    act(() => {
      row.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(h.picks[0]?.command.id).toBe('translate')
  })

  it('does not send the message when a command is picked', () => {
    const h = mountAndType('/sum')
    key('Enter')
    expect(h.sends).toBe(0)
  })

  it('keeps the surrounding text when the command sits mid-sentence', () => {
    const h = mount()
    type('please /sum now')
    // caret sits inside "/sum": a click back into the query re-opens the menu
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      ta.setSelectionRange(11, 11)
      ta.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('.ai-cmd-menu')).not.toBeNull()
    key('Enter')
    expect(h.picks[0]?.value).toBe('please  now')
  })
})

describe('escape handling', () => {
  it('closes the palette but keeps the typed text', () => {
    mountAndType('/sum')
    key('Escape')
    expect(container.querySelector('.ai-cmd-menu')).toBeNull()
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('/sum')
  })

  it('still stops a running turn when the palette is closed', () => {
    const h = mountAndType('hello', { busy: true })
    key('Escape')
    expect(h.stops).toBe(1)
  })

  it('reopens after Esc as soon as the query changes', () => {
    mountAndType('/su')
    key('Escape')
    expect(container.querySelector('.ai-cmd-menu')).toBeNull()
    type('/sum')
    expect(container.querySelector('.ai-cmd-menu')).not.toBeNull()
  })
})

describe('mode switch', () => {
  it('reports the picked mode and marks it checked', () => {
    const h = mount('')
    const plan = Array.from(container.querySelectorAll('.ai-mode-btn')).find(
      (b) => b.textContent === 'Plan',
    ) as HTMLButtonElement
    act(() => {
      plan.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(h.modeChanges).toEqual(['plan'])
    expect(container.querySelector('.ai-mode-btn.on')?.textContent).toBe('Plan')
  })
})

describe('plain typing', () => {
  it('sends on Enter and ignores Shift+Enter', () => {
    const h = mountAndType('hello')
    key('Enter', { shiftKey: true })
    expect(h.sends).toBe(0)
    key('Enter')
    expect(h.sends).toBe(1)
  })
})

// keep `vi` referenced so the import list stays honest if a stub is added
void vi


describe('edit-last-message shortcut', () => {
  it('fires onEditLast when ArrowUp is pressed on an empty textarea', () => {
    const h = mount()
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(h.editLasts).toBe(1)
  })

  it('does NOT fire when the textarea already has text', () => {
    const h = mount()
    act(() => { h.setValue('in progress') })
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(h.editLasts).toBe(0)
  })

  it('does NOT fire when the slash palette is open (Up must move highlight)', () => {
    const h = mount()
    act(() => { h.setValue('/') })
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    ta.focus()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(h.editLasts).toBe(0)
  })
})
