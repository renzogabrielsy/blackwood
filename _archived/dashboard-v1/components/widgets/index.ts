import type React from 'react'
import { ChartWidget } from './chart/ChartWidget'
import { KPIStripWidget } from './kpi-strip/KPIStripWidget'
import { SpecialChartWidget } from './special-chart/SpecialChartWidget'
import { WarehouseOccupancyWidget } from './warehouse-occupancy/WarehouseOccupancyWidget'
import type { ChartInstanceSettings } from './chart/types'
import type { KPIStripSettings } from './kpi-strip/types'
import type { WarehouseData } from './warehouse-occupancy/types'
import type { SpecialChartSettings, SpecialChartData } from './special-chart/types'

export { ChartWidget, KPIStripWidget, SpecialChartWidget, WarehouseOccupancyWidget }
export type { WarehouseData, SpecialChartData, SpecialChartSettings }

export interface WidgetDefinition {
  type: string
  displayName: string
  description: string
  defaultSize: { w: number; h: number; minW?: number; minH?: number }
  createDefaultSettings: () => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: React.ComponentType<any>
}

const defaultChartSettings: ChartInstanceSettings = {
  title: 'Chart',
  xAxisKey: 'month',
  ySeries: [],
  fontScale: 0,
}

export const WIDGET_REGISTRY: WidgetDefinition[] = [
  {
    type: 'chart',
    displayName: 'Regular Chart',
    description: 'Line, bar, area charts with dual Y-axis and comparison',
    defaultSize: { w: 8, h: 6, minW: 4, minH: 4 },
    createDefaultSettings: (): ChartInstanceSettings => ({ ...defaultChartSettings }),
    component: ChartWidget,
  },
  {
    type: 'kpi-strip',
    displayName: 'KPI Strip',
    description: 'Key performance indicators at a glance',
    defaultSize: { w: 12, h: 2, minW: 6, minH: 2 },
    createDefaultSettings: (): KPIStripSettings => ({}),
    component: KPIStripWidget,
  },
  {
    type: 'special-chart',
    displayName: 'Special Chart',
    description: 'Scatter, pie, donut — fully customizable',
    defaultSize: { w: 6, h: 5, minW: 4, minH: 4 },
    createDefaultSettings: (): SpecialChartSettings => ({
      chartType: 'scatter',
      granularity: 'month',
      showRefLines: true,
      quarterFilter: [],
    }),
    component: SpecialChartWidget,
  },
  {
    type: 'warehouse-occupancy',
    displayName: 'Warehouse Occupancy',
    description: 'Block location occupancy overview',
    defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
    createDefaultSettings: (): Record<string, never> => ({}),
    component: WarehouseOccupancyWidget,
  },
]
