/**
 * slides store: recent-slides bookkeeping shared by the slides module.
 *
 * Recent list lives at DATA_DIR/slides-recent.json (max 10 entries).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../common/store.js'

export const SLIDES_RECENT_FILE = join(DATA_DIR, 'slides-recent.json')

export interface SlideInfo {
  id: string
  path: string
  name: string
  openedAt: number
}

export function loadRecentSlides(): SlideInfo[] {
  try {
    if (existsSync(SLIDES_RECENT_FILE)) {
      return JSON.parse(readFileSync(SLIDES_RECENT_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

export function saveRecentSlides(slides: SlideInfo[]): void {
  writeFileSync(SLIDES_RECENT_FILE, JSON.stringify(slides.slice(0, 10), null, 2))
}
