// @vitest-environment jsdom
/**
 * 语言预填契约（`initialSourceLang` / `initialTargetLang`）。
 *
 * 深链 / 批量入口把 `sourceLang` / `targetLang` 一路送到宿主 app 的
 * `open(request)`，但 sheets / pdf / slides 的弹窗此前把 request 里的语言
 * **丢掉**，共享弹窗一 open 就重置回 `defaultTargetLang`（UI 语言）。真机走查
 * （2026-10-05，翻译工作台批量 → xlsx 深链 targetLang=en-US）实测：弹窗目标
 * 语言显示「简体中文」—— 用户不重选就直接跑，整篇译文落错语言且无任何提示。
 * docs 的 AiPanel 自己持语言 state、预填正确，所以只有这三家坏。
 *
 * 契约钉三件事：
 *  1. initial* 在场时，open 后语言 = initial*，压过 default*。
 *  2. initial* 缺席（手动打开）时，回落 default* —— 不能继承上一轮的值。
 *  3. 重开时 initial* 变化要生效（深链连发两条不同目标语言的场景）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TranslateDialog } from '../src/TranslateDialog'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const strings = {
  title: 'Translate',
  targetLang: 'Translate to',
  sourceLang: 'Detected source',
  preserveFormat: 'Keep original formatting',
  swapLanguages: 'Swap',
  start: 'Translate',
  apply: 'Apply translation',
  original: 'Original',
  translated: 'Translated',
  previewTitle: 'Preview',
  previewLoading: 'Translating…',
  cancel: 'Cancel',
  unsupported: 'Translation failed',
}

let container: HTMLDivElement
let root: Root

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

function selects(): { source: HTMLSelectElement; target: HTMLSelectElement } {
  const [source, target] = [...container.querySelectorAll('.ai-translate-dialog-langs select')]
  return { source: source as HTMLSelectElement, target: target as HTMLSelectElement }
}

function render(props: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      createElement(TranslateDialog, {
        open: true,
        sourceText: '',
        hasTranslatableContent: true,
        defaultTargetLang: 'zh',
        languages: [
          { value: 'zh', label: '简体中文' },
          { value: 'en', label: 'English' },
        ],
        strings,
        onTranslate: vi.fn(async () => '译文'),
        onApply: vi.fn(),
        onCancel: () => {},
        app: 'sheets',
        ...props,
      } as never),
    )
  })
}

describe('TranslateDialog initial languages', () => {
  it('prefers initialTargetLang over defaultTargetLang on open', () => {
    render({ initialTargetLang: 'en' })
    expect(selects().target.value).toBe('en')
    expect(selects().source.value).toBe('auto')
  })

  it('prefers initialSourceLang over the auto-detect default', () => {
    render({ initialSourceLang: 'zh', initialTargetLang: 'en' })
    expect(selects().source.value).toBe('zh')
    expect(selects().target.value).toBe('en')
  })

  it('falls back to defaults when no initial languages are given (manual open)', () => {
    render({})
    expect(selects().source.value).toBe('auto')
    expect(selects().target.value).toBe('zh')
  })

  it('resets to defaults when initial languages disappear (manual open after a deep link)', async () => {
    render({ initialTargetLang: 'en' })
    expect(selects().target.value).toBe('en')
    await act(async () => {
      root.render(
        createElement(TranslateDialog, {
          open: true,
          sourceText: '',
          hasTranslatableContent: true,
          defaultTargetLang: 'zh',
          languages: [
            { value: 'zh', label: '简体中文' },
            { value: 'en', label: 'English' },
          ],
          strings,
          onTranslate: vi.fn(async () => '译文'),
          onApply: vi.fn(),
          onCancel: () => {},
          app: 'sheets',
        } as never),
      )
    })
    expect(selects().target.value).toBe('zh')
  })

  it('applies new initial languages when reopened with a different deep-link pair', async () => {
    render({ initialTargetLang: 'en', initialSourceLang: 'zh' })
    expect(selects().source.value).toBe('zh')
    expect(selects().target.value).toBe('en')
    render({ initialTargetLang: 'zh', initialSourceLang: 'en' })
    expect(selects().source.value).toBe('en')
    expect(selects().target.value).toBe('zh')
  })
})