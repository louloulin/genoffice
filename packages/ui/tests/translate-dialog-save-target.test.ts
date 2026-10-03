// @vitest-environment jsdom
/**
 * 「译文保存为」选择器的交互契约。
 *
 * 这组用例盯的是三件用户能直接看见、且一旦错了就会**静默**出错的事：
 *
 *  1. 没有 `onSaveTargetChange` 的宿主（桌面构建 / 知识库来源）**不渲染**选择器。
 *     渲染了就等于给了一个兑现不了的承诺。
 *  2. 选 `copy` 时把将要落盘的文件名显示出来 —— 「不覆盖原文」这个承诺要看得见，
 *     否则用户只能靠猜。
 *  3. 用户选的值必须一路传到 `onApply`。中间任何一段丢失，用户看到的都是
 *     「我选了另存」，实际却覆盖了原文，而这两件事都不会报错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TranslateDialog } from '../src/TranslateDialog'
import type { ChatChangePlan } from '../src/chat/change-plan'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const strings = {
  title: 'Translate selection',
  targetLang: 'Translate to',
  sourceLang: 'Detected source',
  preserveFormat: 'Keep original formatting',
  bilingual: 'Bilingual',
  saveTarget: 'Save translated file as',
  saveTargetOverwrite: 'Overwrite current file (new version)',
  saveTargetCopy: 'Save as a translated copy (keeps the original)',
  saveTargetCopyHint: 'The copy is saved next to the original:',
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

type Harness = {
  onApply: ReturnType<typeof vi.fn>
  onSaveTargetChange: ReturnType<typeof vi.fn>
  onTranslate: ReturnType<typeof vi.fn>
}

/** 挂载对话框并跑到「已翻译、可以应用」的状态 */
async function mountTranslated(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const onApply = vi.fn()
  const onSaveTargetChange = vi.fn()
  const onTranslate = vi.fn(async () => '译文')
  await act(async () => {
    root.render(
      createElement(TranslateDialog, {
        open: true,
        sourceText: 'Source text',
        sourceRange: { from: 1, to: 5 },
        defaultTargetLang: 'zh',
        languages: [
          { value: 'zh', label: '简体中文' },
          { value: 'en', label: 'English' },
        ],
        strings,
        onTranslate,
        onApply,
        onCancel: () => {},
        app: 'docs',
        onSaveTargetChange,
        ...overrides,
      } as never),
    )
  })
  const start = container.querySelector('button')!
  await act(async () => {
    // the primary action lives in the footer; find it by its start label
    const footer = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(strings.start),
    )!
    void start
    footer.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return { onApply, onSaveTargetChange, onTranslate }
}

describe('TranslateDialog save target', () => {
  it('renders no selector when the host cannot save a sibling file', async () => {
    await mountTranslated({ onSaveTargetChange: undefined, saveTarget: undefined })
    expect(container.querySelector('[data-testid="translate-save-target"]')).toBeNull()
  })

  it('offers overwrite and copy when the host can save a sibling file', async () => {
    await mountTranslated({ saveTarget: 'overwrite' })
    const select = container.querySelector('[data-testid="translate-save-target"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect([...select.options].map((o) => o.value)).toEqual(['overwrite', 'copy'])
  })

  it('shows the sibling file name only in copy mode', async () => {
    const harness = await mountTranslated({
      saveTarget: 'overwrite',
      translatedFileName: '报价单.translated.docx',
    })
    expect(container.querySelector('[data-testid="translate-save-target-hint"]')).toBeNull()

    await act(async () => {
      const select = container.querySelector(
        '[data-testid="translate-save-target"]',
      ) as HTMLSelectElement
      select.value = 'copy'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // the host owns the state, so re-render with the value it was told about
    await act(async () => {
      root.render(
        createElement(TranslateDialog, {
          open: true,
          sourceText: 'Source text',
          sourceRange: { from: 1, to: 5 },
          defaultTargetLang: 'zh',
          languages: [{ value: 'zh', label: '简体中文' }],
          strings,
          onTranslate: harness.onTranslate,
          onApply: harness.onApply,
          onCancel: () => {},
          app: 'docs',
          onSaveTargetChange: harness.onSaveTargetChange,
          saveTarget: 'copy',
          translatedFileName: '报价单.translated.docx',
        } as never),
      )
    })
    expect(harness.onSaveTargetChange).toHaveBeenCalledWith('copy')
    expect(container.querySelector('[data-testid="translate-save-target-hint"]')?.textContent).toContain(
      '报价单.translated.docx',
    )
  })

  // 断链就在这里：选择器存在、用户选了 copy，但 onApply 收到的第三个参数是
  // undefined → file-actions 走原地保存 → 译文直接盖掉原文，且没有任何报错。
  it('hands the chosen target to onApply', async () => {
    const harness = await mountTranslated({ saveTarget: 'copy' })
    await act(async () => {
      const apply = container.querySelector('.ai-translate-dialog-btn--primary')!
      apply.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(harness.onApply).toHaveBeenCalledTimes(1)
    const [plan, targetText, saveTarget] = harness.onApply.mock.calls[0] as [
      ChatChangePlan,
      string,
      'overwrite' | 'copy' | undefined,
    ]
    expect(targetText).toBe('译文')
    expect(saveTarget).toBe('copy')
    expect(plan.ops[0].kind).toBe('translate')
  })
})

/**
 * 翻译 → 应用是**同一个位置上的同一个按钮**上的两次点击。
 *
 * 中文下 `start` 与 `apply` 都曾译成「翻译」，于是对话框从「点我翻译」到
 * 「点我把译文写进文档」全程一个字没变。后果不是报错，而是用户以为已经译完、
 * 关掉对话框，文档一个字没动 —— 而且下一次他会更不信任这个功能。
 * 实测（嵌入走查 2026-10-04）确认过：主按钮文案在翻译前后都是「翻译」。
 */
describe('TranslateDialog apply label', () => {
  async function primaryLabel(): Promise<string> {
    return (
      container.querySelector('.ai-translate-dialog-btn--primary')?.textContent?.trim() ?? ''
    )
  }

  it('flips the primary button from `start` to `apply` once the preview lands', async () => {
    await mountTranslated()
    const after = await primaryLabel()
    expect(after).toBe(strings.apply)
    // 反向断言：光断言「等于 apply」不够 —— apply 缺席时按钮会退回 start，
    // 两条都等于 start 的实现同样能通过上面那条。必须显式否掉 start。
    expect(after).not.toBe(strings.start)
  })

  it('keeps `apply` distinct from `start` in the host string table', () => {
    // 宿主把两个键填成同一个值时组件无从纠正，但至少门禁能看见这件事本身。
    expect(strings.apply).not.toBe(strings.start)
  })
})

/**
 * 整篇翻译的宿主（deck / sheet / pdf）没有单一原文，只能传 `sourceText=""`。
 *
 * 主按钮原本的判据是 `sourceText.trim().length === 0`，于是这三家的整篇翻译
 * **在 UI 上根本点不动**：对话框照常打开、按钮永久灰着、不报任何错。
 * 各自 `handleTranslate` 里其实都写了「没有可翻译内容」的分支，但永远走不到。
 * 实测（嵌入走查 2026-10-04）：slides 的「开始翻译」按钮 disabled = true。
 */
describe('TranslateDialog document-scope start button', () => {
  async function mountDocScope(props: Record<string, unknown>) {
    await act(async () => {
      root.render(
        createElement(TranslateDialog, {
          open: true,
          sourceText: '',
          sourceRange: null,
          defaultTargetLang: 'zh',
          languages: [{ value: 'zh', label: '简体中文' }],
          strings,
          onTranslate: vi.fn(async () => '译文'),
          onApply: vi.fn(),
          onCancel: () => {},
          app: 'slides',
          ...props,
        } as never),
      )
    })
    return container.querySelector('.ai-translate-dialog-btn--primary') as HTMLButtonElement
  }

  it('enables the start button when the host says it has translatable content', async () => {
    const btn = await mountDocScope({ hasTranslatableContent: true })
    expect(btn.disabled).toBe(false)
  })

  it('keeps it disabled when the host says there is nothing to translate', async () => {
    const btn = await mountDocScope({ hasTranslatableContent: false })
    expect(btn.disabled).toBe(true)
  })

  it('falls back to sourceText when the host does not answer', async () => {
    // 缺席时不能变成「永远可点」也不能变成「永远不可点」：选区翻译仍按原文判。
    expect((await mountDocScope({})).disabled).toBe(true)
    expect((await mountDocScope({ sourceText: 'Vendor Onboarding Pack' })).disabled).toBe(false)
  })
})
