/**
 * deviations.ts — the EXPECTED-DEVIATION matcher.
 *
 * PORTING_DECISIONS.md rulings #2–#5 make the TS port intentionally differ from
 * the Python oracle (each fixes a live crash/DB-constraint bug the oracle still
 * carries). Every such difference must be pre-registered here, keyed by
 * (rule id + case + path). A canonical diff that MATCHES a registered entry is a
 * PASS-with-note. Any diff NOT covered is a porter bug -> FAIL. This keeps
 * parity a HARD gate everywhere except the handful of documented, ruled-on spots.
 *
 * Matching semantics:
 *  - `type` (report type) and `case` must match the running case.
 *  - `path` is a MINIMATCH-ish glob over the diff path: a "*" matches one path
 *    segment (no "/"), "**" matches any suffix. Exact strings match exactly.
 *  - Optionally `kind` constrains the diff kind (value/missing_in_ts/...).
 *  - Optionally `oracle`/`ts` pin the exact expected values (canonicalized form,
 *    i.e. tagged number strings) — use when the deviation is a specific value
 *    flip and you want to fail if the port diverges in some OTHER way at the
 *    same path.
 *
 * An entry that matches ZERO diffs across the whole run is reported as STALE
 * (so a fixed port doesn't silently keep a now-unnecessary carve-out).
 */

import type { Diff } from "./differ.js";
import { canonicalizeNumber } from "./canonical.js";

export interface ExpectedDeviation {
  rule: string; // e.g. "PD-3" (PORTING_DECISIONS ruling #3) or a ledger id
  type: string; // report type
  case: string; // fixture case id
  path: string; // glob over the diff path
  kind?: Diff["kind"];
  oracle?: unknown; // optional exact-value pin (raw; auto-canonicalized if number)
  ts?: unknown;
  note: string; // human explanation shown in the summary
}

/** Compile a glob ("*"=one segment, "**"=any suffix) into a RegExp. */
function globToRe(glob: string): RegExp {
  // Escape regex specials except our wildcards.
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else {
      re += glob[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

function pin(v: unknown): unknown {
  return typeof v === "number" ? canonicalizeNumber(v) : v;
}

export interface DeviationMatchResult {
  /** diffs that matched a registered deviation (PASS-with-note). */
  matched: Array<{ diff: Diff; dev: ExpectedDeviation }>;
  /** diffs that matched nothing -> genuine FAILs. */
  unmatched: Diff[];
}

/**
 * Partition a case's diffs into expected-deviation matches and genuine fails.
 * `used` accumulates which deviation entries fired at least once (for staleness
 * reporting across the whole run — pass the SAME Set across all cases).
 */
export function matchDeviations(
  type: string,
  caseId: string,
  diffs: Diff[],
  registry: ExpectedDeviation[],
  used: Set<ExpectedDeviation>,
): DeviationMatchResult {
  const applicable = registry.filter((d) => d.type === type && d.case === caseId);
  const compiled = applicable.map((d) => ({ dev: d, re: globToRe(d.path) }));

  const matched: DeviationMatchResult["matched"] = [];
  const unmatched: Diff[] = [];

  for (const df of diffs) {
    let hit: ExpectedDeviation | undefined;
    for (const c of compiled) {
      if (!c.re.test(df.path)) continue;
      if (c.dev.kind && c.dev.kind !== df.kind) continue;
      if ("oracle" in c.dev && pin(c.dev.oracle) !== df.oracle) continue;
      if ("ts" in c.dev && pin(c.dev.ts) !== df.ts) continue;
      hit = c.dev;
      break;
    }
    if (hit) {
      matched.push({ diff: df, dev: hit });
      used.add(hit);
    } else {
      unmatched.push(df);
    }
  }
  return { matched, unmatched };
}

/** Deviations registered but never fired across the whole run. */
export function staleDeviations(
  registry: ExpectedDeviation[],
  used: Set<ExpectedDeviation>,
): ExpectedDeviation[] {
  return registry.filter((d) => !used.has(d));
}
