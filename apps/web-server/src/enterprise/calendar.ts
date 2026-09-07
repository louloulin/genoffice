/**
 * enterprise/calendar — Calendar event management.
 */

import { registerHandle } from '../common/registry.js'
import { CALENDARS } from './state.js'

export function registerCalendarHandlers(): void {
  registerHandle('calendar:create-event', (_event: unknown, args: unknown) => {
    const { title, description, startTime, endTime, attendees, location, reminders, recurrence } = (args || {}) as {
      title: string
      description?: string
      startTime: number
      endTime: number
      attendees?: Array<{ name: string; email: string }>
      location?: string
      reminders?: number[]
      recurrence?: string
    }
    const id = `event-${Date.now()}`
    CALENDARS.set(id, {
      id,
      tenantId: 'default',
      title,
      description: description || '',
      startTime,
      endTime,
      attendees: (attendees || []).map(a => ({ ...a, status: 'pending' as const })),
      location,
      reminders: reminders || [15, 60],
      recurrence,
      status: 'confirmed',
    })
    return { ok: true, id }
  })

  registerHandle('calendar:list-events', (_event: unknown, args: unknown) => {
    const { startDate, endDate, limit, offset } = (args || {}) as {
      startDate?: number
      endDate?: number
      limit?: number
      offset?: number
    }
    const maxResults = limit || 50
    const startOffset = offset || 0
    let events = [...CALENDARS.values()]
    if (startDate) events = events.filter(e => e.startTime >= startDate)
    if (endDate) events = events.filter(e => e.endTime <= endDate)
    return events
      .sort((a, b) => a.startTime - b.startTime)
      .slice(startOffset, startOffset + maxResults)
  })

  registerHandle('calendar:update-event', (_event: unknown, args: unknown) => {
    const { id, title, description, startTime, endTime, attendees, location } = (args || {}) as {
      id: string
      title?: string
      description?: string
      startTime?: number
      endTime?: number
      attendees?: Array<{ name: string; email: string; status: string }>
      location?: string
    }
    const event = CALENDARS.get(id)
    if (!event) return { ok: false, error: 'Event not found' }
    if (title) event.title = title
    if (description !== undefined) event.description = description
    if (startTime) event.startTime = startTime
    if (endTime) event.endTime = endTime
    if (attendees) event.attendees = attendees as typeof event.attendees
    if (location !== undefined) event.location = location
    return { ok: true }
  })

  registerHandle('calendar:delete-event', (_event: unknown, args: unknown) => {
    const { id } = args as { id: string }
    if (!CALENDARS.has(id)) return { ok: false, error: 'Event not found' }
    CALENDARS.delete(id)
    return { ok: true }
  })
}
