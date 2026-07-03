import type Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '@/lib/supabase/admin'
import { canViewPrices } from '@/lib/auth'
import type { Database } from '@/types/supabase'

type BatchStatus = Database['public']['Enums']['batch_status']

// ============================================================
// Tool definitions — sent to the Anthropic API on every request
// ============================================================

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'query_batches',
    description:
      'Query the batches table for raw charcoal inventory. Use this to answer questions about batch status, location, current weight, and average cost. Returns up to `limit` rows.',
    input_schema: {
      type: 'object' as const,
      properties: {
        batch_code: {
          type: 'string',
          description: 'Filter by exact or partial batch_code (case-insensitive ILIKE match). E.g. "MAR-26" to find all March 2026 batches.',
        },
        status: {
          type: 'string',
          enum: ['STORED', 'IN-USE', 'CLOSED', 'FEED', 'SUNDRYING', 'SUNDRIED'],
          description: 'Filter by batch status.',
        },
        location_ref: {
          type: 'string',
          description: 'Filter by warehouse location (exact match). E.g. "A-1A", "D-20D".',
        },
        limit: {
          type: 'number',
          description: 'Maximum rows to return (default 20, max 100).',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_deliveries',
    description:
      'Query the deliveries (RC IN) table for raw charcoal receipt records. Returns transaction_date, supplier, batch_code, block_loc, weight_kg, cost_basis (PHP/KG), sacks, remarks, and lab_results (JSONB object with mc/ash/bd_astm/bd_jis/grit/vm/fc — values may be null if lab encoding is pending). Use this to answer questions about supplier deliveries, weights received, costs, and quality. For weighted-average quality across multiple deliveries, weight each row by its weight_kg.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: {
          type: 'string',
          description: 'Start of date range (YYYY-MM-DD, inclusive).',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (YYYY-MM-DD, inclusive).',
        },
        supplier: {
          type: 'string',
          description: 'Filter by supplier name (case-insensitive partial match).',
        },
        batch_code: {
          type: 'string',
          description: 'Filter by batch_code (case-insensitive partial match).',
        },
        limit: {
          type: 'number',
          description: 'Maximum rows to return (default 20, max 100).',
        },
      },
      required: [],
    },
  },
]

// ============================================================
// Tool executor — dispatches by name, returns result for model
// ============================================================

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const supabase = createAdminClient()

  // The admin client bypasses RLS, so the price boundary must be enforced HERE
  // before any cost/price column reaches the model (and, via the chat, the
  // user). canViewPrices() is the canonical, impersonation-aware gate; when it
  // denies, every ₱/cost field is nulled out of the returned rows below.
  // NEVER re-derive this via profiles.select('role') — that ignores the dev
  // impersonation cookie (CLAUDE.md price-gating rule).
  const showPrices = await canViewPrices()

  switch (name) {
    case 'query_batches': {
      const { batch_code, status, location_ref, limit } = args as {
        batch_code?: string
        status?: BatchStatus
        location_ref?: string
        limit?: number
      }

      const cap = Math.min(Number(limit ?? 20), 100)

      let query = supabase
        .from('batches')
        .select('batch_code, location_ref, status, current_weight, avg_cost')
        .order('updated_at', { ascending: false })
        .limit(cap)

      if (batch_code) {
        query = query.ilike('batch_code', `%${batch_code}%`)
      }
      if (status) {
        query = query.eq('status', status)
      }
      if (location_ref) {
        query = query.eq('location_ref', location_ref)
      }

      const { data, error } = await query

      if (error) {
        return { error: error.message, table: 'batches' }
      }

      // Scrub avg_cost for price-denied roles before returning to the model.
      const batchRows = (data ?? []).map((row) =>
        showPrices ? row : { ...row, avg_cost: null }
      )

      return {
        table: 'batches',
        count: batchRows.length,
        rows: batchRows,
      }
    }

    case 'query_deliveries': {
      const { start_date, end_date, supplier, batch_code, limit } = args as {
        start_date?: string
        end_date?: string
        supplier?: string
        batch_code?: string
        limit?: number
      }

      const cap = Math.min(Number(limit ?? 20), 100)

      let query = supabase
        .from('deliveries')
        .select('transaction_date, supplier, batch_code, block_loc, weight_kg, cost_basis, sacks, lab_results, remarks')
        .order('transaction_date', { ascending: false })
        .limit(cap)

      if (start_date) {
        query = query.gte('transaction_date', start_date)
      }
      if (end_date) {
        query = query.lte('transaction_date', end_date)
      }
      if (supplier) {
        query = query.ilike('supplier', `%${supplier}%`)
      }
      if (batch_code) {
        query = query.ilike('batch_code', `%${batch_code}%`)
      }

      const { data, error } = await query

      if (error) {
        return { error: error.message, table: 'deliveries' }
      }

      // Scrub cost_basis (PHP/KG) for price-denied roles before returning.
      const deliveryRows = (data ?? []).map((row) =>
        showPrices ? row : { ...row, cost_basis: null }
      )

      return {
        table: 'deliveries',
        count: deliveryRows.length,
        rows: deliveryRows,
      }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}
