/**
 * deductions.ts — TS port of `.claude/skills/sync-ictc/scripts/lib/deductions.py`
 * (read the Python as spec). The weight-deduction grammar (L-021) + the wet-recovery
 * sub-row core, both sheet-agnostic. deliveries is the primary consumer (see
 * specs/deliveries.md §2 and SHARED.md general; DEDUCTIONS_DESIGN.md is the design).
 *
 * Contract (unchanged from Python):
 *   - true_weight_kg = the GROSS stated after "net kilos (of)" — the physical weight
 *     BEFORE both ASH and wet deductions, PARSED directly, NEVER recomputed from %.
 *     NULL when there is no confidently-parsed deduction; NEVER 0.
 *   - deduction_note = a short hover label ("−1.60% MC; −2.88% ASH").
 *   - weight_kg STAYS the deducted NET — never overwritten here.
 *   - Both fields are ADDITIVE / write-only: not in any natural key, never diffed.
 *
 * PARITY NOTES:
 *   - Every regex that Python flags re.IGNORECASE gets the JS `i` flag; PCT_FRAG_RE
 *     has no IGNORECASE in Python (case-agnostic by construction) so no `i` here.
 *   - Fragment de-dup preserves FIRST-SEEN order (SHARED.md porting trap #4) — we use
 *     an order-preserving array + Set, never a re-sort.
 *   - Python `%g` formatting of the mismatch-warning numbers is reproduced by pyG().
 *     Those warnings are additive to a row's `warnings` list (which the classifier
 *     does NOT diff), so they never affect classify parity — but we keep them faithful.
 *   - confidence rounding goes through roundHalfToEven (norm.ts HARD RULE: no ad-hoc
 *     Math.round) to mirror Python's round(confidence, 3).
 */
import { roundHalfToEven } from "../../lib/norm.js";

export const MINUS_SIGN = "−"; // U+2212, the design's deduction_note minus.

// "net kilos of <GROSS>" signal. The "of" is optional; spacing is loose. re.IGNORECASE.
const NET_KILOS_GROSS_RE = /net\s+kilos\s+(?:of\s+)?([\d,]+(?:\.\d+)?)/i;
// NET = number immediately after the LAST "=" in the remark. (`$` anchored, no i.)
const NET_AFTER_EQUALS_RE = /=\s*([\d,]+(?:\.\d+)?)\s*$/;
// Percentage-style fragment: "<PCT>%(<TYPE>)" / "<PCT>% <TYPE>" / bare "<PCT>%TYPE".
// Python PCT_FRAG_RE has NO re.IGNORECASE.
const PCT_FRAG_RE = /(\d*\.?\d+)\s*%\s*\(?\s*([A-Za-z]+)?/g;
// Absolute-kilos fragment: "<N> KILOS" / "<N> KGS". re.IGNORECASE.
const ABS_KILOS_RE = /(\d[\d,]*)\s*(?:KILOS|KGS?)\b/gi;
// Absolute "(TYPE)" fragment: "<N>(<TYPE>)" / "<N> (<TYPE>)". (no i in Python.)
const ABS_PAREN_TYPE_RE = /(\d[\d,]*)\s*\(\s*([A-Za-z]+)/g;
// WET-sacks mention. re.IGNORECASE.
const WET_SACKS_RE = /WET\s+SACKS?/i;
// The just-past-abs-kilos type hint scan (re.search(r"\(?\s*([A-Za-z]+)", rest)).
const ABS_TYPE_HINT_RE = /\(?\s*([A-Za-z]+)/;

function stripCommasToFloat(s: string): number | null {
  const cleaned = s.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const f = Number(cleaned);
  return Number.isFinite(f) ? f : null;
}

/** Map an operator deduction-type token to a canonical label (ASH/MC/wet). */
function normalizeDeductionType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toUpperCase();
  if (t === "ASH" || t === "ASAH" || t === "ASHH" || t === "ASE") return "ASH";
  if (t === "MC" || t === "MOISTURE") return "MC";
  if (t.startsWith("WET")) return "wet";
  return null;
}

/**
 * Python's `f"{x:g}"` for the mismatch warning. Uses %g formatting (up to 6
 * significant digits, trailing zeros dropped, exponent for very large/small).
 * These strings only feed a `warnings` list that the classifier never diffs, so
 * exact fidelity is belt-and-suspenders — but faithful.
 */
function pyG(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return "0";
  let s = x.toPrecision(6);
  // Drop trailing zeros in the significand (both fixed and exponential forms).
  if (s.indexOf("e") >= 0 || s.indexOf("E") >= 0) {
    const [mant, exp] = s.split(/[eE]/);
    let m = mant;
    if (m.indexOf(".") >= 0) m = m.replace(/0+$/, "").replace(/\.$/, "");
    const e = Number(exp);
    return `${m}e${e >= 0 ? "+" : "-"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

export interface DeductionResult {
  trueWeightKg: number | null;
  deductionNote: string | null;
  warnings: string[];
}

/**
 * Detect a weight deduction annotated in `remarks`. Port of `detect_deduction`.
 * Returns { trueWeightKg, deductionNote, warnings } (Python's 3-tuple).
 */
export function detectDeduction(
  remarks: string | null | undefined,
  weightKg: number | null | undefined,
): DeductionResult {
  const warnings: string[] = [];
  if (!remarks) return { trueWeightKg: null, deductionNote: null, warnings: [] };

  const text = remarks.trim();
  const grossM = NET_KILOS_GROSS_RE.exec(text);
  if (!grossM) {
    // No deduction signal at all — ordinary load.
    return { trueWeightKg: null, deductionNote: null, warnings: [] };
  }

  const gross = stripCommasToFloat(grossM[1]);

  // Consistency check: the number after the LAST "=" should equal weight_kg.
  const netM = NET_AFTER_EQUALS_RE.exec(text);
  const statedNet = netM ? stripCommasToFloat(netM[1]) : null;
  if (
    statedNet !== null &&
    weightKg !== null &&
    weightKg !== undefined &&
    Math.abs(statedNet - weightKg) > 1
  ) {
    warnings.push(`remark net ${pyG(statedNet)} != weight_kg ${pyG(weightKg)}`);
  }

  // Build the deduction_note from fragments on the deduction SIDE (right of the
  // first "-" after the gross), so the gross/net figures aren't read as fragments.
  // grossM.index + grossM[0].length == Python's gross_m.end().
  const grossEnd = grossM.index + grossM[0].length;
  const note = buildDeductionNote(text, grossEnd);

  if (gross === null) {
    warnings.push(
      "deduction present but gross weight could not be parsed from 'net kilos'",
    );
    return { trueWeightKg: null, deductionNote: note, warnings };
  }
  if (weightKg !== null && weightKg !== undefined && gross <= weightKg) {
    warnings.push(
      `parsed gross ${pyG(gross)} <= weight_kg ${pyG(weightKg)}; not tagging ` +
        `(gross must exceed net)`,
    );
    return { trueWeightKg: null, deductionNote: note, warnings };
  }

  return { trueWeightKg: gross, deductionNote: note, warnings };
}

/** Port of `_build_deduction_note`. */
function buildDeductionNote(text: string, grossEnd: number): string {
  // The deduction side begins at the first "-" after the gross; else scan from grossEnd.
  const tail = text.slice(grossEnd);
  const dashIdx = tail.indexOf("-");
  let dedSide = dashIdx !== -1 ? tail.slice(dashIdx) : tail;
  // Drop everything from the final "=" onward (that's the NET, not a fragment).
  const eqIdx = dedSide.lastIndexOf("=");
  if (eqIdx !== -1) dedSide = dedSide.slice(0, eqIdx);

  const fragments: string[] = [];

  // Percentage fragments, e.g. ".67%(MC)", "2.88%(ASH)", "1.88%(ASAH)".
  {
    const re = new RegExp(PCT_FRAG_RE.source, PCT_FRAG_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(dedSide)) !== null) {
      const pct = m[1];
      const typ = normalizeDeductionType(m[2]);
      let frag = `${MINUS_SIGN}${pct}%`;
      if (typ && typ !== "wet") frag += ` ${typ}`;
      else if (typ === "wet") frag += " wet";
      fragments.push(frag);
      if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width matches
    }
  }

  // Absolute-kilos fragments, e.g. "496 KILOS of (MC ...)", "7,044 (ash)".
  let consumedAbs = false;
  {
    const re = new RegExp(ABS_KILOS_RE.source, ABS_KILOS_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(dedSide)) !== null) {
      const n = m[1];
      const matchEnd = m.index + m[0].length;
      const rest = dedSide.slice(matchEnd, matchEnd + 24);
      const tmatch = ABS_TYPE_HINT_RE.exec(rest);
      const typ = tmatch ? normalizeDeductionType(tmatch[1]) : null;
      let frag = `${MINUS_SIGN}${n} kg`;
      if (typ && typ !== "wet") frag += ` ${typ}`;
      fragments.push(frag);
      consumedAbs = true;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  if (!consumedAbs) {
    const re = new RegExp(ABS_PAREN_TYPE_RE.source, ABS_PAREN_TYPE_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(dedSide)) !== null) {
      const n = m[1];
      const typ = normalizeDeductionType(m[2]);
      let frag = `${MINUS_SIGN}${n} kg`;
      if (typ && typ !== "wet") frag += ` ${typ}`;
      fragments.push(frag);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // Standalone WET-sacks mention (only if not already captured as a type).
  if (WET_SACKS_RE.test(text) && !fragments.some((f) => f.includes("wet"))) {
    fragments.push("wet sacks");
  }

  if (fragments.length) {
    // Dedup while preserving FIRST-SEEN order (loose regexes can double-hit).
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const f of fragments) {
      if (!seen.has(f)) {
        seen.add(f);
        deduped.push(f);
      }
    }
    return deduped.join("; ");
  }

  // Fallback: a trimmed copy of the remark (kept short for a hover label).
  const fallback = text.split(/\s+/).join(" ");
  return fallback.slice(0, 80);
}

// ---------------------------------------------------------------------------
// Wet "recovery" sub-rows — sheet-agnostic core (Python lib/deductions.py §8).
// The deliveries extractor carries the resolved code under `batch_code`.
// ---------------------------------------------------------------------------
type RowDict = Record<string, unknown>;

/** Return the row's batch code under EITHER shape (email `batch_code` or gsheet). */
function rowBatchCode(row: RowDict | null | undefined): unknown {
  if (!row) return null;
  return row.batch_code ?? row.batch_code_primary ?? null;
}

/**
 * Sheet-agnostic recovery predicate — port of `is_recovery_row_dict`. True iff the
 * already-extracted row looks like a wet-recovery sub-row: has a usable weight but is
 * MISSING its own truck_plate AND batch code AND block_loc, and did NOT have its OWN
 * date cell (has_own_date false — the date was forward-filled).
 */
export function isRecoveryRowDict(row: RowDict | null | undefined, hasOwnDate: boolean): boolean {
  if (!row) return false;
  if (row.weight_kg === null || row.weight_kg === undefined) return false;
  if (row.truck_plate !== null && row.truck_plate !== undefined) return false;
  const bc = rowBatchCode(row);
  if (bc !== null && bc !== undefined) return false;
  if (row.block_loc !== null && row.block_loc !== undefined) return false;
  if (hasOwnDate) return false;
  return true;
}

/** A row a recovery can inherit identity from — must itself carry a real batch code. */
export function isInheritableMother(row: RowDict | null | undefined): boolean {
  const bc = rowBatchCode(row);
  return bc !== null && bc !== undefined;
}

/**
 * Port of `build_recovery_row`. Turns a recovery candidate into a standalone delivery
 * row inheriting the mother's identity, keeping the candidate's own weight/sacks/
 * lab_results/remarks and re-deriving true_weight_kg/deduction_note from the
 * candidate's own remark. deliveries rows carry `batch_code` (+ operator_batch_label).
 */
export function buildRecoveryRow(candidate: RowDict, mother: RowDict): RowDict {
  const ded = detectDeduction(
    candidate.remarks as string | null | undefined,
    candidate.weight_kg as number | null | undefined,
  );

  let warnings = [...((candidate.warnings as string[] | undefined) ?? [])];
  // Drop the now-irrelevant "missing supplier / no batch label" noise.
  warnings = warnings.filter(
    (w) =>
      !w.includes("missing supplier") &&
      !w.includes("No operator batch label") &&
      !w.includes("Could not map operator batch label"),
  );
  const src = candidate._source_row;
  warnings.push(
    `Row ${src}: wet-recovery sub-row — inherited truck/block/supplier/batch ` +
      `from mother row ${mother._source_row}`,
  );
  for (const w of ded.warnings) warnings.push(`Row ${src}: ${w}`);

  const confidence = Math.max(0.0, 1.0 - 0.1 * warnings.length);

  const row: RowDict = {
    transaction_date: mother.transaction_date,
    supplier: mother.supplier,
    block_loc: mother.block_loc,
    truck_plate: mother.truck_plate,
    sacks: candidate.sacks,
    weight_kg: candidate.weight_kg,
    cost_basis: mother.cost_basis,
    remarks: candidate.remarks,
    lab_results: candidate.lab_results,
    true_weight_kg: ded.trueWeightKg,
    deduction_note: ded.deductionNote,
    warnings,
    confidence: round3(confidence),
    _source_row: src,
    _recovery: true,
    _mother_source_row: mother._source_row,
  };

  // Inherit the batch code under whichever shape(s) the mother carries.
  if ("batch_code" in mother) row.batch_code = mother.batch_code;
  if ("batch_code_primary" in mother) {
    row.batch_code_primary = mother.batch_code_primary;
    row.batch_code_fallbacks = [...((mother.batch_code_fallbacks as unknown[] | undefined) ?? [])];
  }
  if (mother.operator_batch_label !== null && mother.operator_batch_label !== undefined) {
    row.operator_batch_label = mother.operator_batch_label;
  }
  if (mother._source_tab !== null && mother._source_tab !== undefined) {
    row._source_tab = mother._source_tab;
  }

  return row;
}

/** Python round(x, 3) — banker's rounding via the canonical norm.ts primitive. */
function round3(x: number): number {
  return roundHalfToEven(x, 3);
}
