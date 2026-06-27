/**
 * Block statuses the grid actively styles. A batch opened via the RC Movement matrix
 * may carry a historical status (CLOSED/FEED) — represented as the catch-all string so
 * the panel can still render it (unmatched statuses just get no status color).
 */
export type BlockStatus = 'STORED' | 'IN-USE' | 'SUNDRYING' | 'SUNDRIED' | (string & {});

export interface BlockData {
  batch_code: string;
  batch_id: string;
  status: BlockStatus;
  balance: number;
  total_in: number;
  php: number | null;    // null when role-gated
  bd_astm: number;
  bd_jis: number;
  ash: number;
  mc: number;
  grit: number;
  vm: number;
  fc: number;
}

export interface BlockingGridData {
  blocks: Record<string, BlockData>;  // keyed by block_loc
  canViewPrices: boolean;
}

/**
 * Batch-accurate header summary for a single batch_id, returned by
 * `fetchBlockDataForBatch`. Unlike `view_blocking_grid` (which only surfaces the
 * batch CURRENTLY occupying a block_loc and filters out CLOSED/FEED), this is keyed
 * directly on batch_id with NO status filter — so the RC Movement matrix can open the
 * detail panel for a historical block whose slot has since been reused or closed.
 */
export interface BlockDataForBatch {
  /** null when the batch_id was not found. */
  blockData: BlockData | null;
  canViewPrices: boolean;
}

export interface DeliveryHistoryRecord {
  id: string;
  transaction_date: string;
  supplier: string;
  sacks: number;
  weight_kg: number;
  cost_basis?: number;  // undefined when role-gated
  mc?: number;          // from lab_results
  bd_astm?: number;     // from lab_results
  ash?: number;         // from lab_results
  // Weight-deduction / true-weight annotation (display-only — see DEDUCTIONS_DESIGN.md).
  true_weight_kg?: number | null;
  deduction_note?: string | null;
}

/** Full delivery record returned by fetchSingleDelivery for the edit dialog */
export interface FullDeliveryRecord {
  id: string;
  transaction_date: string;
  supplier: string;
  batch_code: string;
  block_loc: string | null;
  truck_plate: string | null;
  sacks: number;
  weight_kg: number;
  cost_basis: number | null;  // null when role-gated (withheld from non-price-viewers)
  remarks: string | null;
  // Weight-deduction / true-weight annotation (display-only — see DEDUCTIONS_DESIGN.md).
  true_weight_kg?: number | null;
  deduction_note?: string | null;
  lab_results: {
    mc: number;
    ash: number;
    bd_astm: number;
    bd_jis: number;
    grit: number;
    vm: number;
    fc: number;
  };
}

export interface UsageHistoryRecord {
  transaction_date: string;
  destination: string;
  weight_kg: number;
  production_batch: string | null;
  avg_price: number | null;  // null when role-gated
}

export interface BlockingDetailData {
  deliveries: DeliveryHistoryRecord[];
  usage: UsageHistoryRecord[];
  notes: string | null;
  avg_cost: number | null;  // batch avg_cost, role-gated
}

// Blend Proposal types (`BlendProposal`, `BlendProposalBlock`) live in `actions.ts`
// alongside the `buildBlendProposal` server action that produces them — import them
// from there. They are co-located with the action because the action is their sole
// producer and the agreed consumer seam is `import { … } from '.../blocking/actions'`.
