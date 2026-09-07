/**
 * Common store: cross-module runtime state and persistence helpers.
 *
 * Centralizes MIME types, data directories, and the small JSON file store
 * shared by the projects, docs, sheets, slides modules so that each module
 * reads/writes through a single source of truth.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
export const ROOT = resolve(__dirname, '../../..')

export const PORT = Number(process.env.PORT) || 8080
export const HOST = process.env.HOST || '0.0.0.0'

export const APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'shell']
export const STATIC_ROOT = resolve(ROOT, 'apps')

export const DATA_DIR = process.env.DATA_DIR || '/tmp/genoffice-data'
mkdirSync(DATA_DIR, { recursive: true })

export const PROJECTS_FILE = join(DATA_DIR, 'projects.json')
export const FILES_DIR = join(DATA_DIR, 'files')
mkdirSync(FILES_DIR, { recursive: true })

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
}

// ----- Project store ---------------------------------------------------------

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  files: string[]
}

export function loadProjects(): Project[] {
  try {
    if (existsSync(PROJECTS_FILE)) {
      return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

export function saveProjects(projects: Project[]): void {
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2))
}

// ----- Recent-doc bookkeeping used by home/* and docs/* ---------------------

export interface DocRecent {
  id: string
  path: string
  name: string
  openedAt: number
  modified?: boolean
}

// ----- File metadata index used by files/* ---------------------------------

export interface FileEntry {
  id: string
  name: string
  path: string
  size: number
  mimeType: string
  createdAt: number
  updatedAt: number
}

export const FILES_INDEX = new Map<string, FileEntry>()
