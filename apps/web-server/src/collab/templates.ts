/**
 * collab/templates — Document template gallery.
 */

import { registerHandle } from '../common/registry.js'

interface DocTemplate {
  id: string
  name: string
  type: 'docs' | 'sheets' | 'slides'
  content: string
  thumbnail?: string
  category: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

const TEMPLATES = new Map<string, DocTemplate>()

function initDefaultTemplates(): void {
  const defaultTemplates: Array<Omit<DocTemplate, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'tpl-resume',
      name: '简历',
      type: 'docs',
      content: '<h1>个人简历</h1>',
      category: '办公',
      tags: ['简历', '个人'],
    },
    {
      id: 'tpl-report',
      name: '工作报告',
      type: 'docs',
      content: '<h1>工作报告</h1>',
      category: '办公',
      tags: ['报告', '工作'],
    },
    {
      id: 'tpl-presentation',
      name: '商务演示',
      type: 'slides',
      content: '[]',
      category: '演示',
      tags: ['演示', '商务'],
    },
  ]

  for (const tpl of defaultTemplates) {
    TEMPLATES.set(tpl.id, {
      ...tpl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
}
initDefaultTemplates()

export function registerTemplatesHandlers(): void {
  registerHandle('templates:list', (_event: unknown, args: unknown) => {
    const { type, category, search } = (args || {}) as { type?: string; category?: string; search?: string }

    let templates = [...TEMPLATES.values()]

    if (type) {
      templates = templates.filter(t => t.type === type)
    }
    if (category) {
      templates = templates.filter(t => t.category === category)
    }
    if (search) {
      const searchLower = search.toLowerCase()
      templates = templates.filter(t =>
        t.name.toLowerCase().includes(searchLower) ||
        t.tags.some(tag => tag.toLowerCase().includes(searchLower)),
      )
    }

    return templates.map(t => ({
      id: t.id,
      name: t.name,
      type: t.type,
      thumbnail: t.thumbnail,
      category: t.category,
      tags: t.tags,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }))
  })

  registerHandle('templates:get', (_event: unknown, args: unknown) => {
    const { id } = args as { id: string }
    return TEMPLATES.get(id) || null
  })

  registerHandle('templates:create', (_event: unknown, args: unknown) => {
    const { name, type, content, category, tags } = args as {
      name: string
      type: 'docs' | 'sheets' | 'slides'
      content: string
      category?: string
      tags?: string[]
    }

    const id = `tpl-${Date.now()}`
    TEMPLATES.set(id, {
      id,
      name,
      type,
      content,
      category: category || '自定义',
      tags: tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    return { ok: true, id }
  })

  registerHandle('templates:delete', (_event: unknown, args: unknown) => {
    const { id } = args as { id: string }
    if (!TEMPLATES.has(id)) return { ok: false, error: 'Template not found' }
    TEMPLATES.delete(id)
    return { ok: true }
  })
}
