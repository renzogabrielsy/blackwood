import type { BlendProposal } from './actions';

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

// ─── Supplier search ─────────────────────────────────────────────────────────
// Who filled each block on the grid, so the operator can search a supplier and see
// every block that is ALL theirs vs only SOME theirs. Sourced entirely from
// `view_blocking_block_suppliers` — every sum, share and count comes out of SQL;
// the action only groups the rows into the map below. NO ₱ anywhere in this shape,
// by construction: the view carries no peso column and none derivable, so the
// supplier search needs no `canViewPrices()` gate.

/** One supplier's contribution to one block. */
export interface BlockSupplierShare {
  /** Canonical identity from `public.canonical_supplier()` — match searches on this. */
  supplierKey: string;
  /** A representative raw spelling, for display only. */
  supplierDisplay: string;
  /** Kilograms that supplier delivered into the block. */
  kg: number;
  /** That supplier's share of the block's delivered kg, 0-100 (a PERCENT). */
  sharePct: number;
  /** How many delivery rows those kilograms arrived on. */
  deliveryCount: number;
}

/**
 * The whole supplier picture for the Blocking grid, in one payload.
 *
 * ALL vs SOME: a block is entirely one supplier when `supplierCount === 1`
 * (highlight green) and mixed when `supplierCount > 1` (highlight orange). That
 * count comes straight from the view's `supplier_count_in_block` — never re-derive
 * it from `shares.length`.
 */
export interface BlockingSupplierMap {
  /** Every supplier present on the grid — the autosuggest list, ranked by reach. */
  suppliers: Array<{ key: string; display: string; blockCount: number; totalKg: number }>;
  /** Per block_loc: how many suppliers filled it, and their individual shares. */
  byBlock: Record<string, { supplierCount: number; shares: BlockSupplierShare[] }>;
}

// Blend Proposal types (`BlendProposal`, `BlendProposalBlock`) live in `actions.ts`
// alongside the `buildBlendProposal` server action that produces them — import them
// from there. They are co-located with the action because the action is their sole
// producer and the agreed consumer seam is `import { … } from '.../blocking/actions'`.

// ─── Blend Proposal HISTORY (saved, versioned blends) ────────────────────────
// The LIVE what-if (`BlendProposal`) still lives in `actions.ts`. The types below
// describe SAVED proposals, which is a different thing: a proposal is a statement
// about the yard on a particular day, so a saved version carries BOTH the block
// list (modifiable, keyed by batch identity) and the snapshot the database computed
// at save time (immutable — what was actually proposed).
//
// This file imports `BlendProposal` from `actions.ts` type-only (see the import at
// the top); that circular reference is erased at compile time and keeps ONE
// definition of the modal's shape.

/** Where a proposal sits in its (deliberately small) lifecycle. */
export type BlendProposalStatus = 'draft' | 'planned' | 'fed';

/**
 * One row of the Proposals list — `view_blend_proposal_list`.
 *
 * PESO-FREE by construction: the list view carries no ₱ column and none is
 * derivable, so this payload is safe for every role including Production. Prices
 * live only inside a version snapshot (`SavedBlendProposal`), which is fetched
 * through the `canViewPrices()`-gated `fetchBlendProposalVersion`.
 */
export interface BlendProposalSummary {
  id: string;
  title: string;
  /** The REMARK — free text, always present in the payload (may be null). */
  notes: string | null;
  status: BlendProposalStatus;
  fedOn: string | null;
  /** The newest version number — ALSO the compare-and-set token for saving. */
  currentVersionNo: number;
  /** The compare-and-set token for header edits (rename / status / archive). */
  rowVersion: number;
  versionCount: number;
  blockCount: number | null;
  totalBalanceKg: number | null;
  wMc: number | null;
  wAsh: number | null;
  wBdAstm: number | null;
  currentVersionChangeNote: string | null;
  currentVersionCreatedAt: string | null;
  isArchived: boolean;
  archivedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  updatedAt: string;
  updatedByName: string | null;
}

/**
 * One chip on the version rail — `view_blend_proposal_versions`. Also PESO-FREE.
 */
export interface BlendProposalVersionSummary {
  proposalId: string;
  versionNo: number;
  isCurrent: boolean;
  blockCount: number | null;
  totalBalanceKg: number | null;
  wMc: number | null;
  wAsh: number | null;
  wBdAstm: number | null;
  wBdJis: number | null;
  wGrit: number | null;
  wVm: number | null;
  wFc: number | null;
  changeNote: string | null;
  parentVersionNo: number | null;
  computedAt: string | null;
  createdAt: string;
  createdByName: string | null;
}

/**
 * A saved version, in EXACTLY the shape the existing `BlendProposalDialog` renders,
 * plus who/when/why. Because it extends `BlendProposal`, the modal needs no new
 * gating code: `can_view_prices` is set per call by the server action, which nulls
 * `raw_price_per_kg`, `product_cost_per_kg` and every `blocks[].php_kg` BEFORE the
 * payload leaves the server — the same thing `buildBlendProposal` already does.
 *
 * `blocks[].batch_id` rides on each block (added by the SQL snapshot builder) so a
 * later "Modify" can re-select by BATCH IDENTITY rather than by block_loc, which is
 * reused when a batch empties.
 */
export type SavedBlendProposal = BlendProposal & {
  proposal_id: string;
  version_no: number;
  title: string;
  /** The proposal-level REMARK. */
  notes: string | null;
  /** Why THIS version differs from the one before it. */
  change_note: string | null;
  created_at: string;
  created_by_name: string | null;
  /** When the database computed these numbers. */
  computed_at: string | null;
};

/** Result of `saveBlendProposal`. A business refusal is data, never a throw. */
export type BlendProposalSaveResult =
  | {
      ok: true;
      proposalId: string;
      versionNo: number;
      rowVersion: number;
      /** true when the blend was identical to the current version — no row written. */
      unchanged: boolean;
      message?: string;
    }
  | {
      ok: false;
      reason: string;
      message: string;
      /** Present on `stale` — what the proposal is actually on now. */
      currentVersionNo?: number;
      /** Present on `unknown_block` — the block_locs that are no longer on the grid. */
      blocks?: string[];
    };

/** Result of the header patch / archive / restore actions. */
export type BlendProposalWriteResult =
  | { ok: true; rowVersion: number | null; unchanged: boolean }
  | { ok: false; reason: string; message: string; rowVersion?: number | null };

/** Result of `fetchBlendProposalVersion`. */
export type BlendProposalVersionResult =
  | { ok: true; proposal: SavedBlendProposal }
  | { ok: false; message: string };
