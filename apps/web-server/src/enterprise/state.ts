/**
 * enterprise/state — Shared in-memory state for enterprise capability modules.
 */

import { DATA_DIR } from '../common/store.js'

// ----------------------------------------------------------------------------
// Doc recents + starred (home:*)
// ----------------------------------------------------------------------------

export const DOCS_RECENT = new Map<string, {
  id: string
  path: string
  name: string
  openedAt: number
}>()

export const DOCS_STARRED = new Set<string>()

// ----------------------------------------------------------------------------
// Tabs (tabs:*)
// ----------------------------------------------------------------------------

export const TABS = new Map<string, {
  id: string
  type: string
  title: string
  path?: string
}>()

// ----------------------------------------------------------------------------
// Users (users:*)
// ----------------------------------------------------------------------------

export interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'editor' | 'viewer'
  createdAt: number
}

export const USERS = new Map<string, User>()

// ----------------------------------------------------------------------------
// Permissions (permissions:*) — distinct from collab permissions
// ----------------------------------------------------------------------------

export const PERMISSIONS = new Map<string, Map<string, string[]>>()

// ----------------------------------------------------------------------------
// Tenants (tenant:*)
// ----------------------------------------------------------------------------

export interface Tenant {
  id: string
  name: string
  domain: string
  plan: 'free' | 'pro' | 'enterprise'
  settings: Record<string, unknown>
  createdAt: number
  status: 'active' | 'suspended' | 'trial'
}

export const TENANTS = new Map<string, Tenant>()

// ----------------------------------------------------------------------------
// Mail (mail:*)
// ----------------------------------------------------------------------------

export interface MailRecord {
  id: string
  tenantId: string
  from: { name: string; email: string }
  to: Array<{ name: string; email: string }>
  subject: string
  body: string
  attachments: Array<{ name: string; size: number }>
  sentAt: number
  status: 'sent' | 'failed' | 'pending'
}

export const MAILS = new Map<string, MailRecord>()

// ----------------------------------------------------------------------------
// Calendar (calendar:*)
// ----------------------------------------------------------------------------

export interface CalendarAttendee {
  name: string
  email: string
  status: 'pending' | 'accepted' | 'declined'
}

export interface CalendarEvent {
  id: string
  tenantId: string
  title: string
  description: string
  startTime: number
  endTime: number
  attendees: CalendarAttendee[]
  location?: string
  reminders: number[]
  recurrence?: string
  status: 'confirmed' | 'cancelled' | 'tentative'
}

export const CALENDARS = new Map<string, CalendarEvent>()

// ----------------------------------------------------------------------------
// Workflow (workflow:*)
// ----------------------------------------------------------------------------

export interface WorkflowStep {
  id: string
  type: 'approval' | 'notification' | 'condition' | 'integration'
  config: Record<string, unknown>
  next?: string
}

export interface Workflow {
  id: string
  tenantId: string
  name: string
  description: string
  steps: WorkflowStep[]
  triggers: string[]
  status: 'active' | 'paused' | 'archived'
  createdAt: number
}

export const WORKFLOWS = new Map<string, Workflow>()

// ----------------------------------------------------------------------------
// Audit (audit:*)
// ----------------------------------------------------------------------------

export interface AuditLog {
  id: string
  tenantId: string
  userId: string
  action: string
  resource: string
  resourceId: string
  details: Record<string, unknown>
  ip: string
  userAgent: string
  timestamp: number
  status: 'success' | 'failure'
}

export const AUDIT_LOGS = new Map<string, AuditLog>()

// ----------------------------------------------------------------------------
// Notifications (notifications:*)
// ----------------------------------------------------------------------------

export interface Notification {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  timestamp: number
  read: boolean
}

export const NOTIFICATIONS = new Map<string, Notification[]>()

// ----------------------------------------------------------------------------
// Cloud storage (cloud:*) — file-level metadata index
// ----------------------------------------------------------------------------

export interface CloudFile {
  id: string
  name: string
  size: number
  type: string
  url: string
  createdAt: number
  updatedAt: number
  public: boolean
}

export const CLOUD_FILES = new Map<string, CloudFile>()

// ----------------------------------------------------------------------------
// Offline queue (offline:*)
// ----------------------------------------------------------------------------

export interface OfflineItem {
  id: string
  action: string
  payload: unknown
  timestamp: number
  synced: boolean
}

export const OFFLINE_QUEUE = new Map<string, OfflineItem>()

// ----------------------------------------------------------------------------
// Search index (search:*)
// ----------------------------------------------------------------------------

export interface SearchEntry {
  id: string
  type: string
  title: string
  content: string
  tags: string[]
  createdAt: number
}

export const SEARCH_INDEX = new Map<string, SearchEntry>()

// Convenience re-export so home/* can use DATA_DIR for default-save-dir.
export { DATA_DIR }
