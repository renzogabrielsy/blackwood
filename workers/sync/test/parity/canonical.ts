/**
 * canonical.ts — the ONE canonicalization used on BOTH sides of every parity
 * comparison (the Python oracle output AND the TS port output). If the two
 * engines are semantically equal, canonicalizing both must produce
 * byte-identical JSON. Any surviving byte difference is either a real
 * divergence (FAIL) or an entry in expected-deviations.json (PASS-with-note).
 *
 * The rules (spec'd here so build-oracle.ts can mirror them EXACTLY):
 *
 *  1. OBJECT KEYS are sorted lexicographically (recursively). JSON object key
 *     order is never semantically meaningful in this codebase (SHARED.md porting
 *     trap #4), so sorting removes a spurious source of diff.
 *
 *  2. ARRAYS OF OBJECTS are sorted by a stable NATURAL KEY when one can be
 *     derived, so that "same rows, different emission order" is not a diff.
 *     The key is the canonical JSON of a small, per-domain-agnostic projection:
 *     we try, in order, the first present of a fixed candidate-field list
 *     (natural_key, transaction_date+batch_code+..., date, id, ...). If NO
 *     candidate field is present on the element, we fall back to sorting by the
 *     element's FULL canonical JSON string (total order, deterministic). Arrays
 *     of scalars are left in place (order IS meaningful for a scalar list, and
 *     none of these envelopes rely on scalar-array order anyway).
 *
 *     NOTE: `rows_preview` is hard-truncated to 20 by the Python envelope
 *     BEFORE we see it, and truncation is order-dependent. We therefore sort
 *     preview arrays the same way on both sides AFTER truncation — see the
 *     runner, which never re-truncates; both oracle and TS must emit an
 *     already-truncated, then-sorted preview. (Ports must replicate the
 *     `rows_preview[:20]` truncation; canonicalization sorts what remains.)
 *
 *  3. FLOATS are normalized via a single TEXTUAL rule, identical on both sides:
 *     a number is emitted as its shortest round-trip decimal string, then any
 *     value that is integer-valued (e.g. 12.0) is emitted WITHOUT a trailing
 *     ".0" (Python `json.dumps(12.0)` -> "12.0" but JS `JSON.stringify(12)` ->
 *     "12"; we collapse both to the integer form), and non-integer values are
 *     ROUNDED TO 9 SIGNIFICANT DECIMAL PLACES to erase IEEE-754 last-bit noise
 *     that can differ between Python's repr and V8's. 9 places is well beyond
 *     any real quantity precision in this domain (weights to 3dp, labs to 3dp)
 *     yet tight enough to catch a genuine rounding-rule divergence. All numbers
 *     become STRINGS tagged with a sentinel prefix so they never collide with a
 *     genuine string field (see `FLOAT_TAG`). The oracle builder applies the
 *     identical transform in Python.
 *
 *  4. VOLATILE FIELDS (absolute paths, timestamps, uuids, work-dir names) are
 *     stripped via an EXPLICIT ALLOWLIST of key names, applied at ANY depth.
 *     These are non-deterministic run-to-run and never part of the classify
 *     SEMANTICS. The list is deliberately conservative and documented per field.
 */

/** Sentinel prefix so a canonicalized number can never be confused with a
 *  genuine string value during the deep diff. */
export const FLOAT_TAG = " num:";

/**
 * Key names stripped at any depth. Each is volatile (path/time/uuid/run-scoped)
 * and semantically irrelevant to classification parity.
 */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  // filesystem paths — differ by work_dir/tmp
  "output_path",
  "classified_path",
  "decisions_file",
  "full_classified_file_for_audit_only",
  "path",
  "file",
  "filename",
  "work_dir",
  // run identity / timestamps
  "generated_at",
  "run_ts",
  "run_at",
  "last_run_at",
  "timestamp",
  "created_at",
  // model/agent identity (present in some envelopes' `model` field)
  "model",
  // DB primary keys — a snapshot's row ids are stable, but a NEW row's
  // eventual id is not part of CLASSIFY output; classify never emits real ids,
  // only echoes snapshot ids in matches. We keep snapshot-echoed ids OUT of the
  // comparison because the TS port may echo a matched db row differently
  // (e.g. by index) — matching is asserted via natural key, not id identity.
  "id",
  "db_id",
  "record_id",
  "email_thread_id",
  "thread_id",
  "uid",
  "source_row", // sheet row number — extractor bookkeeping, not classify semantics
]);

/**
 * Candidate natural-key projections, tried in order, to sort arrays of objects
 * stably. Domain-agnostic: we only look at whether the fields are PRESENT.
 */
const NATURAL_KEY_CANDIDATES: ReadonlyArray<ReadonlyArray<string>> = [
  ["natural_key"],
  ["_mode", "natural_key"],
  ["transaction_date", "batch_code", "block_loc", "weight_kg", "truck_plate", "sacks"],
  ["transaction_date", "batch_id", "destination"],
  ["transaction_date", "production_batch", "shift", "customer", "grade"],
  ["reading_date", "meter"],
  ["reading_date", "plate_no"],
  ["transaction_date", "particular", "bag_type_code", "qty_delta"],
  ["date", "gate"],
  ["date"],
  ["transaction_date"],
  ["code"],
  ["gate"],
  ["reason"],
  ["kind"],
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Textual float normalization (rule #3). Returns a tagged string.
 * Integer-valued numbers collapse to their integer text; others round to 9dp
 * and drop trailing zeros. NaN/Infinity are never valid JSON and never appear.
 */
export function canonicalizeNumber(n: number): string {
  if (!Number.isFinite(n)) return FLOAT_TAG + String(n);
  if (Number.isInteger(n)) return FLOAT_TAG + String(n);
  // Round to 9 decimal places to erase last-bit noise, then strip trailing 0s.
  let s = n.toFixed(9);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  // A value that rounded to an integer (e.g. 12.0000000004 -> "12") collapses.
  return FLOAT_TAG + s;
}

/**
 * Recursively canonicalize a parsed-JSON value into a comparable structure:
 *  - numbers -> tagged canonical strings
 *  - objects -> volatile keys dropped, remaining keys sorted
 *  - arrays of objects -> sorted by natural key
 * The output is still a JS value (object/array/string/bool/null) — the differ
 * walks it; `stableStringify` renders it for byte comparison.
 */
export function canonicalize(value: unknown): unknown {
  if (typeof value === "number") return canonicalizeNumber(value);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize);
    // Sort ONLY if every element is an object (row array); leave scalar/mixed
    // arrays in place (their order is either meaningful or already stable).
    if (mapped.length > 1 && mapped.every((e) => isPlainObject(e))) {
      return sortObjectArray(mapped as Record<string, unknown>[]);
    }
    return mapped;
  }

  // plain object: drop volatile keys, canonicalize values, sort keys
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (VOLATILE_KEYS.has(k)) continue;
    out[k] = canonicalize(obj[k]);
  }
  return out;
}

/** Derive a stable sort key string for a canonicalized row object. */
function rowSortKey(row: Record<string, unknown>): string {
  for (const cand of NATURAL_KEY_CANDIDATES) {
    if (cand.every((f) => f in row)) {
      const proj: Record<string, unknown> = {};
      for (const f of cand) proj[f] = row[f];
      return "K:" + stableStringify(proj);
    }
  }
  // Fallback: full canonical JSON of the row (total, deterministic order).
  return "F:" + stableStringify(row);
}

function sortObjectArray(arr: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...arr].sort((a, b) => {
    const ka = rowSortKey(a);
    const kb = rowSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Deterministic stringify of an ALREADY-canonicalized value. Keys are emitted
 * in the object's own (already-sorted) insertion order. This is the byte image
 * compared for parity.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") return canonicalizeNumber(value as number); // defensive
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj)) {
    parts.push(JSON.stringify(k) + ":" + stableStringify(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

/** Canonicalize then stringify — the full pipeline for one envelope. */
export function canonicalJSON(value: unknown): string {
  return stableStringify(canonicalize(value));
}
