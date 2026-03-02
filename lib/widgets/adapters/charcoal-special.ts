/* ===================================================
   Charcoal Special Chart Adapter — Live Supabase → SpecialChartData
   Tenant: Charcoal Plant Operations

   Returns all deliveries flattened to a row-per-delivery format.
   All aggregation (scatter grouping, pie slicing) is done in the widget
   driven by the user's chosen settings.
   =================================================== */

import type { WidgetAdapter } from './types'
import type { SpecialChartData, FieldDef } from '@/components/widgets/special-chart/types'

/* ---- Quarter mapping ---- */
const QUARTER_OF: Record<number, string> = {
  0: 'Q1', 1: 'Q1', 2: 'Q1',
  3: 'Q2', 4: 'Q2', 5: 'Q2',
  6: 'Q3', 7: 'Q3', 8: 'Q3',
  9: 'Q4', 10: 'Q4', 11: 'Q4',
}

const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* ---- Field definitions
   Numeric fields ordered so defaults produce PHP/KG (X) vs Weight (Y).
   Categorical fields ordered so default colorBy is Year.
   ---- */
export const CHARCOAL_FIELDS: FieldDef[] = [
  // Numeric — primary analytics fields first
  { key: 'phpKg',    label: 'PHP/KG',    type: 'numeric',      unit: '₱' },
  { key: 'weightKg', label: 'Weight',    type: 'numeric',      unit: 'kg' },
  { key: 'phpTotal', label: 'PHP Total', type: 'numeric',      unit: '₱' },
  { key: 'sacks',    label: 'Sacks',     type: 'numeric'                 },
  { key: 'mc',       label: 'MC',        type: 'numeric',      unit: '%' },
  { key: 'ash',      label: 'ASH',       type: 'numeric',      unit: '%' },
  { key: 'bdAstm',   label: 'BD ASTM',   type: 'numeric'                 },
  { key: 'bdJis',    label: 'BD JIS',    type: 'numeric'                 },
  { key: 'grit',     label: 'Grit',      type: 'numeric',      unit: '%' },
  { key: 'vm',       label: 'VM',        type: 'numeric',      unit: '%' },
  { key: 'fc',       label: 'FC',        type: 'numeric',      unit: '%' },
  // Categorical — year first so default colorBy is year
  { key: 'year',      label: 'Year',      type: 'categorical' },
  { key: 'quarter',   label: 'Quarter',   type: 'categorical' },
  { key: 'month',     label: 'Month',     type: 'categorical' },
  { key: 'supplier',  label: 'Supplier',  type: 'categorical' },
  { key: 'batchCode', label: 'Batch',     type: 'categorical' },
  { key: 'warehouse', label: 'Warehouse', type: 'categorical' },
  { key: 'blockLoc',  label: 'Block Loc', type: 'categorical' },
]

/* ---- Raw delivery row from Supabase ---- */
interface DeliveryRow {
  transaction_date: string | null
  supplier: string | null
  batch_code: string | null
  block_loc: string | null
  truck_plate: string | null
  sacks: number | string | null
  weight_kg: number | string | null
  cost_basis: number | string | null
  remarks: string | null
  lab_results: unknown
}

/* ---- Warehouse derivation ---- */
function deriveWarehouse(blockLoc: string | null): string {
  if (!blockLoc) return ''
  const first = blockLoc.trim().charAt(0).toUpperCase()
  return ['A', 'B', 'C', 'D'].includes(first) ? first : ''
}

/* ---- Adapter ---- */
export const charcoalSpecialAdapter: WidgetAdapter<SpecialChartData> = {
  id: 'charcoal-special',

  async fetch(client) {
    const PAGE = 1000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function fetchAll<T>(buildQuery: () => any): Promise<T[]> {
      let all: T[] = []
      let from = 0
      let hasMore = true
      while (hasMore) {
        const { data } = await (buildQuery() as ReturnType<typeof buildQuery>).range(from, from + PAGE - 1)
        all = all.concat(data ?? [])
        hasMore = (data?.length ?? 0) === PAGE
        from += PAGE
      }
      return all
    }

    const rawRows = await fetchAll<DeliveryRow>(() =>
      client
        .from('deliveries')
        .select(
          'transaction_date, supplier, batch_code, block_loc, truck_plate, sacks, weight_kg, cost_basis, remarks, lab_results',
        )
        .order('transaction_date', { ascending: true }),
    )

    if (!rawRows || rawRows.length === 0) {
      throw new Error('No special chart data available — falling back to static adapter')
    }

    const rows: Record<string, string | number | null>[] = rawRows.map(row => {
      const date = row.transaction_date ?? ''
      const d = date ? new Date(date + 'T00:00:00') : null
      const isValid = d && !isNaN(d.getTime())

      const year = isValid ? String(d!.getFullYear()) : ''
      const calMonth = isValid ? d!.getMonth() : 0 // 0=Jan
      const monthStr = isValid
        ? `${year}-${String(calMonth + 1).padStart(2, '0')}`
        : ''
      const quarter = isValid ? `${year}-${QUARTER_OF[calMonth] ?? 'Q1'}` : ''
      const monthLabel = isValid ? `${MONTH_ABBREVS[calMonth]} ${year}` : ''

      const weightKg = row.weight_kg != null ? Number(row.weight_kg) : null
      const phpKg = row.cost_basis != null ? Number(row.cost_basis) : null
      const phpTotal =
        weightKg != null && phpKg != null ? phpKg * weightKg : null

      const lab = row.lab_results as Record<string, unknown> | null
      const safeNum = (v: unknown): number | null =>
        v != null ? Number(v) : null

      return {
        date,
        year,
        month: monthStr.length > 0 ? monthStr : null,
        monthLabel: monthLabel || null,
        quarter: quarter || null,
        supplier: row.supplier ?? null,
        batchCode: row.batch_code ?? null,
        blockLoc: row.block_loc ?? null,
        warehouse: deriveWarehouse(row.block_loc),
        truckPlate: row.truck_plate ?? null,
        sacks: row.sacks != null ? Number(row.sacks) : null,
        weightKg,
        phpKg,
        phpTotal,
        mc: safeNum(lab?.mc),
        ash: safeNum(lab?.ash),
        bdAstm: safeNum(lab?.bd_astm),
        bdJis: safeNum(lab?.bd_jis),
        grit: safeNum(lab?.grit),
        vm: safeNum(lab?.vm),
        fc: safeNum(lab?.fc),
      }
    })

    return { rows, fields: CHARCOAL_FIELDS }
  },
}
