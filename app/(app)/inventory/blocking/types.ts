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
  /** What the band's kilograms cost, Σ(kg × ₱/kg) ÷ Σkg (added 2026-09-21 so a lens print
   *  never re-weights a band in TypeScript). **Null, never 0, on an EMPTY band** — no
   *  charcoal in the band means no price in the band. */
  kgWeightedPhpKg: number | null;
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
   *  what keeps the market price itself inside the "at market" band [R−1, R).
   *
   *  When the caller passed `roundedUpPhp`, this IS that number — a typed price is the
   *  line itself, so the `manual` basis sets R directly and the measured rule is not
   *  applied. See `BLOCKING_ROUNDED_UP_MIN_PHP` for the UI rule. Nothing in the payload
   *  says which of the two happened, deliberately: with no override the whole payload is
   *  byte-identical to what it was before the parameter existed. */
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
  /**
   * Every occupied block with a positive balance — banded plus unpriced.
   *
   * **`kgWeightedPhpKg` is weighted over the PRICED population only**, while
   * `blockCount` / `kg` count EVERY occupied block. The asymmetry is deliberate: an
   * unpriced block's ₱0 is the L-008 placeholder, so averaging it in would drag the
   * figure down exactly as `batches.avg_cost` once read ₱11.01 against a real ₱39.99.
   * The counts are a count of the yard; the price is a price of what is priced — the same
   * population the two share denominators already use. Null when nothing is priced.
   */
  total: { blockCount: number; kg: number; kgWeightedPhpKg: number | null };
}

/** Why a lens call came back empty. Each maps to a sentence written for a human. */
export type BlockingPriceLensRefusalReason =
  /** The caller may not see prices. Hide the whole feature; do not retry. */
  | 'prices_hidden'
  /** The chosen basis has no priced market kilos yet — offer another basis. */
  | 'no_market_price'
  | 'invalid_market_price'
  /** A given `roundedUpPhp` that is not a whole number of at least ₱1. */
  | 'invalid_rounded_up'
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

/**
 * THE MANUAL BASIS OVERRIDES R, because a typed price IS the line itself (2026-09-21).
 *
 * `R = floor(market) + 1` is right for a MEASURED market — 40.23 → 41 — and rounding up
 * even on a whole measured figure is what keeps the market price itself inside the
 * at-market band. It is WRONG for `manual`: the operator who types ₱41 means ₱41 and up
 * is above market, and the measured rule hands them 42.
 *
 * **THE UI RULE, and it is the whole contract:** for the `manual` basis pass
 * `roundedUpPhp = Math.ceil(typedPrice)` (41 → 41, 40.5 → 41). For EVERY measured basis
 * (`this_month`, `last_month`, `last_3_months`, `trailing_days`) pass **nothing** — R is
 * still computed in exactly one place, in SQL, and omitting the argument leaves the
 * payload byte-identical to what it was before this parameter existed.
 */
export const BLOCKING_ROUNDED_UP_MIN_PHP = 1;
/** int4's ceiling. Not a business rule — the SQL parameter is an `int`. */
export const BLOCKING_ROUNDED_UP_MAX_PHP = 2_147_483_647;

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

// ─── Blend BLOCK FACTS (supplier dominance + the two ages) ───────────────────
// The extra columns the blend modal's "Selected blocks" table, a SAVED version's viewer
// and the landscape print all want per block: WHO filled it (in the page's own green /
// orange vocabulary, naming the dominant supplier) and HOW LONG AGO it was opened and
// last piled on. One server action over `fn_blend_block_facts`
// (migration `20260921034512_blend_block_facts_and_price_lens_rounded_up`).
//
// FOUR THINGS THAT MAKE IT DIFFERENT FROM THE TWO LENSES, all deliberate:
//
//   1. IT IS KEYED BY `batch_id`, NEVER BY `block_loc`. A block address is REUSED —
//      `batches.location_ref` is cleared when a pile empties — so a saved version
//      resolved by block name would silently describe DIFFERENT charcoal under the same
//      address. This is the same load-bearing rule
//      `lib/blocking/blend-diff.ts::resolveBlendBlocks` already follows.
//
//   2. IT IS AS-OF. `asOf` omitted (or null) means TODAY in Asia/Manila, which is what
//      the LIVE modal wants. A SAVED version passes the Asia/Manila calendar date of its
//      own `created_at` (`BlendProposalVersionSummary.createdAt`, or the snapshot's
//      `computed_at`) — because a proposal is a statement about the yard ON A PARTICULAR
//      DAY, and its stored snapshot is immutable and hashed so this could not be added
//      to it. Only deliveries dated on or before that date are considered.
//
//   3. NOTHING HERE IS PRICE-SENSITIVE, so `fetchBlendBlockFacts` has NO
//      `canViewPrices()` call and every role INCLUDING Production may read it. Suppliers,
//      kilograms, shares, dates and day counts — no money column exists and none is
//      derivable. Same posture as `view_blocking_block_suppliers` and the age lens.
//
//   4. THESE DATES ARE NOT AN AGE. `BlockingAgeLens.ageByBlock` (the kg-weighted mean
//      delivery date from `view_batch_age_days`) remains THE age of a block. "Opened" is
//      the FIRST DELIVERY — not the first feeding, and not a closure date, which is an
//      `rc_out` fact. The two families are proven consistent every verify run.

/** One supplier's slice of one block, as it stood on the as-of date. */
export interface BlendBlockSupplierShare {
  /** Canonical identity from `public.canonical_supplier()` — the SAME key the Blocking
   *  supplier search matches on, so the two screens name suppliers identically. */
  key: string;
  /** A representative raw spelling, for display only — never for matching. */
  display: string;
  /** Kilograms that supplier delivered into the block at or before the as-of date. */
  kg: number;
  /** That supplier's share of the block's delivered kg, 0–100 (a PERCENT). **Null, never
   *  0**, when the block's dated deliveries weigh nothing at all. */
  sharePct: number | null;
}

/**
 * One block's supplier picture and its two ages, as of a date.
 *
 * **THE GREEN / ORANGE RULE IS `isSingleSupplier`, a column the database computed.**
 * `true` = the whole block is one supplier (green), `false` = mixed (orange, show
 * `dominantSupplierDisplay` + `dominantSharePct`). It is identical in meaning to
 * `BlockingSupplierMap.byBlock[loc].supplierCount === 1` and is proven equal to
 * `view_blocking_block_suppliers.supplier_count_in_block = 1` on every batch the grid
 * shows. **Never re-derive it from `suppliers.length`** — that is how the blend modal and
 * the supplier search would eventually disagree.
 *
 * **NULL IS NEVER 0.** A block with no delivery at or before the as-of date reads
 * `supplierCount: 0`, `deliveryCount: 0`, `suppliers: []` and NULL on every dominant
 * field, both dates and both day counts — including `isSingleSupplier`, which is
 * **null, not false**: it is neither green nor orange, so render it un-lensed. It is not
 * 0 days old either.
 */
export interface BlendBlockFacts {
  batchId: string;
  batchCode: string;
  /** How many distinct suppliers filled this block. 0 when nothing was delivered yet. */
  supplierCount: number;
  dominantSupplierKey: string | null;
  dominantSupplierDisplay: string | null;
  /** The dominant supplier's share, 0–100 (a PERCENT). Null when unknowable. */
  dominantSharePct: number | null;
  /** THE green/orange rule. Null = neither (nothing delivered as of that date). */
  isSingleSupplier: boolean | null;
  /** Biggest kilograms first; a kg tie breaks on the alphabetically-first canonical key,
   *  so consecutive calls cannot disagree. An EMPTY ARRAY — never null — when nothing was
   *  delivered: a list with nothing in it is itself a fact. Good for a tooltip. */
  suppliers: BlendBlockSupplierShare[];
  /** `yyyy-MM-dd`. When the block was OPENED — its first delivery, not its first feeding. */
  firstDeliveryDate: string | null;
  /** `yyyy-MM-dd`. When it was LAST PILED ON — its latest delivery. */
  lastDeliveryDate: string | null;
  /** Whole days, `asOf − firstDeliveryDate`. Null when undated; never 0 for "unknown". */
  daysSinceOpened: number | null;
  /** Whole days, `asOf − lastDeliveryDate`. Null when undated. */
  daysSinceLastPiled: number | null;
  /** Delivery rows counted, at or before the as-of date. */
  deliveryCount: number;
}

/** Why a blend-block-facts call came back empty. Each maps to a human sentence. */
export type BlendBlockFactsRefusalReason =
  /** No signed-in user. The page is behind auth, so this is a session problem. */
  | 'not_signed_in'
  | 'no_batch_ids'
  | 'too_many_batch_ids'
  /** An element that is not a uuid at all — a typo, not a missing batch. */
  | 'invalid_batch_id'
  /** Not a `yyyy-MM-dd` date, not a real calendar date, or dated in the future. */
  | 'invalid_as_of'
  | 'rpc_error'
  | 'exception';

export type BlendBlockFactsResult =
  | {
      ok: true;
      /**
       * The as-of date the DATABASE actually used, `yyyy-MM-dd` — echoed so a caller
       * never has to compute a Manila calendar date to label the table.
       *
       * **Null only when the call matched NO batch at all** (every id was unknown), in
       * which case there was no row on which to report it and there is nothing to date.
       */
      asOf: string | null;
      /**
       * Keyed by `batchId`. **A batch id that is not a row in `batches` is ABSENT**, so
       * this record can be smaller than the list you asked about — that is the honest
       * answer to "tell me about this batch" when there is no such batch. Render a
       * missing key un-lensed; never fill it with zeroes.
       */
      facts: Record<string, BlendBlockFacts>;
    }
  | { ok: false; reason: BlendBlockFactsRefusalReason; message: string };

/** The cap the server action enforces on the DE-DUPLICATED id list. */
export const BLEND_BLOCK_FACTS_MAX_BATCH_IDS = 250;

// ─── Blend ANALYSIS (the extra viewer / print pages) ─────────────────────────
// Renzo, 2026-09-21: in a saved blend proposal, when viewing AND printing, extra pages
// that "group and arrange blocks according to high priced and low priced and average
// priced … a statistical way of properly grouping these as something we can objectively
// agree to be high and low", another page for MC / ash / BD, maybe age, tables "with
// footers that show totals or averages when appropriate". ONE server action over
// `fn_blend_analysis` (migration `20260921084500_blend_analysis_natural_breaks`).
//
// FIVE THINGS TO KNOW BEFORE RENDERING ANY OF IT:
//
//   1. THE GROUPING IS WEIGHTED NATURAL BREAKS (Jenks), k = 3, labels low / mid / high,
//      computed in SQL by `fn_natural_breaks_3`. It is EXACT — every pair of cut
//      positions between two DISTINCT adjacent values is scored and the best one wins —
//      and the cut lines land where the gaps in THIS blend actually are, not at mean ± 1
//      SD. That statistic was measured on the owner's own proposal and rejected: 24
//      blocks in two price clumps with the kg-weighted mean sitting in the empty gap
//      between them, so mean ± 1 SD filed a ₱39 block and a ₱48 block together as
//      "average". `gvf` (0…1) says how clean the split is and is NULL, never 0, when
//      there is no variance to explain. Read `groupCount`: a blend with fewer than three
//      distinct values legitimately has TWO groups (low / high) or ONE (labelled `mid`).
//
//   2. AGE USES FIXED CUT LINES IN DAYS (default 60 / 120 / 365), not natural breaks,
//      because those days are meaningful in themselves and a grouping that moved with the
//      yard would make "over a year old" mean something different on every proposal.
//      Semantics are the Age lens's exactly, including a NEGATIVE age landing in band 0.
//
//   3. NULL IS NEVER 0. A metric value that is NULL or ≤ 0 is the NOT-RECORDED
//      placeholder (₱0 is the L-008 unpriced placeholder; a lab reading of 0 means no lab
//      result — 11 of the yard's 170 occupied blocks read exactly 0 on ash and both BDs).
//      Such a block is in `unmeasured`, in NO group, out of every average and every share
//      denominator. **Render it un-lensed — never in the cheapest or the freshest band.**
//      In every section Σ `groups[].kg` + `unmeasured.kg` = `totalKg`, and each share
//      family sums to 100 over the measured population.
//
//   4. SAVED vs LIVE. `proposalId` (+ optional `versionNo`, default the current one)
//      reads the STORED snapshot verbatim; `blockLocs` computes a live what-if. `asOf` is
//      the saved version's own Manila date, or today — and it governs AGE only, so a
//      delivery that lands later can never repaint an old proposal. Proven on live data:
//      a saved version dated 2026-09-03 reads its block's last delivery as 2026-09-01
//      while the live analysis of the same blocks reads 2026-09-07.
//
//   5. MONEY IS IN `price` AND NOWHERE ELSE. `quality` and `age` carry no money-named key
//      and nothing derivable into one, so `fetchBlendAnalysis` sets `price` to **null**
//      with `pricesHidden: true` for a `canViewPrices()`-denied caller and still returns
//      the other two. That is the OPPOSITE of the price lens, whose whole payload is
//      price and whose action refuses such a caller outright. Do not add a gate to the
//      quality or age half; `scripts/verify-blend-analysis.ts` asserts the split.

export type BlendAnalysisSource = 'saved' | 'live';

/** The CLOSED label vocabulary, so a colour map can be total. Ascending by VALUE — for
 *  BD, where higher means denser, `high` still means the larger number and the wording is
 *  the UI's decision. */
export type BlendNaturalGroupLabel = 'low' | 'mid' | 'high';

/** Where one cut line sits. `above` IS the membership test; `value` is for a legend. */
export interface BlendNaturalCut {
  index: number;
  /** The largest observed value BELOW the cut. */
  below: number;
  /** The smallest observed value AT OR ABOVE it — the test a block passes. */
  above: number;
  /** The midpoint of `below` and `above`. A LABEL. **Never re-derive membership from it.** */
  value: number;
}

/** What the split cost, for a print that wants to say how good it is. */
export interface BlendNaturalStats {
  /** Blocks that had a measurable value AND a positive weight. */
  n: number;
  distinctCount: number;
  totalWeight: number;
  weightedMean: number | null;
  totalSs: number | null;
  withinSs: number | null;
  betweenSs: number | null;
  /** How many cut pairs were scored. 0 when no search was needed. */
  candidatesConsidered: number;
}

/** The identity every block row in this payload carries. */
export interface BlendAnalysisBlockRef {
  batchId: string | null;
  blockLoc: string;
  batchCode: string;
  /** The block's kilograms IN THE BLEND (the snapshot's balance) — the weight behind
   *  every average in this payload. */
  kg: number;
}

export interface BlendPriceBlock extends BlendAnalysisBlockRef {
  phpKg: number;
}

export interface BlendQualityBlock extends BlendAnalysisBlockRef {
  /** The metric's own reading — a percentage for mc/ash, g/cc for BD. NOT money. */
  value: number;
}

export interface BlendAgeBlock extends BlendAnalysisBlockRef {
  /** Full precision, as `view_batch_age_days` publishes it. **Round for display** — the
   *  Age lens shows 1 decimal. */
  ageDays: number;
  /** `yyyy-MM-dd`. When the block was OPENED (its first delivery at or before `asOf`). */
  firstDeliveryDate: string | null;
  /** `yyyy-MM-dd`. When it was LAST PILED ON (its latest delivery at or before `asOf`). */
  lastDeliveryDate: string | null;
  deliveryCount: number;
}

/** Blocks with no reading (or no positive weight) — in NO group, out of every average. */
export interface BlendAnalysisUnmeasured {
  blockCount: number;
  kg: number;
  /** No reading at all: NULL, or the ≤ 0 placeholder. */
  noValueCount: number;
  /** A reading, but nothing in the pile to weight it with. */
  noWeightCount: number;
  blocks: BlendAnalysisBlockRef[];
}

export interface BlendPriceNaturalGroup {
  index: number;
  label: BlendNaturalGroupLabel;
  /** The range ACTUALLY OBSERVED in the group — not the cut lines around it. */
  rangeMin: number;
  rangeMax: number;
  blockCount: number;
  kg: number;
  /** PERCENT 0–100 of the MEASURED population. Null when nothing is measured. */
  kgSharePct: number | null;
  blockSharePct: number | null;
  kgWeightedPhpKg: number | null;
  /** Σ kg × ₱/kg for the group. */
  valuePhp: number;
  /** Dearest first. */
  blocks: BlendPriceBlock[];
}

export interface BlendPriceNatural {
  metric: 'php_kg';
  /** 3, or fewer on a degenerate blend. Read it; never infer it from `groups.length`. */
  groupCount: number;
  /** Goodness of variance fit, 0…1. NULL — never 0 — when there is no variance. */
  gvf: number | null;
  cuts: BlendNaturalCut[];
  stats: BlendNaturalStats;
  groups: BlendPriceNaturalGroup[];
  unmeasured: BlendAnalysisUnmeasured;
  /** The table's FOOTER. `kgWeightedPhpKg` is the blend's raw price over the MEASURED
   *  blocks; `snapshotPhpKg` is the figure the blend itself stored, lifted verbatim. They
   *  are equal (gap exactly 0) whenever nothing is unmeasured, and when something IS, the
   *  snapshot's figure is the one dragged down by an L-008 zero. */
  overall: {
    blockCount: number;
    kg: number;
    kgWeightedPhpKg: number | null;
    valuePhp: number;
    snapshotPhpKg: number | null;
    snapshotGap: number | null;
    equalsSnapshot: boolean | null;
  };
}

export interface BlendVsMarketBand {
  index: number;
  /** Null = OPEN below (the first band). Null means OPEN, never ₱0. */
  lowerPhp: number | null;
  /** Null = OPEN above (the last band). */
  upperPhp: number | null;
  blockCount: number;
  kg: number;
  kgSharePct: number | null;
  blockSharePct: number | null;
  kgWeightedPhpKg: number | null;
  valuePhp: number;
  blocks: BlendPriceBlock[];
}

/** THE PRICE LENS's logic, applied to this blend's blocks — proven to classify them
 *  identically to `fn_blocking_price_lens` for the same market price, R and edges. */
export interface BlendVsMarket {
  marketPhpKg: number;
  /** `given` = the caller typed it. `as_of_month` = the market of the month the blend
   *  belongs to, read from `view_analytics_rcin_monthly` — THE one definition. */
  marketBasis: 'given' | 'as_of_month';
  /** `yyyy-MM-01` of the month read, or null on the `given` basis. */
  marketBasisMonth: string | null;
  /** R. `floor(market) + 1`, or the caller's `roundedUpPhp` when given — a typed price is
   *  the cut line itself. */
  roundedUpPhp: number;
  edgeOffsets: number[];
  bands: BlendVsMarketBand[];
  unmeasured: { blockCount: number; kg: number; blocks: BlendAnalysisBlockRef[] };
  overall: { blockCount: number; kg: number; kgWeightedPhpKg: number | null; valuePhp: number };
}

/** Why there is no market comparison. A null cannot carry a reason, so it rides beside. */
export interface BlendVsMarketUnavailable {
  reason: 'no_market_price';
  message: string;
  marketBasis: 'given' | 'as_of_month';
  marketBasisMonth: string | null;
}

export interface BlendAnalysisPriceSection {
  natural: BlendPriceNatural;
  /** NULL when market could not be measured — read `vsMarketUnavailable` for the reason
   *  and offer a typed price. NEVER treat a missing market as ₱0. */
  vsMarket: BlendVsMarket | null;
  vsMarketUnavailable: BlendVsMarketUnavailable | null;
}

export type BlendQualityMetric = 'mc' | 'ash' | 'bd_astm' | 'bd_jis';

export interface BlendQualityGroup {
  index: number;
  label: BlendNaturalGroupLabel;
  rangeMin: number;
  rangeMax: number;
  blockCount: number;
  kg: number;
  kgSharePct: number | null;
  blockSharePct: number | null;
  kgWeightedValue: number | null;
  /** Highest reading first. */
  blocks: BlendQualityBlock[];
}

export interface BlendQualityNatural {
  metric: BlendQualityMetric;
  groupCount: number;
  gvf: number | null;
  cuts: BlendNaturalCut[];
  stats: BlendNaturalStats;
  groups: BlendQualityGroup[];
  unmeasured: BlendAnalysisUnmeasured;
  /** `kgWeightedValue` is the blend's weighted reading over the MEASURED blocks;
   *  `snapshotValue` is the blend's own stored weighted stat, lifted verbatim. The gap is
   *  exactly 0 whenever nothing is unmeasured. */
  overall: {
    blockCount: number;
    kg: number;
    kgWeightedValue: number | null;
    snapshotValue: number | null;
    snapshotGap: number | null;
    equalsSnapshot: boolean | null;
  };
}

export interface BlendAnalysisQualitySection {
  /** Render in this order. */
  metrics: BlendQualityMetric[];
  byMetric: Record<BlendQualityMetric, BlendQualityNatural>;
}

export interface BlendAgeBand {
  index: number;
  /** 0 on the first band — age has a floor where money does not. */
  lowerDays: number;
  /** Null = OPEN ABOVE, never 0 days. */
  upperDays: number | null;
  blockCount: number;
  kg: number;
  kgSharePct: number | null;
  blockSharePct: number | null;
  kgWeightedAgeDays: number | null;
  /** Oldest first. */
  blocks: BlendAgeBlock[];
}

export interface BlendAnalysisAgeSection {
  /** `yyyy-MM-dd`. The day the ages are measured on. */
  asOf: string;
  edgeDays: number[];
  bands: BlendAgeBand[];
  /** Blocks whose batch has NO delivery at or before `asOf` — in no band, out of every
   *  average. NOT 0 days old. */
  undated: { blockCount: number; kg: number; blocks: BlendAnalysisBlockRef[] };
  overall: {
    blockCount: number;
    kg: number;
    kgWeightedAgeDays: number | null;
    oldestAgeDays: number | null;
    oldestBlockLoc: string | null;
    oldestBatchCode: string | null;
  };
}

export interface BlendAnalysis {
  source: BlendAnalysisSource;
  /** `yyyy-MM-dd`. The saved version's own Manila date, or today. */
  asOf: string;
  proposalId: string | null;
  versionNo: number | null;
  title: string | null;
  /** The snapshot's own `computed_at`, for an "as computed on" line. */
  snapshotComputedAt: string | null;
  /** When THIS analysis was run. */
  computedAt: string;
  blockCount: number;
  totalKg: number;
  /** **NULL when the caller may not see prices** — the whole section is removed server
   *  side, see `pricesHidden`. Everything else is still there. */
  price: BlendAnalysisPriceSection | null;
  /** True when `price` was removed because of `canViewPrices()`. Say so in the UI rather
   *  than rendering an empty page. */
  pricesHidden: boolean;
  quality: BlendAnalysisQualitySection;
  age: BlendAnalysisAgeSection;
}

/** Why an analysis call came back empty. Each maps to a sentence written for a human. */
export type BlendAnalysisRefusalReason =
  | 'not_signed_in'
  /** A proposal AND a block list were both given. Pick one. */
  | 'both_sources'
  /** Neither was given (a `versionNo` on its own counts as neither). */
  | 'no_source'
  | 'invalid_proposal_id'
  | 'invalid_version_no'
  | 'unknown_proposal'
  | 'unknown_version'
  | 'no_blocks'
  | 'too_many_blocks'
  /** A block_loc with no active batch in it right now — NAMED, never silently dropped. */
  | 'unknown_block_loc'
  | 'invalid_price_edge'
  | 'no_price_edges'
  | 'too_many_price_edges'
  | 'invalid_age_edge'
  | 'no_age_edges'
  | 'too_many_age_edges'
  /** A `roundedUpPhp` that is not a whole number of at least ₱1. */
  | 'invalid_rounded_up'
  | 'invalid_market_price'
  | 'rpc_error'
  | 'exception';

export type BlendAnalysisResult =
  | { ok: true; analysis: BlendAnalysis }
  | { ok: false; reason: BlendAnalysisRefusalReason; message: string };

/** Exactly ONE source. `versionNo` without `proposalId` is `no_source`. */
export interface BlendAnalysisInput {
  proposalId?: string | null;
  /** Omitted = the proposal's CURRENT version, which is what the viewer opens on. */
  versionNo?: number | null;
  blockLocs?: readonly string[] | null;
  priceEdgeOffsets?: readonly number[] | null;
  ageEdgeDays?: readonly number[] | null;
  /** A typed market ₱/kg. Omitted = the market of the blend's own month. */
  marketPhpKg?: number | null;
  /** THE cut line R, for a TYPED market price only: pass `Math.ceil(typedPrice)`. For a
   *  measured market pass nothing — R stays `floor(market) + 1`, computed in SQL. */
  roundedUpPhp?: number | null;
}

/** The cap the server action AND the SQL function enforce on the block list. */
export const BLEND_ANALYSIS_MAX_BLOCKS = 250;
/** `p_price_edge_offsets`' own default — below market / at market / above market. */
export const BLEND_ANALYSIS_DEFAULT_PRICE_EDGES: readonly number[] = [-1, 0];
/** `p_age_edge_days`' own default — the owner-approved cut lines. */
export const BLEND_ANALYSIS_DEFAULT_AGE_EDGES: readonly number[] = [60, 120, 365];
/** Render order for the quality pages. ONE definition, imported never re-typed. */
export const BLEND_ANALYSIS_QUALITY_METRICS: readonly BlendQualityMetric[] = [
  'mc',
  'ash',
  'bd_astm',
  'bd_jis',
];
