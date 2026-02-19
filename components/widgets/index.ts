import type React from 'react'
import { ChartWidget } from './chart/ChartWidget'
import { KPIStripWidget } from './kpi-strip/KPIStripWidget'
import { QualityScatterWidget } from './quality-scatter/QualityScatterWidget'
import { WarehouseOccupancyWidget } from './warehouse-occupancy/WarehouseOccupancyWidget'
import type { ChartInstanceSettings } from './chart/types'

export { ChartWidget, KPIStripWidget, QualityScatterWidget, WarehouseOccupancyWidget }

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
    displayName: 'Price Chart',
    description: 'Multi-series price and quality trends',
    defaultSize: { w: 8, h: 6, minW: 4, minH: 4 },
    createDefaultSettings: (): ChartInstanceSettings => ({ ...defaultChartSettings }),
    component: ChartWidget,
  },
  {
    type: 'kpi-strip',
    displayName: 'KPI Strip',
    description: 'Key performance indicators at a glance',
    defaultSize: { w: 12, h: 2, minW: 6, minH: 2 },
    createDefaultSettings: () => ({}),
    component: KPIStripWidget,
  },
  {
    type: 'quality-scatter',
    displayName: 'Quality Scatter',
    description: 'Quality metrics scatter plot',
    defaultSize: { w: 6, h: 5, minW: 4, minH: 4 },
    createDefaultSettings: () => ({}),
    component: QualityScatterWidget,
  },
  {
    type: 'warehouse-occupancy',
    displayName: 'Warehouse Occupancy',
    description: 'Block location occupancy overview',
    defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
    createDefaultSettings: () => ({}),
    component: WarehouseOccupancyWidget,
  },
]
