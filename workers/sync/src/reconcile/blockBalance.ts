/**
 * blockBalance.ts — the PURE block-balance cross-check engine (RB phase of the Sync
 * Reconciliation Model; `SYNC_RECONCILIATION_MODEL.md` → phase RB, Refinement 2;
 * `SYNC_VALIDITY_RULESET.md` → Blocking B1–B5).
 *
 * This is an INDEPENDENT, ORTHOGONAL cross-check — NOT same-fact reconciliation like
 * rc_out (`./rcOut.ts`). It compares the operator's hand-kept **Sheet Blocking tab**
 * (`../reports/gsheet/blocking.ts`) against the app's **computed** `view_blocking_grid`
 * (balance = ΣRC_IN − ΣRC_OUT). Because the computed side is derived from BOTH RC IN and
 * RC OUT, this check ties the two transaction reports together — it catches
 * inconsistencies *between* them that same-fact reconciliation can't, and it is anchored
 * OUTSIDE the transaction data entirely (it would have caught L-037 from a different
 * angle: the block's operator balance vs its DB-derived balance).
 *
 * READ-ONLY. It produces `block_diff` descriptors and writes NOTHING to inventory tables.
 * A `block_diff` is arbitrated by a human in Sync Review (dismiss/investigate); a real fix
 * means correcting the underlying rc_in/rc_out via the existing paths — there is no
 * bespoke block resolver (RB v1).
 *
 * ── The two-level check (Refinement 2 — WHY BOTH LEVELS MATTER) ────────────────
 *   B1 (per-block): each block's Sheet balance vs the computed balance. Catches a weight
 *       mis-attributed BETWEEN two blocks — which nets to zero in the grand total.
 *   B2 (grand-total): Σ(Sheet balances) vs Σ(computed balances). The coarse backstop —
 *       catches a systemic drift that per-block noise might hide, and confirms nothing was
 *       dropped. "Every block matches AND the total matches" = genuinely balanced. The two
 *       are complementary: B1 catches what B2 hides (offsetting per-block errors), B2 is
 *       the safety net over B1's threshold.
 *   B3 (one-active-batch): a block with 2+ non-CLOSED batches in the DB (from the computed
 *       side's `activeBatchCount`).
 *   B4 (batch identity): the Sheet's batch for a block vs the computed batch_code
 *       (alias-aware: MARCH-… ≡ MAR-…).
 *
 * Negative computed balance is NOT a block_diff by itself (Ruleset O7 / Renzo 2026-07-07:
 * usually just a late delivery not yet entered — soft-warn, never hold). But if it also
 * DISAGREES with the Sheet, that disagreement is a B1 diff like any other.
 *
 * PURE + deterministic: no DB, no I/O, no imports beyond types. The runSync shadow step
 * (`../workflows/runSync.ts::reconcileBlockBalanceShadow`) extracts the Sheet tab + reads
 * the view and feeds both sides here.
 */

/** The four block_diff shapes. */
export type BlockDiffKind = "balance" | "batch_mismatch" | "multi_batch" | "grand_total";

/** One block the Sheet Blocking grid states (input, from the extractor). */
export interface SheetBlock {
  block_loc: string;
  batch_code: string | null;
  balance_kg: number | null;
}

/** One block the app computes (input, from `view_blocking_grid` + `batches`). */
export interface ComputedBlock {
  block_loc: string;
  batch_code: string | null;
  balance_kg: number | null;
  /**
   * Count of non-CLOSED batches the DB places at this block_loc (from `batches`). The
   * view collapses to one row per block (DISTINCT ON), so B3 needs this separate count.
   * Default 1 (or 0 for a block that only exists on the Sheet).
   */
  activeBatchCount?: number;
}

/** One block-level (or grand-total) disagreement. NEVER carries a ₱/cost field. */
export interface BlockDiff {
  kind: BlockDiffKind;
  /** The block; null ONLY for the single grand_total diff. */
  block_loc: string | null;
  /** Sheet-side balance (kg) — null when the block is absent from the Sheet. */
  sheet_kg: number | null;
  /** Computed-side balance (kg) — null when the block is absent from the app. */
  computed_kg: number | null;
  /** sheet_kg − computed_kg (per-block or grand total). null when either side is absent. */
  delta: number | null;
  /** For batch_mismatch: the two competing batch codes. */
  sheet_batch?: string | null;
  computed_batch?: string | null;
  /** For multi_batch: how many active batches the DB has at this block. */
  active_batch_count?: number;
  /** Plain-language explanation (used verbatim as the case detail). */
  detail: string;
}

export interface BlockTotals {
  /** Σ of the Sheet's per-block balances (kg). */
  sheetSumKg: number;
  /** Σ of the computed per-block balances (kg, negatives included). */
  computedSumKg: number;
  /** The Sheet's own stated grand total (kg), or null. */
  sheetStatedTotalKg: number | null;
  /** sheetSumKg − computedSumKg. */
  delta: number;
  sheetBlocks: number;
  computedBlocks: number;
  /** Blocks present on BOTH sides (the per-block comparison population). */
  comparedBlocks: number;
  /** Computed blocks whose balance is negative — soft-warn only, NOT a diff (O7). */
  negativeComputedBlocks: string[];
}

export interface BlockReconciliation {
  blockDiffs: BlockDiff[];
  totals: BlockTotals;
}

export interface BlockBalanceOptions {
  /**
   * Per-block balance tolerance (kg). Default 1 — both sides carry integer kg and the
   * Sheet balance is a SUMIFS over the same physical events, so anything above 1 kg is
   * real drift worth a human's eye (this is the FINE net).
   */
  blockBalanceTolKg?: number;
  /**
   * Grand-total tolerance (kg). Default 100 — deliberately COARSER than the per-block
   * net: B2 is the systemic backstop, not a second fine check. Small per-block rounding
   * across ~170 blocks should never trip it; a real dropped/duplicated block will.
   */
  grandTotalTolKg?: number;
  /** The Sheet's stated grand total (kg), threaded through for the totals + B2 note. */
  sheetStatedTotalKg?: number | null;
}

const DEFAULTS = {
  blockBalanceTolKg: 1,
  grandTotalTolKg: 100,
} as const;

/** Trim + UPPERCASE — the block_loc normalization used on BOTH sides. */
function normLoc(s: string): string {
  return s.trim().toUpperCase();
}

/** kg → a clean display number (1 decimal max). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Alias-aware batch identity (B4) ─────────────────────────────────────────
// Mirrors the pairs in `../reports/gsheet/extract.ts::MONTH_PREFIX_ALIASES` so the same
// physical batch written "MARCH-26-BLK4" (Sheet) and "MAR-26-BLK4" (DB) is ONE batch, not
// a false batch_mismatch. Kept LOCAL so this engine stays pure/self-contained (importing
// extract.ts would drag exceljs into the engine's module graph).
const MONTH_CANONICAL: Record<string, string> = {
  JAN: "JANUARY", JANUARY: "JANUARY",
  FEB: "FEBRUARY", FEBRUARY: "FEBRUARY",
  MAR: "MARCH", MARCH: "MARCH",
  APR: "APRIL", APRIL: "APRIL",
  MAY: "MAY",
  JUN: "JUNE", JUNE: "JUNE",
  JUL: "JULY", JULY: "JULY",
  AUG: "AUGUST", AUGUST: "AUGUST",
  SEP: "SEPTEMBER", SEPT: "SEPTEMBER", SEPTEMBER: "SEPTEMBER",
  OCT: "OCTOBER", OCTOBER: "OCTOBER",
  NOV: "NOVEMBER", NOVEMBER: "NOVEMBER",
  DEC: "DECEMBER", DECEMBER: "DECEMBER",
};

const BATCH_CODE_RE = /^([A-Z]+)-(\d{2})-(.+)$/;

/** Canonicalize a batch code so month-prefix aliases collapse (MAR/MARCH → MARCH). An
 *  un-parseable code is returned uppercased+trimmed as-is. */
function canonicalBatchCode(code: string): string {
  const up = code.trim().toUpperCase();
  const m = BATCH_CODE_RE.exec(up);
  if (!m) return up;
  const prefix = MONTH_CANONICAL[m[1]] ?? m[1];
  return `${prefix}-${m[2]}-${m[3]}`;
}

/** Do two batch codes name the same physical batch (alias-aware)? */
export function batchCodesMatch(a: string, b: string): boolean {
  return canonicalBatchCode(a) === canonicalBatchCode(b);
}

/**
 * The block-balance cross-check. Compares the Sheet's per-block grid against the computed
 * grid, per block_loc (B1/B4) + at the block-multiplicity level (B3) + at the grand total
 * (B2). Pure — every input is already extracted; nothing here reads the DB or the Sheet.
 */
export function reconcileBlockBalance(
  sheet: SheetBlock[],
  computed: ComputedBlock[],
  opts: BlockBalanceOptions = {},
): BlockReconciliation {
  const blockTol = opts.blockBalanceTolKg ?? DEFAULTS.blockBalanceTolKg;
  const grandTol = opts.grandTotalTolKg ?? DEFAULTS.grandTotalTolKg;
  const statedTotal = opts.sheetStatedTotalKg ?? null;

  // Index both sides by normalized block_loc (first wins on a dup — the extractor already
  // drops Sheet dups, and the view is DISTINCT ON block_loc).
  const sheetMap = new Map<string, SheetBlock>();
  for (const b of sheet) {
    const loc = normLoc(b.block_loc);
    if (!sheetMap.has(loc)) sheetMap.set(loc, { ...b, block_loc: loc });
  }
  const compMap = new Map<string, ComputedBlock>();
  for (const b of computed) {
    const loc = normLoc(b.block_loc);
    if (!compMap.has(loc)) compMap.set(loc, { ...b, block_loc: loc });
  }

  const diffs: BlockDiff[] = [];
  const negativeComputedBlocks: string[] = [];

  // Union of block_locs, sorted for deterministic output order.
  const allLocs = [...new Set([...sheetMap.keys(), ...compMap.keys()])].sort();
  let comparedBlocks = 0;

  for (const loc of allLocs) {
    const s = sheetMap.get(loc);
    const c = compMap.get(loc);

    // B3 — one-active-batch (computed side). A block the DB stacks 2+ non-CLOSED batches on.
    if (c && (c.activeBatchCount ?? 1) >= 2) {
      diffs.push({
        kind: "multi_batch",
        block_loc: loc,
        sheet_kg: s?.balance_kg ?? null,
        computed_kg: c.balance_kg ?? null,
        delta: null,
        active_batch_count: c.activeBatchCount,
        detail:
          `Block ${loc} has ${c.activeBatchCount} active (non-CLOSED) batches in the app — ` +
          `a block should hold exactly one. Close or reassign the extra batch(es).`,
      });
    }

    // Track negative computed balances (soft-warn, O7) — NOT a diff on its own.
    if (c && typeof c.balance_kg === "number" && c.balance_kg < 0) {
      negativeComputedBlocks.push(loc);
    }

    const sKg = s?.balance_kg ?? null;
    const cKg = c?.balance_kg ?? null;

    if (s && c) {
      comparedBlocks += 1;
      // B4 — batch identity (only when both name a batch).
      if (s.batch_code && c.batch_code && !batchCodesMatch(s.batch_code, c.batch_code)) {
        diffs.push({
          kind: "batch_mismatch",
          block_loc: loc,
          sheet_kg: sKg,
          computed_kg: cKg,
          delta: sKg !== null && cKg !== null ? round1(sKg - cKg) : null,
          sheet_batch: s.batch_code,
          computed_batch: c.batch_code,
          detail:
            `Block ${loc} holds '${s.batch_code}' in the Sheet but '${c.batch_code}' in the app.`,
        });
      }
      // B1 — per-block balance.
      if (typeof sKg === "number" && typeof cKg === "number") {
        const delta = sKg - cKg;
        if (Math.abs(delta) > blockTol) {
          diffs.push({
            kind: "balance",
            block_loc: loc,
            sheet_kg: sKg,
            computed_kg: cKg,
            delta: round1(delta),
            detail:
              `Block ${loc} balance disagrees: Sheet ${fmt(sKg)} kg vs app ${fmt(cKg)} kg ` +
              `(Δ ${fmt(round1(delta))} kg).`,
          });
        }
      }
    } else if (s && !c) {
      // Present on the Sheet, absent from the computed grid (DB has it CLOSED/empty).
      diffs.push({
        kind: "balance",
        block_loc: loc,
        sheet_kg: sKg,
        computed_kg: null,
        delta: null,
        sheet_batch: s.batch_code,
        detail:
          `Block ${loc} is on the Sheet (${s.batch_code ?? "no batch"}, ${fmt(sKg ?? 0)} kg) but ` +
          `the app has no active batch there.`,
      });
    } else if (!s && c) {
      // Present in the computed grid, absent from the Sheet.
      diffs.push({
        kind: "balance",
        block_loc: loc,
        sheet_kg: null,
        computed_kg: cKg,
        delta: null,
        computed_batch: c.batch_code,
        detail:
          `Block ${loc} is active in the app (${c.batch_code ?? "no batch"}, ${fmt(cKg ?? 0)} kg) but ` +
          `not listed on the Sheet.`,
      });
    }
  }

  // ── Totals + B2 grand-total ────────────────────────────────────────────────
  const sheetSumKg = sumBalances([...sheetMap.values()].map((b) => b.balance_kg));
  const computedSumKg = sumBalances([...compMap.values()].map((b) => b.balance_kg));
  const delta = sheetSumKg - computedSumKg;

  const totals: BlockTotals = {
    sheetSumKg: round1(sheetSumKg),
    computedSumKg: round1(computedSumKg),
    sheetStatedTotalKg: statedTotal,
    delta: round1(delta),
    sheetBlocks: sheetMap.size,
    computedBlocks: compMap.size,
    comparedBlocks,
    negativeComputedBlocks,
  };

  if (Math.abs(delta) > grandTol) {
    // The Sheet's stated total is (by construction) the sum of its own grid, so it is an
    // extraction-completeness anchor: if OUR Sheet sum ≠ the stated total, we missed cells.
    const statedNote =
      statedTotal !== null && Math.abs(sheetSumKg - statedTotal) > grandTol
        ? ` (note: our Sheet sum ${fmt(round1(sheetSumKg))} kg differs from the Sheet's stated ` +
          `total ${fmt(statedTotal)} kg — extraction may be incomplete)`
        : "";
    diffs.push({
      kind: "grand_total",
      block_loc: null,
      sheet_kg: round1(sheetSumKg),
      computed_kg: round1(computedSumKg),
      delta: round1(delta),
      detail:
        `Total inventory disagrees: Sheet ${fmt(round1(sheetSumKg))} kg vs app ` +
        `${fmt(round1(computedSumKg))} kg (Δ ${fmt(round1(delta))} kg)${statedNote}.`,
    });
  }

  return { blockDiffs: diffs, totals };
}

/** Sum only the numeric balances (nulls skipped). */
function sumBalances(vals: Array<number | null>): number {
  let sum = 0;
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) sum += v;
  return sum;
}

/** Thousands-separated integer-ish kg for the human detail strings. */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
