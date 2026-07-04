/**
 * differ.ts — deep diff between two ALREADY-CANONICALIZED values (the output of
 * `canonicalize()` from canonical.ts). Produces a flat list of typed
 * differences, each with a JSON-pointer-ish `path`, the `oracle` value, and the
 * `ts` value. The path segments are joined by "/" and array indices are the
 * POST-SORT positions (canonicalization sorts row arrays, so index i on both
 * sides refers to the same natural-key row).
 *
 * A `Diff` is intentionally structural (not stringified) so the expected-
 * deviation matcher can match on `path` + values, and the reporter can colorize.
 */

export type DiffKind = "missing_in_ts" | "missing_in_oracle" | "value" | "type";

export interface Diff {
  path: string; // e.g. "/counts/insert" or "/rows_preview/3/batch_code"
  kind: DiffKind;
  oracle: unknown;
  ts: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Compare two canonicalized values. `oracle` is the golden Python output;
 * `ts` is the port output. Returns [] when byte-identical in structure+value.
 */
export function diff(oracle: unknown, ts: unknown, path = ""): Diff[] {
  // exact primitive / tagged-number-string equality
  if (oracle === ts) return [];

  const oArr = Array.isArray(oracle);
  const tArr = Array.isArray(ts);
  const oObj = isObj(oracle);
  const tObj = isObj(ts);

  // type mismatch (array vs object vs scalar)
  if (oArr !== tArr || oObj !== tObj) {
    return [{ path: path || "/", kind: "type", oracle, ts }];
  }

  if (oArr && tArr) {
    const out: Diff[] = [];
    const n = Math.max(oracle.length, ts.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}/${i}`;
      if (i >= ts.length) {
        out.push({ path: p, kind: "missing_in_ts", oracle: oracle[i], ts: undefined });
      } else if (i >= oracle.length) {
        out.push({ path: p, kind: "missing_in_oracle", oracle: undefined, ts: ts[i] });
      } else {
        out.push(...diff(oracle[i], ts[i], p));
      }
    }
    return out;
  }

  if (oObj && tObj) {
    const out: Diff[] = [];
    const keys = new Set([...Object.keys(oracle), ...Object.keys(ts)]);
    for (const k of [...keys].sort()) {
      const p = `${path}/${k}`;
      const inO = k in oracle;
      const inT = k in ts;
      if (inO && !inT) {
        out.push({ path: p, kind: "missing_in_ts", oracle: oracle[k], ts: undefined });
      } else if (!inO && inT) {
        out.push({ path: p, kind: "missing_in_oracle", oracle: undefined, ts: ts[k] });
      } else {
        out.push(...diff(oracle[k], ts[k], p));
      }
    }
    return out;
  }

  // both scalar (or tagged string), not equal
  return [{ path: path || "/", kind: "value", oracle, ts }];
}
