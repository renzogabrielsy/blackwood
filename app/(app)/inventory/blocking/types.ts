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

// ─── Price lens ──────────────────────────────────────────────────────────────
// "Show me the blocks above market." Two server actions in `actions.ts` over two SQL
// functions (migration `20260919025729_blocking_price_lens`): one says what market
// COSTS right now, the other CLASSIFIES the yard against a market price it is given.
//
// EVERYTHING BELOW IS PRICE-SENSITIVE, INCLUDING THE BAND INDEX. Knowing a block sits
// in `[R, +∞)` pins its ₱/kg to within a peso, so there is no price-free half of this
// payload: both actions refuse a `!canViewPrices()` caller BEFORE touching the
// database and return `{ ok: false, reason: 'prices_hidden' }`. Never render this for
// Production, and never try to salvage part of it.

/** Which window "market" is measured over. `manual` is client-side — it needs no basis row. */
export type BlockingMarketBasisKey = 'this_month' | 'last_month' | 'last_3_months' | 'trailing_days';

/**
 * One way of answering "what does market cost". `marketPhpKg` is the weighted average
 * ₱/kg of MARKET-class PRICED deliveries over the window.
 *
 * `marketPhpKg` is **null, never 0**, when the window has no priced market kilos (the
 * 1st of a month before anything arrives). A lens built on ₱0 would call every block
 * "above market", so treat null as "cannot measure market this way yet" and offer
 * another basis — do not coerce it.
 */
export interface BlockingMarketBasis {
  basisKey: BlockingMarketBasisKey;
  marketPhpKg: number | null;
  /** Kilograms the price is weighted over. 0 is a real answer here (nothing priced). */
  pricedKg: number;
  /** MARKET deliveries in the window, priced or not — the price's coverage context. */
  deliveryCount: number;
  /** `yyyy-MM-dd`. The window ANCHORS; `trailing_days` has no upper bound in SQL, so a
   *  future-dated delivery still counts even though `toDate` reads as today. */
  fromDate: string;
  toDate: string;
}

/**
 * One band of the lens — a half-open ₱/kg interval `[lowerPhp, upperPhp)`.
 *
 * `lowerPhp` is null on the FIRST band (open below) and `upperPhp` is null on the LAST
 * (open above). **Null means OPEN, never zero.** Every band is present even when it
 * holds no blocks, so a legend can render the whole scale.
 */
export interface BlockingPriceBand {
  /** 0-based, ascending by price. */
  index: number;
  lowerPhp: number | null;
  upperPhp: number | null;
  blockCount: number;
  kg: number;
  /** PERCENT 0–100 of the PRICED population's kilograms. Null when nothing is priced. */
  kgSharePct: number | null;
  /** PERCENT 0–100 of the PRICED population's blocks. Null when nothing is priced. */
  blockSharePct: number | null;
}

/**
 * The whole lens, for one market price.
 *
 * Checkable invariants the data layer guarantees (and `scripts/verify-blocking-price-lens.ts`
 * proves against the live database):
 *   Σ `bands[].blockCount` + `unpriced.blockCount` === `total.blockCount`
 *   Σ `bands[].kg`         + `unpriced.kg`         === `total.kg`
 *   Σ `kgSharePct` === 100  and  Σ `blockSharePct` === 100  (over the PRICED population)
 */
export interface BlockingPriceLens {
  /** The market price the bands were built from — echoed back so a UI can label them. */
  marketPhpKg: number;
  /** R = floor(market) + 1. 40.23 → 41, 39.8568 → 40, and 40.00 → 41 as well, which is
   *  what keeps the market price itself inside the "at market" band [R−1, R). */
  roundedUpPhp: number;
  /** The whole-peso offsets from R actually used, de-duplicated and ascending. */
  edgeOffsets: number[];
  bands: BlockingPriceBand[];
  /**
   * `block_loc` → band index. THE map the grid colours a cell from.
   *
   * A block is ABSENT from this map when it has no price at all (`avg_php_kg` null or
   * 0 — the L-008 unpriced placeholder). That is deliberate and is not a gap to patch:
   * an unpriced block belongs in NO band, so render it in its normal un-lensed style,
   * never in the cheapest band. `unpriced` says how many there are.
   */
  bandByBlock: Record<string, number>;
  /** Occupied positive-balance blocks with no price — in no band, out of both share
   *  denominators. */
  unpriced: { blockCount: number; kg: number };
  /** Every occupied block with a positive balance — banded plus unpriced. */
  total: { blockCount: number; kg: number };
}

/** Why a lens call came back empty. Each maps to a sentence written for a human. */
export type BlockingPriceLensRefusalReason =
  /** The caller may not see prices. Hide the whole feature; do not retry. */
  | 'prices_hidden'
  /** The chosen basis has no priced market kilos yet — offer another basis. */
  | 'no_market_price'
  | 'invalid_market_price'
  | 'invalid_edge'
  | 'no_edges'
  | 'too_many_edges'
  | 'rpc_error'
  | 'exception';

export type BlockingMarketBasesResult =
  | { ok: true; bases: BlockingMarketBasis[]; trailingDays: number }
  | {
      ok: false;
      reason: 'prices_hidden' | 'invalid_trailing_days' | 'rpc_error' | 'exception';
      message: string;
    };

export type BlockingPriceLensResult =
  | { ok: true; lens: BlockingPriceLens }
  | { ok: false; reason: BlockingPriceLensRefusalReason; message: string };

/** The cap the SQL function enforces on the DE-DUPLICATED edge list. */
export const BLOCKING_PRICE_LENS_MAX_EDGES = 6;
/** `p_edge_offsets`' own default — below market / at market / above market. */
export const BLOCKING_PRICE_LENS_DEFAULT_EDGES: readonly number[] = [-1, 0];
/** `trailing_days` bounds. SQL clamps to this range; the action refuses outside it. */
export const BLOCKING_TRAILING_DAYS_MIN = 1;
export const BLOCKING_TRAILING_DAYS_MAX = 400;
export const BLOCKING_TRAILING_DAYS_DEFAULT = 30;

// ─── Age lens ────────────────────────────────────────────────────────────────
// "Show me the charcoal that has been sitting." The SECOND lens on the frame the price
// lens built, over `fn_blocking_age_lens` (migration `20260919133042_blocking_age_lens`).
//
// TWO THINGS THAT MAKE IT DIFFERENT FROM ITS PRICE SIBLING, both deliberate:
//
//   1. NOTHING HERE IS PRICE-SENSITIVE. No cost/price/value figure exists in the
//      payload and none is derivable from it — age, kilograms, counts and percentages
//      only. So `fetchBlockingAgeLens` has NO `canViewPrices()` call and this lens is
//      shown to EVERY role INCLUDING Production. Do not "fix" that asymmetry by
//      copying the price gate across; `scripts/verify-blocking-age-lens.ts` asserts the
//      gate's ABSENCE precisely so nobody does.
//
//   2. AGE IS NOT DEFINED HERE, OR IN SQL WRITTEN FOR THIS LENS. It is the batch's
//      kg-weighted MEAN DELIVERY DATE carried by its remaining balance, published by
//      `view_batch_age_days` and byte-identical to `view_analytics_aging_watchlist.age_days`
//      (proven every run, gap exactly 0). There is NO FIFO and none is possible, since
//      `rc_out` records which BATCH kilos left and never which delivery within it.

/**
 * One band of the lens — a half-open interval of DAYS, `[lowerDays, upperDays)`.
 *
 * `lowerDays` is **0 on the first band and never null** — age has a floor where money
 * did not, so there is nothing to leave open below. It is a LABEL, not the membership
 * test: a block whose age is NEGATIVE (a future-dated delivery) still lands in band 0.
 * `upperDays` is null on the LAST band and **null means OPEN ABOVE, never 0 days**.
 *
 * Every band is present even when it holds no blocks, so a legend can render the whole
 * scale without inventing rows.
 */
export interface BlockingAgeBand {
  /** 0-based, ascending by age. */
  index: number;
  lowerDays: number;
  upperDays: number | null;
  blockCount: number;
  kg: number;
  /** PERCENT 0–100 of the DATED population's kilograms. Null when nothing is dated. */
  kgSharePct: number | null;
  /** PERCENT 0–100 of the DATED population's blocks. Null when nothing is dated. */
  blockSharePct: number | null;
  /** The band's kg-weighted mean age. **Null, never 0, on an empty band** — no
   *  charcoal there means no age there. Full precision; round it for display. */
  kgWeightedAgeDays: number | null;
}

/**
 * The whole lens, for one set of cut lines.
 *
 * Checkable invariants the data layer guarantees (and `scripts/verify-blocking-age-lens.ts`
 * proves against the live database):
 *   Σ `bands[].blockCount` + `undated.blockCount` === `total.blockCount`
 *   Σ `bands[].kg`         + `undated.kg`         === `total.kg`   (gap exactly 0)
 *   Σ `kgSharePct` === 100  and  Σ `blockSharePct` === 100  (over the DATED population)
 *   `Object.keys(bandByBlock).length + undated.blockCount === total.blockCount`
 *   `bandByBlock` and `ageByBlock` have IDENTICAL key sets.
 */
export interface BlockingAgeLens {
  /** The Asia/Manila calendar date the ages were measured against. `yyyy-MM-dd`. */
  asOf: string;
  /** The cut lines in DAYS actually used, de-duplicated and ascending. */
  edgeDays: number[];
  bands: BlockingAgeBand[];
  /**
   * `block_loc` → band index. THE map the grid colours a cell from.
   *
   * A block is ABSENT from this map when its batch has NO dated delivery, so it has no
   * age at all. That is deliberate and is not a gap to patch: render it in its normal
   * un-lensed style, never in the freshest band. `undated` says how many there are.
   */
  bandByBlock: Record<string, number>;
  /**
   * `block_loc` → that block's age in days, **rounded to 1 decimal** for display.
   * Same key set as `bandByBlock`.
   *
   * The band was decided on the EXACT fractional age, so a block at 59.97 days reads
   * `60.0` here while sitting in band 0. That is correct, not an off-by-one — never
   * re-derive a band from this rounded number.
   */
  ageByBlock: Record<string, number>;
  /** Occupied positive-balance blocks whose batch has no dated delivery — in no band,
   *  out of both share denominators and out of every weighted age. NOT 0 days old. */
  undated: { blockCount: number; kg: number };
  /** Every occupied block with a positive balance — banded plus undated. */
  total: {
    blockCount: number;
    kg: number;
    /** Weighted over the DATED kilos only, while `kg` above counts undated blocks too
     *  (the folds have to add up to the yard). Null when nothing is dated. */
    kgWeightedAgeDays: number | null;
    oldestAgeDays: number | null;
    oldestBlockLoc: string | null;
  };
}

/** Why an age-lens call came back empty. Each maps to a sentence written for a human. */
export type BlockingAgeLensRefusalReason =
  /** No signed-in user. The page itself is behind auth, so this is a session problem. */
  | 'not_signed_in'
  /** A cut line that is not a whole number, is ≤ 0, or is above 5,000 days. */
  | 'invalid_edge'
  | 'no_edges'
  | 'too_many_edges'
  | 'rpc_error'
  | 'exception';

export type BlockingAgeLensResult =
  | { ok: true; lens: BlockingAgeLens }
  | { ok: false; reason: BlockingAgeLensRefusalReason; message: string };

/** The cap the SQL function enforces on the DE-DUPLICATED cut-line list. */
export const BLOCKING_AGE_LENS_MAX_EDGES = 6;
/** `p_edge_days`' own default — up to 60 days / 60–120 / 120–365 / over a year. */
export const BLOCKING_AGE_LENS_DEFAULT_EDGES: readonly number[] = [60, 120, 365];
/** Cut-line bounds in DAYS. Both ends are refused by SQL *and* by the action. */
export const BLOCKING_AGE_EDGE_MIN_DAYS = 1;
export const BLOCKING_AGE_EDGE_MAX_DAYS = 5000;

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
