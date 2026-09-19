/**
 * Smoke tests for the shared AI composer upgrade.
 *
 * `react-dom/server` keeps these runnable in the node environment the package
 * already uses (no jsdom). The first block is the important one: the upgrade
 * added props, so the *absence* of those props has to render exactly what the
 * composer rendered before, byte for byte.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import { AiComposer } from '../src/AiComposer'
import type { ComposerCommand } from '../src/chat/composer-commands'

const baseProps = {
  value: 'hello',
  busy: false,
  placeholder: 'Ask anything',
  hintIdle: 'Enter to send',
  hintBusy: 'Working',
  sendLabel: 'Send',
  stopLabel: 'Stop',
  onChange: () => undefined,
  onSend: () => undefined,
  onStop: () => undefined,
} as const

type Props = Parameters<typeof AiComposer>[0]
const render = (overrides: Partial<Props> = {}): string =>
  renderToStaticMarkup(createElement(AiComposer, { ...baseProps, ...overrides } as Props))

const commands: ComposerCommand[] = [
  {
    id: 'skills.summarize',
    trigger: 'sum',
    label: 'Summarize',
    description: 'Condense the document',
    group: 'Skills',
    kind: 'run',
    hint: 'summarize',
  },
  {
    id: 'skills.translate',
    trigger: 'tran',
    label: 'Translate',
    description: 'Translate to Chinese',
    group: 'Skills',
    kind: 'run',
    hint: 'translate',
  },
  {
    id: 'templates.brief',
    trigger: 'brief',
    label: 'Task brief',
    description: 'Goal / input / actions / constraints',
    group: 'Templates',
    kind: 'insert',
    insert: 'Goal: ',
  },
]

describe('AiComposer backward compatibility', () => {
  it('renders the pre-upgrade markup when no new prop is passed', () => {
    // frozen snapshot captured from the composer before the upgrade; the
    // no-command path must not have gained wrapper elements
    expect(render()).toBe(
      '<div class="ai-input-box">' +
        '<textarea placeholder="Ask anything" rows="1" dir="auto" spellCheck="true">hello</textarea>' +
        '<div class="ai-input-footer">' +
        '<span class="ai-input-hint">Enter to send</span>' +
        '<button class="ai-send-btn" title="Send" aria-label="Send">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M2.2 8 13.8 2.6 11 13.4 7.6 9.6z" stroke-linejoin="round"></path>' +
        '<path d="M7.6 9.6 13.8 2.6"></path></svg>Send</button></div></div>',
    )
  })

  it('still takes header and footerStart slots', () => {
    const html = render({
      header: createElement('span', null, 'HDR'),
      footerStart: createElement('button', { className: 'x' }, 'FTR'),
    })
    expect(html).toContain('<span>HDR</span>')
    expect(html).toContain('<button class="x">FTR</button>')
    expect(html.indexOf('HDR')).toBeLessThan(html.indexOf('<textarea'))
  })

  it('does not render the palette wrapper or mode switch without those props', () => {
    const html = render()
    expect(html).not.toContain('ai-input-field')
    expect(html).not.toContain('ai-mode-switch')
    expect(html).not.toContain('ai-cmd-menu')
  })

  it('renders the toolbar slot before the send button', () => {
    const html = render({ toolbar: createElement('span', { className: 'tb' }, 'TB') })
    expect(html).toContain('TB')
    expect(html.indexOf('TB')).toBeLessThan(html.indexOf('ai-send-btn'))
  })
})

describe('AiComposer command palette', () => {
  it('adds the anchor wrapper and listbox wiring once a command table exists', () => {
    const html = render({ commands, onCommandPick: () => undefined, commandMenuLabel: 'Commands' })
    expect(html).toContain('class="ai-input-field"')
    // the palette is closed until the user types `/`, but the textarea
    // advertises that it drives a listbox
    expect(html).toContain('aria-autocomplete="list"')
    expect(html).not.toContain('ai-cmd-menu')
  })

  it('ignores an empty command table', () => {
    const html = render({ commands: [], onCommandPick: () => undefined })
    expect(html).not.toContain('ai-input-field')
    expect(html).not.toContain('aria-autocomplete')
  })
})

describe('AiComposer mode switch', () => {
  const modes = [
    { id: 'ask' as const, label: 'Ask', title: 'Read-only' },
    { id: 'craft' as const, label: 'Craft', title: 'Direct edits' },
    { id: 'plan' as const, label: 'Plan', title: 'Propose first' },
  ]

  it('renders a radiogroup with the current mode checked', () => {
    const html = render({ modes, mode: 'plan', onModeChange: () => undefined })
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('Read-only')
    expect(html).toContain('Propose first')
  })

  it('needs more than one mode to be worth showing', () => {
    const html = render({ modes: [modes[0]!], mode: 'ask', onModeChange: () => undefined })
    expect(html).not.toContain('ai-mode-switch')
  })

  it('stays hidden when the app cannot handle a change', () => {
    const html = render({ modes, mode: 'ask' })
    expect(html).not.toContain('ai-mode-switch')
  })
})

describe('AiComposer voice button', () => {
  const voice = {
    available: true,
    active: false,
    label: 'Voice',
    onStart: () => undefined,
    onStop: () => undefined,
  }

  it('renders the mic when available=true', () => {
    const html = render({ voice })
    expect(html).toContain('ai-voice-btn')
    expect(html).toContain('aria-label="Voice"')
    expect(html).toContain('aria-pressed="false"')
  })

  it('reflects the active state via class + aria-pressed', () => {
    const html = render({ voice: { ...voice, active: true } })
    expect(html).toContain('ai-voice-btn active')
    expect(html).toContain('aria-pressed="true"')
  })

  it('omits the button entirely when available=false', () => {
    const html = render({ voice: { ...voice, available: false } })
    expect(html).not.toContain('ai-voice-btn')
  })

  it('omits the button when the voice prop is absent (backwards compat)', () => {
    const html = render({})
    expect(html).not.toContain('ai-voice-btn')
  })
})
