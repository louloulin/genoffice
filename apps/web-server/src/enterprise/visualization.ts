/**
 * enterprise/visualization — Dashboard widget composition.
 */

import { registerHandle } from '../common/registry.js'

export function registerVisualizationHandlers(): void {
  registerHandle('visualization:create-dashboard', async (_event: unknown, args: unknown) => {
    const { widgets } = args as {
      widgets: Array<{
        id: string
        type: 'chart' | 'table' | 'metric' | 'text'
        data: unknown
        position: { x: number; y: number; w: number; h: number }
      }>
    }

    return {
      id: `dashboard-${Date.now()}`,
      widgets: widgets.map(w => ({
        id: w.id,
        type: w.type,
        position: w.position,
      })),
      createdAt: Date.now(),
    }
  })

  registerHandle('visualization:get-chart-data', (_event: unknown, args: unknown) => {
    const { docId, chartId } = args as { docId: string; chartId: string }
    return {
      labels: ['一月', '二月', '三月', '四月', '五月'],
      datasets: [
        { label: '销售额', data: [120, 150, 180, 140, 200] },
        { label: '成本', data: [80, 90, 100, 85, 110] },
      ],
    }
  })
}
