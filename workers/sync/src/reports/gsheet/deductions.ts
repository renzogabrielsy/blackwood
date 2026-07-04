/**
 * deductions.ts — LOCAL port of `.claude/skills/sync-ictc/scripts/lib/deductions.py`
 * (read as spec). Scope-fenced copy: this porter may only create files under
 * src/reports/gsheet/**, so the shared Python `lib/deductions.py` is ported here
 * rather than into src/lib/. If a second RC IN pipeline (deliveries) is ported
 * later it may promote this to a shared module; for now it lives beside the gsheet
 * extractor that is its only TS consumer.
 *
 * Contract (DEDUCTIONS_DESIGN.md / L-021), byte-for-byte with the Python:
 *   - true_weight_kg = the GROSS parsed from a "net kilos of <GROSS> … = <NET>"
 *     remark (physical weight BEFORE ASH+wet deductions). NEVER recomputed from %,
 *     NEVER 0, null when absent/untrustworthy.
 *   - deduction_note = a short hover label ("−.67% MC", "−1.60% MC; −2.88% ASH").
 *   - weight_kg stays the deducted NET (never touched here).
 *   - Both fields are additive / write-only: never part of a natural key, never diffed.
 *
 * Regex + control-flow faithfully mirror the Python. The one non-obvious primitive
 * is Python's `%g` formatting used in the net-mismatch warning — ported as `pyG`.
 */
import { roundHalfToEven } from "../../lib/norm.js";

// ---------------------------------------------------------------------------
// Python `%g` formatting (used ONLY by the net-mismatch warning string).
// Mirrors CPython's `"%g" % x` / f"{x:g}": 6 significant digits, strips trailing
// zeros, switches to exponent form when the exponent < -4 or >= precision(6).
// ---------------------------------------------------------------------------
export function pyG(x: number): string {
  if (!Number.isFinite(x)) {
    // Python: inf -> "inf", -inf -> "-inf", nan -> "nan"
    if (Number.isNaN(x)) return "nan";
    return x > 0 ? "inf" : "-inf";
  }
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";

  const neg = x < 0;
  const ax = Math.abs(x);
  const exp = Math.floor(Math.log10(ax));
  const P = 6; // default precision for %g

  let out: string;
  if (exp < -4 || exp >= P) {
    // Exponent form: %e with (P-1) digits after the point, then strip trailing zeros.
    let mant = (ax / Math.pow(10, exp)).toFixed(P - 1);
    // Guard against rounding pushing the mantissa to 10.xxx (e.g. 9.999995 -> 10.0).
    let e = exp;
    if (parseFloat(mant) >= 10) {
      e += 1;
      mant = (ax / Math.pow(10, e)).toFixed(P - 1);
    }
    mant = stripTrailingZeros(mant);
    const esign = e < 0 ? "-" : "+";
    const eabs = String(Math.abs(e)).padStart(2, "0");
    out = `${mant}e${esign}${eabs}`;
  } else {
    // Fixed form: (P-1-exp) digits after the point, then strip trailing zeros.
    const decimals = Math.max(0, P - 1 - exp);
    let s = ax.toFixed(decimals);
    // toFixed can round up across a power of ten (e.g. 9.999996 @ dec -> "10");
    // %g would then re-evaluate but the stripped form is still correct here.
    out = stripTrailingZeros(s);
  }
  return neg ? "-" + out : out;
}

function stripTrailingZeros(s: string): string {
  if (s.indexOf(".") === -1) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

// ---------------------------------------------------------------------------
// Weight-deduction grammar (deductions.py:51-76)
// ---------------------------------------------------------------------------
const MINUS_SIGN = "−"; // U+2212 — the design's deduction_note minus

const NET_KILOS_GROSS_RE = /net\s+kilos\s+(?:of\s+)?([\d,]+(?:\.\d+)?)/i;
const NET_AFTER_EQUALS_RE = /=\s*([\d,]+(?:\.\d+)?)\s*$/;
const PCT_FRAG_RE = /(\d*\.?\d+)\s*%\s*\(?\s*([A-Za-z]+)?/g;
const ABS_KILOS_RE = /(\d[\d,]*)\s*(?:KILOS|KGS?)\b/gi;
const ABS_PAREN_TYPE_RE = /(\d[\d,]*)\s*\(\s*([A-Za-z]+)/g;
const WET_SACKS_RE = /WET\s+SACKS?/i;

function stripCommasToFloat(s: string): number | null {
  const cleaned = s.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const f = Number(cleaned);
  return Number.isFinite(f) ? f : null;
}

function normalizeDeductionType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toUpperCase();
  if (t === "ASH" || t === "ASAH" || t === "ASHH" || t === "ASE") return "ASH";
  if (t === "MC" || t === "MOISTURE") return "MC";
  if (t.startsWith("WET")) return "wet";
  return null;
}

export interface DeductionResult {
  trueWeightKg: number | null;
  deductionNote: string | null;
  warnings: string[];
}

/**
 * Port of deductions.py::detect_deduction. Returns (true_weight_kg, deduction_note,
 * warnings). No "net kilos" signal → (null, null, []).
 */
export function detectDeduction(
  remarks: string | null | undefined,
  weightKg: number | null | undefined,
): DeductionResult {
  const warnings: string[] = [];
  if (!remarks) return { trueWeightKg: null, deductionNote: null, warnings: [] };

  const text = remarks.trim();
  const grossM = NET_KILOS_GROSS_RE.exec(text);
  if (!grossM) return { trueWeightKg: null, deductionNote: null, warnings: [] };

  const gross = stripCommasToFloat(grossM[1]);

  // Consistency check: number after the LAST "=" should equal weight_kg.
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

  // deduction_note from the deduction side (right of the first "-" after gross).
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

/** Port of deductions.py::_build_deduction_note. */
function buildDeductionNote(text: string, grossEnd: number): string {
  const tail = text.slice(grossEnd);
  const dashIdx = tail.indexOf("-");
  let dedSide = dashIdx !== -1 ? tail.slice(dashIdx) : tail;
  const eqIdx = dedSide.lastIndexOf("=");
  if (eqIdx !== -1) dedSide = dedSide.slice(0, eqIdx);

  const fragments: string[] = [];

  // Percentage fragments.
  for (const m of matchAll(PCT_FRAG_RE, dedSide)) {
    const pct = m[1];
    const typ = normalizeDeductionType(m[2]);
    let frag = `${MINUS_SIGN}${pct}%`;
    if (typ && typ !== "wet") frag += ` ${typ}`;
    else if (typ === "wet") frag += " wet";
    fragments.push(frag);
  }

  // Absolute-kilos fragments.
  let consumedAbs = false;
  for (const m of matchAll(ABS_KILOS_RE, dedSide)) {
    const n = m[1];
    const end = (m.index ?? 0) + m[0].length;
    const rest = dedSide.slice(end, end + 24);
    const tmatch = /\(?\s*([A-Za-z]+)/.exec(rest);
    const typ = tmatch ? normalizeDeductionType(tmatch[1]) : null;
    let frag = `${MINUS_SIGN}${n} kg`;
    if (typ && typ !== "wet") frag += ` ${typ}`;
    fragments.push(frag);
    consumedAbs = true;
  }
  if (!consumedAbs) {
    for (const m of matchAll(ABS_PAREN_TYPE_RE, dedSide)) {
      const n = m[1];
      const typ = normalizeDeductionType(m[2]);
      let frag = `${MINUS_SIGN}${n} kg`;
      if (typ && typ !== "wet") frag += ` ${typ}`;
      fragments.push(frag);
    }
  }

  // Standalone WET-sacks mention.
  if (WET_SACKS_RE.test(text) && !fragments.some((f) => f.includes("wet"))) {
    fragments.push("wet sacks");
  }

  if (fragments.length) {
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

  // Fallback: trimmed copy of the remark, first 80 chars.
  const fallback = text.split(/\s+/).join(" ");
  return fallback.slice(0, 80);
}

/** Iterate a /g regex like Python's re.finditer (each match carries .index). */
function matchAll(re: RegExp, s: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width infinite loop
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wet-recovery sub-row core (deductions.py:244-357)
// ---------------------------------------------------------------------------
export type RowDict = Record<string, unknown>;

function rowBatchCode(row: RowDict | null | undefined): unknown {
  if (!row) return null;
  return row.batch_code ?? row.batch_code_primary ?? null;
}

/** Port of is_recovery_row_dict. */
export function isRecoveryRowDict(
  row: RowDict | null | undefined,
  hasOwnDate: boolean,
): boolean {
  if (!row) return false;
  if (row.weight_kg === null || row.weight_kg === undefined) return false;
  if (row.truck_plate !== null && row.truck_plate !== undefined) return false;
  const bc = rowBatchCode(row);
  if (bc !== null && bc !== undefined) return false;
  if (row.block_loc !== null && row.block_loc !== undefined) return false;
  if (hasOwnDate) return false;
  return true;
}

/** Port of _is_inheritable_mother. */
export function isInheritableMother(row: RowDict | null | undefined): boolean {
  const bc = rowBatchCode(row);
  return bc !== null && bc !== undefined;
}

/** Port of build_recovery_row (gsheet row shape). Mirrors the Python field-by-field. */
export function buildRecoveryRow(candidate: RowDict, mother: RowDict): RowDict {
  const ded = detectDeduction(
    candidate.remarks as string | null,
    candidate.weight_kg as number | null,
  );

  let warnings = Array.isArray(candidate.warnings)
    ? [...(candidate.warnings as string[])]
    : [];
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

  const confidence = round3(Math.max(0.0, 1.0 - 0.1 * warnings.length));

  const row: RowDict = {
    transaction_date: mother.transaction_date ?? null,
    supplier: mother.supplier ?? null,
    block_loc: mother.block_loc ?? null,
    truck_plate: mother.truck_plate ?? null,
    sacks: candidate.sacks ?? null,
    weight_kg: candidate.weight_kg ?? null,
    cost_basis: mother.cost_basis ?? null,
    remarks: candidate.remarks ?? null,
    lab_results: candidate.lab_results ?? null,
    true_weight_kg: ded.trueWeightKg,
    deduction_note: ded.deductionNote,
    warnings,
    confidence,
    _source_row: src,
    _recovery: true,
    _mother_source_row: mother._source_row ?? null,
  };

  if ("batch_code" in mother) row.batch_code = mother.batch_code ?? null;
  if ("batch_code_primary" in mother) {
    row.batch_code_primary = mother.batch_code_primary ?? null;
    row.batch_code_fallbacks = Array.isArray(mother.batch_code_fallbacks)
      ? [...(mother.batch_code_fallbacks as unknown[])]
      : [];
  }
  if (
    mother.operator_batch_label !== null &&
    mother.operator_batch_label !== undefined
  ) {
    row.operator_batch_label = mother.operator_batch_label;
  }
  if (mother._source_tab !== null && mother._source_tab !== undefined) {
    row._source_tab = mother._source_tab;
  }

  return row;
}

function round3(v: number): number {
  // Python round(x, 3) is banker's rounding — route through lib/norm (Math.round
  // is banned by the norm.ts HARD RULE).
  return roundHalfToEven(v, 3);
}
