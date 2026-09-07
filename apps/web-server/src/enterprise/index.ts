/**
 * enterprise/* — Public entry for enterprise / home / shell parity channels.
 */

import { registerAuditHandlers } from './audit.js'
import { registerAuthHandlers } from './auth.js'
import { registerCalendarHandlers } from './calendar.js'
import { registerChartHandlers } from './chart.js'
import { registerCloudHandlers } from './cloud.js'
import { registerHomeHandlers } from './home.js'
import { registerMailHandlers } from './mail.js'
import { registerMobileHandlers } from './mobile.js'
import { registerMultimodalHandlers } from './multimodal.js'
import { registerNotificationsHandlers } from './notifications.js'
import { registerOfflineHandlers } from './offline.js'
import { registerPermissionsHandlers } from './permissions.js'
import { registerPreviewHandlers } from './preview.js'
import { registerSearchHandlers } from './search.js'
import { registerSpeechHandlers } from './speech.js'
import { registerTabsHandlers } from './tabs.js'
import { registerTenantHandlers } from './tenant.js'
import { registerUpdateHandlers } from './update.js'
import { registerUsersHandlers } from './users.js'
import { registerVisualizationHandlers } from './visualization.js'
import { registerWorkflowHandlers } from './workflow.js'

export function registerEnterpriseHandlers(): void {
  registerHomeHandlers()
  registerTabsHandlers()
  registerUpdateHandlers()
  registerUsersHandlers()
  registerPermissionsHandlers()
  registerNotificationsHandlers()
  registerTenantHandlers()
  registerMailHandlers()
  registerCalendarHandlers()
  registerWorkflowHandlers()
  registerAuthHandlers()
  registerAuditHandlers()
  registerCloudHandlers()
  registerMobileHandlers()
  registerOfflineHandlers()
  registerMultimodalHandlers()
  registerChartHandlers()
  registerVisualizationHandlers()
  registerSpeechHandlers()
  registerPreviewHandlers()
  registerSearchHandlers()
}
