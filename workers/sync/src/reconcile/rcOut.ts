/**
 * rcOut.ts — R1 pure reconciliation engine for rc_out.
 *
 * Takes SourceRecords from the rc_out witnesses (proposed + gsheet + movement) and, per
 * (natural key, field), decides Agree / single-source / Disagree. Disagreements become
 * `SourceDiff` descriptors — NEVER auto-resolved. A recommendation may be attached, but it
 * is advisory: the human arbitrates in Sync Review (SYNC_RECONCILIATION_MODEL.md Stage 3).
 *
 * Pure + deterministic. No I/O, no DB, no writes. This is the R1 deliverable; R2 persists
 * the diffs as `source_diff` cases and R3 renders the pick UI.
 *
 * GRANULARITY: fine key = (transaction_date, batch, block_loc, destination), reconciled on
 * the SUMMED weight_kg for that key (robust to sources splitting a batch's daily feeding into
 * different legs — see L-037). The RC MOVEMENT sheet is per-DATE only, so it is consumed as a
 * date-level CORROBORATION witness, never a fine competitor. See ./CONTEXT.md.
 */
import type {
  Agreement,
  ReconcileOptions,
  ReconcileResult,
  RcOutNaturalKey,
  RcOutSource,
  SourceDiff,
  SourceOpinion,
  SourceRecord,
} from "./types.js";

const DEFAULTS = {
  weightTolKg: 1,
  dayRollupTolKg: 1,
  weightField: "weight_kg",
  movementTotalField: "raw_charcoal_fed_kls",
} as const;

/** Canonical string for a fine natural key. Components can't contain the separator. */
function fineKeyStr(k: RcOutNaturalKey): string {
  return [k.transaction_date, k.batch ?? "", k.block_loc ?? "", k.destination ?? "MAIN"].join("\u0001");
}

/** A record is FINE (reconciled) when it names a batch + block and is not the movement witness. */
function isFine(r: SourceRecord): boolean {
  return r.source !== "movement" && r.naturalKey.batch !== null && r.naturalKey.block_loc !== null;
}

/** Numeric equality within tolerance; non-finite → never equal. */
function numWithin(a: number, b: number, tol: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol;
}

/** Compare two field values (numbers within tol; everything else strict). */
function valuesEqual(a: number | string | null, b: number | string | null, tol: number): boolean {
  if (typeof a === "number" && typeof b === "number") return numWithin(a, b, tol);
  return a === b;
}

/** A source "has an opinion" on a field iff the field is present and non-null. */
function opinionValue(r: SourceRecord, field: string): number | string | undefined {
  const v = r.fields[field];
  return v === null || v === undefined ? undefined : v;
}

export function reconcileRcOut(records: SourceRecord[], opts: ReconcileOptions = {}): ReconcileResult {
  const weightTol = opts.weightTolKg ?? DEFAULTS.weightTolKg;
  const rollupTol = opts.dayRollupTolKg ?? DEFAULTS.dayRollupTolKg;
  const weightField = opts.weightField ?? DEFAULTS.weightField;
  const movementTotalField = opts.movementTotalField ?? DEFAULTS.movementTotalField;

  const fine = records.filter(isFine);

  // ── Date-level corroboration index (from movement) ────────────────────────
  // date -> movement grand total (kg). Movement is single-source; if a date somehow
  // repeats we keep the FIRST (extractor already sums cross-tab into one total per date).
  const movementByDate = new Map<string, number>();
  for (const r of records) {
    if (r.source !== "movement") continue;
    const v = opinionValue(r, movementTotalField);
    if (typeof v === "number" && !movementByDate.has(r.naturalKey.transaction_date)) {
      movementByDate.set(r.naturalKey.transaction_date, v);
    }
  }

  // (source, date) -> summed weight across all that source's fine keys on that date.
  // This is each witness's whole-day rc_out picture, checked against the movement total.
  const dailyRollup = new Map<string, number>();
  const rollupKey = (s: RcOutSource, date: string) => `${s}\u0001${date}`;
  for (const r of fine) {
    const v = opinionValue(r, weightField);
    if (typeof v !== "number") continue;
    const k = rollupKey(r.source, r.naturalKey.transaction_date);
    dailyRollup.set(k, (dailyRollup.get(k) ?? 0) + v);
  }

  /** Does source S's whole-day rc_out total for `date` match the movement grand total? */
  function movementCorroborates(source: RcOutSource, date: string): boolean {
    const mv = movementByDate.get(date);
    if (mv === undefined) return false;
    const roll = dailyRollup.get(rollupKey(source, date));
    if (roll === undefined) return false;
    return numWithin(roll, mv, rollupTol);
  }

  // ── Group fine records by natural key ─────────────────────────────────────
  const byKey = new Map<string, { key: RcOutNaturalKey; recs: SourceRecord[] }>();
  for (const r of fine) {
    const ks = fineKeyStr(r.naturalKey);
    const bucket = byKey.get(ks);
    if (bucket) bucket.recs.push(r);
    else byKey.set(ks, { key: r.naturalKey, recs: [r] });
  }

  const agreements: Agreement[] = [];
  const diffs: SourceDiff[] = [];

  for (const { key, recs } of byKey.values()) {
    // Union of field names any record at this key states.
    const fieldNames = new Set<string>();
    for (const r of recs) for (const f of Object.keys(r.fields)) fieldNames.add(f);

    for (const field of fieldNames) {
      // Present opinions on this field (dedupe a source that appears twice by keeping first).
      const present: { rec: SourceRecord; value: number | string }[] = [];
      const seen = new Set<RcOutSource>();
      for (const rec of recs) {
        if (seen.has(rec.source)) continue;
        const v = opinionValue(rec, field);
        if (v === undefined) continue;
        seen.add(rec.source);
        present.push({ rec, value: v });
      }
      if (present.length === 0) continue;

      // Single-source → accept, tagged.
      if (present.length === 1) {
        agreements.push({
          naturalKey: key,
          field,
          table: "rc_out",
          value: present[0].value,
          sources: [present[0].rec.source],
          singleSource: true,
        });
        continue;
      }

      // Multi-source: all equal within tolerance?
      const first = present[0].value;
      const allAgree = present.every((p) => valuesEqual(p.value, first, weightTol));
      if (allAgree) {
        agreements.push({
          naturalKey: key,
          field,
          table: "rc_out",
          value: first,
          sources: present.map((p) => p.rec.source),
          singleSource: false,
        });
        continue;
      }

      // ── Disagreement → SourceDiff (never auto-picked) ──────────────────────
      const isWeight = field === weightField;
      const opinions: SourceOpinion[] = present.map(({ rec, value }) => {
        const corroboratedBy: RcOutSource[] = [];
        // Direct: another present source at this key states the same value (3+ source case).
        for (const other of present) {
          if (other.rec.source === rec.source) continue;
          if (valuesEqual(other.value, value, weightTol)) corroboratedBy.push(other.rec.source);
        }
        // Rollup: for the additive weight field only, the movement day total backs the source
        // whose whole-day rc_out picture reconciles to it (the L-037 discriminator).
        if (isWeight && movementCorroborates(rec.source, key.transaction_date)) {
          corroboratedBy.push("movement");
        }
        return {
          source: rec.source,
          value,
          provenance: rec.provenance,
          selfConsistent: rec.selfConsistent,
          corroboratedBy,
        };
      });

      diffs.push({
        naturalKey: key,
        field,
        table: "rc_out",
        sources: opinions,
        recommended: recommend(opinions, key.transaction_date, isWeight, movementByDate),
      });
    }
  }

  return { agreements, diffs };
}

/**
 * Advisory recommendation. Prefers the value that is BOTH self-consistent AND corroborated
 * by an independent witness. Only emits when EXACTLY ONE opinion qualifies (deterministic,
 * conservative — an ambiguous field gets no hint and goes to the human bare). Never decides.
 */
function recommend(
  opinions: SourceOpinion[],
  date: string,
  isWeight: boolean,
  movementByDate: Map<string, number>,
): { source: RcOutSource; why: string } | undefined {
  const qualified = opinions.filter((o) => o.selfConsistent && o.corroboratedBy.length > 0);
  if (qualified.length !== 1) return undefined;

  const win = qualified[0];
  const others = opinions.filter((o) => o !== win);
  const backers = win.corroboratedBy.join(", ");
  const usesMovement = isWeight && win.corroboratedBy.includes("movement");
  const mvTotal = movementByDate.get(date);

  const parts: string[] = [];
  parts.push(`${win.source} is self-consistent`);
  if (usesMovement && mvTotal !== undefined) {
    parts.push(`its whole-day rc_out total matches the RC MOVEMENT day total (${round1(mvTotal)} kg)`);
  } else {
    parts.push(`corroborated by ${backers}`);
  }
  const uncorroborated = others
    .filter((o) => o.corroboratedBy.length === 0)
    .map((o) => o.source);
  if (uncorroborated.length) {
    parts.push(`${uncorroborated.join(", ")} ${uncorroborated.length === 1 ? "is" : "are"} uncorroborated`);
  }
  parts.push("advisory only — confirm before applying");
  return { source: win.source, why: parts.join("; ") + "." };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Convenience Stage-1 helper (optional, for R2). Given a proposed batch's feeding LEGS on
 * one day at one block, returns whether they are self-consistent under the L-037 balance
 * rule — every leg's STRT − END == DAY TOTAL (within tol). Mirrors, but does not import,
 * classify.ts::balanceIntegrity (that guard is not exported and must not be modified).
 * The reconciler itself consumes the boolean on SourceRecord; this just helps callers build it.
 */
export interface ProposedLeg {
  strt_bal_kg: number | null;
  end_bal_kg: number | null;
  day_total_kg: number | null;
}

export function proposedLegsSelfConsistent(
  legs: ProposedLeg[],
  tolKg = 1,
): { selfConsistent: boolean; note?: string } {
  for (const leg of legs) {
    const { strt_bal_kg: s, end_bal_kg: e, day_total_kg: d } = leg;
    if (s === null || e === null || d === null) continue; // un-checkable leg → not held
    const se = Math.round((s - e) * 1000) / 1000;
    if (Math.abs(se - d) > tolKg) {
      return {
        selfConsistent: false,
        note:
          `block balance integrity: STRT ${s} - END ${e} = ${se} kg but DAY TOTAL = ${d} kg ` +
          `(delta ${round1(se - d)}) — suspected cross-block cumulative (L-037).`,
      };
    }
  }
  return { selfConsistent: true };
}
