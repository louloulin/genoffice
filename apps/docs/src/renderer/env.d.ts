/// <reference types="vite/client" />

import type { DesktopApi } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'
import type { GenOfficeEmbedEvent } from '@genoffice/web-sdk/dataflare/guest'

declare global {
  interface Window {
    desktop: DesktopApi
    projectApi: ProjectApi
    dataflareOfficeBridge?: {
      postEvent(event: GenOfficeEmbedEvent): void
      isEmbedded: boolean
      getRevision(): string
    }
  }
}

export {}
