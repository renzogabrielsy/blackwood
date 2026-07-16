/**
 * blockAliases.ts — validated PATIO BLOCK-NAME alias table for the rc_out reconciler.
 *
 * Seeded 2026-07-13 (Renzo's directive). The PROPOSED DAILY REPORT names sun-drying
 * patio spots DESCRIPTIVELY ("16A NEAR WALL", "15A MIDDLE SIDE"); the Google Sheet names
 * the SAME physical blocks with CODED refs ("PCA-16A", "PCA-15C" — the Sheet's PCA/PCB
 * mini-grid, see ./CONTEXT.md's RB section, cols 31..33 of the Blocking tab). Same
 * feeding, two names — so without this table the reconciler (./rcOut.ts, ./rcOutStage.ts)
 * false-flags them as `attribution_diff` cases (the second-pass matcher pairs them by
 * weight but still surfaces a case) or, worse, as two independent
 * `single_source_overdue` facts (one per name, each aging out on its own). The Sheet's
 * coded block is AUTHORITATIVE for these patio blocks — it is the operator's canonical
 * reference and exactly what `bucketGsheetRcOut` already emits verbatim (gsheet never
 * needs aliasing, only proposed does).
 *
 * Provenance: 7 of the 8 rows were derived by matching proposed↔gsheet pairs that agreed
 * on date + weight but disagreed on block name (the shape `matchAttributions` already
 * surfaces as `attribution_diff`), then confirming the coded side against the Sheet's
 * PCA/PCB grid. Row 1 ("16A NEAR WALL" -> "PCA-16A") is additionally Renzo-confirmed
 * directly (2026-07-13). To extend this table: add a validated row here — NEVER derive
 * one algorithmically (e.g. fuzzy-matching block names) inside the reconciler itself.
 *
 * RECONCILER-ONLY, READ-ONLY. This module is consumed ONLY by ./rcOutStage.ts
 * (`bucketProposed`) to align the PROPOSED side's fine-reconciliation key. It is NEVER
 * imported by classify.ts, the apply/write path, or anything that writes to `rc_out` /
 * `batches` — a wrong or missing row here can only change which CASES surface in Sync
 * Review, never the data already stored (which already holds the Sheet's correct block
 * string; this table only teaches the reconciler that two spellings mean one place).
 * Pure, dependency-free (no DB/Node imports) — safe to unit test in isolation and safe
 * for a client-safe module to import if ever needed.
 */

/** Normalize a block name for lookup: trim, uppercase, collapse internal whitespace to a
 *  single space. Two descriptive strings that differ only in casing or double-spacing
 *  (operator typing variance) must resolve to the same alias. */
function normalizeKey(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * proposed's descriptive block_loc (normalized via `normalizeKey`) -> the Sheet's
 * authoritative coded block. Keys are pre-normalized so lookup is a plain object hit.
 */
export const PROPOSED_PATIO_BLOCK_ALIASES: Record<string, string> = {
  [normalizeKey("16A NEAR WALL")]: "PCA-16A", // Renzo-confirmed, 2026-07-13
  [normalizeKey("16A HALF OF MIDDLE")]: "PCA-16B",
  [normalizeKey("16A NEAR PATHWAY")]: "PCA-16C",
  [normalizeKey("15A NEAR WALL")]: "PCA-15A",
  [normalizeKey("15A HALF OF MIDDLE")]: "PCA-15B",
  [normalizeKey("15A MIDDLE SIDE")]: "PCA-15C",
  [normalizeKey("16B ANEAR PATHWAY")]: "PCB-16A",
  [normalizeKey("17A MIDDLE SIDE AND 17ANEAR PATHWAY")]: "PCA-17B",
};

/**
 * Resolve a PROPOSED-side block_loc for reconciliation. Returns the Sheet's coded block
 * when the (case/whitespace-insensitive) normalized input is a known patio alias;
 * otherwise returns the ORIGINAL input trimmed, UNCHANGED — this function never invents
 * an alias for an unrecognized name. `null`/blank input -> `null` (mirrors how an absent
 * block_loc is already treated as FEED elsewhere in the reconciler — see
 * `rcOutStage.ts::fineBucketKey`'s FEED_SENTINEL).
 */
export function normalizeProposedBlock(block: string | null | undefined): string | null {
  if (block === null || block === undefined) return null;
  const trimmed = block.trim();
  if (trimmed.length === 0) return null;
  const alias = PROPOSED_PATIO_BLOCK_ALIASES[normalizeKey(trimmed)];
  return alias ?? trimmed;
}

/**
 * True iff `block` (the RAW value as the proposed source stated it, before
 * normalization) matches a known patio alias. Used only for run-summary telemetry —
 * counting how many proposed rows were auto-aligned to a coded block this run.
 */
export function isKnownPatioAlias(block: string | null | undefined): boolean {
  if (block === null || block === undefined) return false;
  const trimmed = block.trim();
  if (trimmed.length === 0) return false;
  return normalizeKey(trimmed) in PROPOSED_PATIO_BLOCK_ALIASES;
}
