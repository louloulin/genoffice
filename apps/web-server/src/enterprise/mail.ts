/**
 * enterprise/mail — Mail system (in-memory placeholder).
 */

import { registerHandle } from '../common/registry.js'
import { MAILS } from './state.js'

export function registerMailHandlers(): void {
  registerHandle('mail:send', async (_event: unknown, args: unknown) => {
    const { to, subject, body, cc, bcc, attachments } = (args || {}) as {
      to: Array<{ name: string; email: string }>
      subject: string
      body: string
      cc?: Array<{ name: string; email: string }>
      bcc?: Array<{ name: string; email: string }>
      attachments?: Array<{ name: string; size: number }>
    }
    const id = `mail-${Date.now()}`
    MAILS.set(id, {
      id,
      tenantId: 'default',
      from: { name: 'GenOffice', email: 'noreply@genoffice.ai' },
      to: to || [],
      subject,
      body,
      attachments: attachments || [],
      sentAt: Date.now(),
      status: 'pending',
    })
    // Simulate async send
    setTimeout(() => {
      const mail = MAILS.get(id)
      if (mail) mail.status = 'sent'
    }, 1000)
    return { ok: true, id }
  })

  registerHandle('mail:list', (_event: unknown, args: unknown) => {
    const { folder, limit, offset } = (args || {}) as {
      folder?: 'inbox' | 'sent' | 'draft' | 'trash'
      limit?: number
      offset?: number
    }
    const maxResults = limit || 20
    const startOffset = offset || 0
    return [...MAILS.values()]
      .filter(m => (folder ? m.status === folder : true))
      .slice(startOffset, startOffset + maxResults)
      .map(m => ({
        id: m.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
        sentAt: m.sentAt,
        status: m.status,
      }))
  })

  registerHandle('mail:get', (_event: unknown, args: unknown) => {
    const { id } = args as { id: string }
    return MAILS.get(id) || null
  })
}
