// @vitest-environment jsdom
/**
 * Interaction tests for the @-mention palette + slash trigger.
 *
 * Sibling to `ai-composer-interaction.test.ts`, which covers the slash
 * palette. The two share the same jsdom harness pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { AiComposer } from '../src/AiComposer'
import type { MentionEntry, MentionPick } from '../src/chat/mentions'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mentions: MentionEntry[] = [
  { id: 'file-summary', trigger: 'summary', label: '工艺单汇总.pdf', group: 'Files', kind: 'file' },
  { id: 'file-fabric', trigger: 'fabric', label: '面料清单.xlsx', group: 'Files', kind: 'file' },
  { id: 'block-doc', trigger: 'doc', label: '当前文档', group: 'Blocks', kind: 'block' },
  { id: 'skill-translate', trigger: 'translate', label: '翻译技能', group: 'Skills', kind: 'skill', disabled: true },
]

interface Harness {
  setValue: (next: string) => void
  getValue: () => string
  picks: MentionPick[]
}

let container: HTMLDivElement
let root: Root

function mount(): Harness {
  const picks: MentionPick[] = []
  const harness: Harness = {
    picks,
    setValue: () => undefined,
    getValue: () => '',
  }
  function Inner(): React.JSX.Element {
    const [v, setV] = useState('')
    harness.setValue = setV
    harness.getValue = () => v
    return (
      <AiComposer
        value={v}
        busy={false}
        placeholder="…"
        hintIdle="…"
        hintBusy="…"
        sendLabel="Send"
        stopLabel="Stop"
        mentions={mentions}
        onMentionPick={(p) => {
          picks.push(p)
          setV(p.value)
        }}
        mentionMenuLabel="Files & skills"
        mentionMenuEmptyLabel="Nothing matched"
        mentionMenuFootHint="↑↓ Enter Esc"
        onChange={setV}
        onSend={() => undefined}
        onStop={() => undefined}
      />
    )
  }
  act(() => {
    root.render(createElement(Inner))
  })
  return harness
}

function fireKey(el: HTMLTextAreaElement, key: string, init?: KeyboardEventInit): void {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    el.dispatchEvent(ev)
  })
}

function setTextareaValue(el: HTMLTextAreaElement, next: string, caret = next.length): void {
  // react-controlled inputs: set the value via the native setter so React
  // notices the change, then dispatch input.
  const proto = Object.getPrototypeOf(el)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, next)
  el.selectionStart = caret
  el.selectionEnd = caret
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('@-mention palette', () => {
  it('opens when @ is typed', () => {
    mount()
    const ta = container.querySelector('textarea')!
    setTextareaValue(ta, '@sum')
    const listbox = container.querySelector('.ai-mention-menu')
    expect(listbox).not.toBeNull()
    expect(listbox?.getAttribute('aria-label')).toBe('Files & skills')
  })

  it('filters entries by the @query', () => {
    mount()
    const ta = container.querySelector('textarea')!
    setTextareaValue(ta, '@fab')
    const labels = Array.from(container.querySelectorAll('.ai-mention-menu .ai-cmd-label')).map(
      (n) => n.textContent,
    )
    expect(labels).toContain('面料清单.xlsx')
    expect(labels).not.toContain('当前文档')
  })

  it('shows the empty state when nothing matches', () => {
    mount()
    const ta = container.querySelector('textarea')!
    setTextareaValue(ta, '@zzzzz')
    expect(container.querySelector('.ai-cmd-empty')?.textContent).toBe('Nothing matched')
  })

  it('Enter on the active row inserts @label and fires onMentionPick', () => {
    const h = mount()
    const ta = container.querySelector('textarea')!
    setTextareaValue(ta, '@sum')
    fireKey(ta, 'Enter')
    expect(h.picks).toHaveLength(1)
    expect(h.picks[0]?.entry.id).toBe('file-summary')
    expect(h.getValue()).toBe('@工艺单汇总.pdf ')
  })

  it('arrow keys move the highlight through the rows', () => {
    mount()
    const ta = container.querySelector('textarea')!
    setTextareaValue(ta, '@') // empty query → every group visible
    // first enabled row is highlighted by default
    expect(
      container.querySelector('.ai-mention-menu .ai-cmd-row.active')?.id,
    ).toContain('-opt-0')
    fireKey(ta, 'ArrowDown')
    expect(
      container.querySelector('.ai-mention-menu .ai-cmd-row.active')?.id,
    ).toContain('-opt-1')
  })

  it('Esc closes the palette but keeps the typed text', () => {
    mount()
    const ta = container.querySelector('textarea')!
    setTextareaValue(ta, '@sum')
    fireKey(ta, 'Escape')
    expect(container.querySelector('.ai-mention-menu')).toBeNull()
    expect(ta.value).toBe('@sum')
  })

  it('does not open mid-word (email)', () => {
    mount()
    const ta = container.querySelector('textarea')!
    setTextareaValue(ta, 'alice@bob')
    expect(container.querySelector('.ai-mention-menu')).toBeNull()
  })
})

describe('slash trigger button', () => {
  it('renders the trigger chip when the field is empty', () => {
    mount()
    expect(container.querySelector('.ai-slash-trigger')).not.toBeNull()
  })

  it('hides the trigger once the user starts typing', () => {
    mount()
    const ta = container.querySelector('textarea')!
    setTextareaValue(ta, 'hello')
    expect(container.querySelector('.ai-slash-trigger')).toBeNull()
  })

  it('clicking the trigger opens the slash palette and focuses the textarea', () => {
    const h = mount()
    // mount() without commands — re-mount with commands so the trigger appears
    act(() => root.unmount())
    root = createRoot(container)
    function Inner2(): React.JSX.Element {
      const [v, setV] = useState('')
      h.setValue = setV
      h.getValue = () => v
      return (
        <AiComposer
          value={v}
          busy={false}
          placeholder="…"
          hintIdle="…"
          hintBusy="…"
          sendLabel="S"
          stopLabel="X"
          mentions={mentions}
          commands={[
            { id: 'sum', trigger: 'sum', label: 'Summarize', group: 'Skills', kind: 'run' },
          ]}
          onChange={setV}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      )
    }
    act(() => root.render(createElement(Inner2)))
    const btn = container.querySelector<HTMLButtonElement>('.ai-slash-trigger')
    expect(btn).not.toBeNull()
    act(() => btn!.click())
    // the trigger should have inserted "/" and opened the palette
    const ta = container.querySelector<HTMLTextAreaElement>('textarea')!
    expect(ta.value.endsWith('/')).toBe(true)
    // the slash palette shows (AiComposerMenu), not the mention one
    expect(container.querySelector('.ai-cmd-menu:not(.ai-mention-menu)')).not.toBeNull()
  })
})
