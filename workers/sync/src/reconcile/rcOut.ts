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
import {
  LAG_DAYS,
  WINDOW_BUFFER_DAYS,
  type Agreement,
  type AttributionDiff,
  type AttributionSide,
  type ReconcileOptions,
  type ReconcileResult,
  type RcOutNaturalKey,
  type RcOutSource,
  type SingleSourceDisposition,
  type SourceDiff,
  type SourceOpinion,
  type SourceRecord,
} from "./types.js";

/** The reconciliation window (R4b): the PROPOSED extract's date span, buffered on each side.
 *  `null` = no proposed extract this run → the window is EMPTY and single-witness facts are
 *  acted on for NOTHING (leaving Sheet-only history untouched — the anti-clobber rule). */
interface ReconcileWindow {
  minDate: string;
  maxDate: string;
}

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

/**
 * A record is FINE (reconciled) when it names a batch and is not the movement witness.
 * R4a: block_loc MAY be null — a FEED row (block_loc null) keys on (date, batch, dest), the
 * feed batch being its own discriminator (Deliverable 2). Only movement (date-level, batch
 * null) is excluded. `batch` here is a resolved batch_id (Deliverable 1).
 */
function isFine(r: SourceRecord): boolean {
  return r.source !== "movement" && r.naturalKey.batch !== null;
}

/** Whole-day difference b − a for two YYYY-MM-DD strings at UTC midnight. NaN if unparseable.
 *  Pure — parses the two given dates only; NEVER reads the wall clock. */
function daysBetweenISO(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return NaN;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * R4b — classify a single-witness fact's recency (Refinement 3) against the PROPOSED-span
 * window. Returns undefined (no disposition — the fact is SETTLED / untouched) when:
 *   - there is no runDate (back-compat: the engine behaves as R1/R2), or
 *   - the window is EMPTY (no proposed extract this run → act on nothing), or
 *   - the fact's date is OUTSIDE [minProposed − buffer, maxProposed + buffer] — the only span
 *     where a second witness could exist; outside it the Sheet value was reconciled when it
 *     was fresh and must be left alone (the L-037 clobber is re-created if we touch it).
 * Inside the window: `pending` within the lag (second source merely not-yet-arrived, self-
 * clears next run) else `held_overdue` (the second source is genuinely overdue → a case).
 */
function classifySingleSource(
  date: string,
  runDate: string | undefined,
  lagDays: number,
  window: ReconcileWindow | null,
  bufferDays: number,
): { disposition: SingleSourceDisposition; ageDays: number } | undefined {
  if (!runDate) return undefined;
  if (!window) return undefined; // empty window — no proposed extract → nothing acted upon
  const fromMin = daysBetweenISO(window.minDate, date); // date − minProposed
  const toMax = daysBetweenISO(date, window.maxDate); // maxProposed − date
  if (!Number.isFinite(fromMin) || !Number.isFinite(toMax)) return undefined;
  if (fromMin < -bufferDays || toMax < -bufferDays) return undefined; // outside span → settled
  const age = daysBetweenISO(date, runDate); // runDate − factDate
  if (!Number.isFinite(age)) return undefined;
  const disposition: SingleSourceDisposition = age <= lagDays ? "pending" : "held_overdue";
  return { disposition, ageDays: age };
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
  const runDate = opts.runDate;
  const lagDays = opts.lagDays ?? LAG_DAYS;
  const bufferDays = opts.windowBufferDays ?? WINDOW_BUFFER_DAYS;

  const fine = records.filter(isFine);

  // ── R4b reconciliation window = the PROPOSED extract's real date span ─────────
  // The Google Sheet carries the ENTIRE history; the proposed report carries ~one day. A
  // second witness can only exist inside the proposed span, so that span (buffered) is the
  // ONLY range where a single Sheet witness is actionable. No proposed records → null window
  // → nothing is acted on (Sheet-only history stays untouched: the anti-clobber rule).
  let window: ReconcileWindow | null = null;
  for (const r of fine) {
    if (r.source !== "proposed") continue;
    const d = r.naturalKey.transaction_date;
    if (window === null) window = { minDate: d, maxDate: d };
    else {
      if (d < window.minDate) window.minDate = d;
      if (d > window.maxDate) window.maxDate = d;
    }
  }

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
  // Candidates for the second-pass attribution matcher (below): single-witness weight_kg
  // facts that were tagged pending/held_overdue (i.e. inside the actionable window).
  const attributionCandidates: SingleWeightCandidate[] = [];

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

      // Single-source → accept, tagged. R4a: attach a recency disposition (pending vs
      // held_overdue) when a runDate was supplied — the shadow signal for Refinement 3.
      if (present.length === 1) {
        const agreement: Agreement = {
          naturalKey: key,
          field,
          table: "rc_out",
          value: present[0].value,
          sources: [present[0].rec.source],
          singleSource: true,
        };
        const disp = classifySingleSource(key.transaction_date, runDate, lagDays, window, bufferDays);
        if (disp) {
          agreement.disposition = disp.disposition;
          agreement.ageDays = disp.ageDays;
          // Only a fact that would become pending/held_overdue (i.e. inside the actionable
          // window) is eligible for attribution pairing — settled/undated facts are left alone.
          if (field === weightField) {
            attributionCandidates.push({ agreement, record: present[0].rec });
          }
        }
        agreements.push(agreement);
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
          // Carry the raw legs through so R3's pick-source resolution can turn the
          // chosen sum into per-leg DB writes (edit / insert / soft-remove).
          rows: rec.rows ?? [],
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

  // ── Second-pass attribution matcher ────────────────────────────────────────
  // Classic bank-reconciliation entity resolution: two single-witness facts that would
  // otherwise separately age into pending/held_overdue are, on inspection, almost
  // certainly the SAME physical feeding reported under two different batch/block
  // attributions (the proposed report derives its batch from (block_date, block_no)
  // while the Sheet carries an operator-typed code — see ./CONTEXT.md). Pair a
  // proposed-only fact with a gsheet-only fact on the same (date, destination) when
  // their weight agrees within tolerance; the pair REPLACES both single-witness facts
  // (they must not also surface as pending/held_overdue — see the filter below).
  const { attributionDiffs, consumed } = matchAttributions(attributionCandidates, weightTol);
  const finalAgreements = consumed.size > 0 ? agreements.filter((a) => !consumed.has(a)) : agreements;

  return { agreements: finalAgreements, diffs, attributionDiffs };
}

/** A single-witness weight_kg Agreement paired with the SourceRecord it was built from
 *  (attribution pairing needs the record's raw legs for batch_code + provenance). */
interface SingleWeightCandidate {
  agreement: Agreement;
  record: SourceRecord;
}

/** Round to 2 decimal places (mirrors rcOutStage.ts::round2 — kept local, this file has
 *  no dependency on the stage). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build one AttributionDiff side from a candidate's Agreement + underlying SourceRecord. */
function attributionSide(c: SingleWeightCandidate): AttributionSide {
  return {
    source: c.record.source,
    batch: c.agreement.naturalKey.batch,
    batch_code: c.record.rows?.[0]?.batch_code ?? null,
    block_loc: c.agreement.naturalKey.block_loc,
    weight_kg: typeof c.agreement.value === "number" ? c.agreement.value : 0,
    provenance: c.record.provenance,
  };
}

/**
 * Group single-witness weight_kg candidates by (transaction_date, destination) and
 * greedily pair a proposed-only fact with a gsheet-only fact whose weight agrees within
 * `weightTolKg`. Deterministic: within a group each source's pool is sorted by the
 * candidate's fine-key string, then matched in that stable order — so when multiple
 * candidates share the same weight on the same date, the pairing is reproducible
 * (first-available match), never arbitrary. Unmatched candidates are left as-is (the
 * caller keeps their pending/held_overdue disposition). A pair whose fine keys turn out
 * IDENTICAL (defensive — should not happen, as identical keys would already be one
 * multi-source fact) is skipped rather than paired.
 */
function matchAttributions(
  candidates: SingleWeightCandidate[],
  weightTolKg: number,
): { attributionDiffs: AttributionDiff[]; consumed: Set<Agreement> } {
  const attributionDiffs: AttributionDiff[] = [];
  const consumed = new Set<Agreement>();
  if (candidates.length === 0) return { attributionDiffs, consumed };

  const groupKey = (c: SingleWeightCandidate) =>
    [c.agreement.naturalKey.transaction_date, c.agreement.naturalKey.destination ?? "MAIN"].join("");

  const groups = new Map<string, SingleWeightCandidate[]>();
  for (const c of candidates) {
    const gk = groupKey(c);
    const bucket = groups.get(gk);
    if (bucket) bucket.push(c);
    else groups.set(gk, [c]);
  }

  const byFineKey = (a: SingleWeightCandidate, b: SingleWeightCandidate) =>
    fineKeyStr(a.agreement.naturalKey).localeCompare(fineKeyStr(b.agreement.naturalKey));

  for (const group of groups.values()) {
    const proposedPool = group.filter((c) => c.record.source === "proposed").sort(byFineKey);
    const gsheetPool = group.filter((c) => c.record.source === "gsheet").sort(byFineKey);
    const usedGsheet = new Set<number>();

    for (const p of proposedPool) {
      const pVal = p.agreement.value;
      if (typeof pVal !== "number") continue;

      let matchIdx = -1;
      for (let i = 0; i < gsheetPool.length; i++) {
        if (usedGsheet.has(i)) continue;
        const gVal = gsheetPool[i].agreement.value;
        if (typeof gVal !== "number") continue;
        if (numWithin(pVal, gVal, weightTolKg)) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx === -1) continue;

      const g = gsheetPool[matchIdx];
      const batchDiffers = p.agreement.naturalKey.batch !== g.agreement.naturalKey.batch;
      const blockDiffers = p.agreement.naturalKey.block_loc !== g.agreement.naturalKey.block_loc;
      if (!batchDiffers && !blockDiffers) continue; // identical key — would already be one fact

      usedGsheet.add(matchIdx);
      const gVal = g.agreement.value as number;
      attributionDiffs.push({
        transaction_date: p.agreement.naturalKey.transaction_date,
        destination: p.agreement.naturalKey.destination ?? "MAIN",
        weight_kg: round2((pVal + gVal) / 2),
        proposed: attributionSide(p),
        gsheet: attributionSide(g),
      });
      consumed.add(p.agreement);
      consumed.add(g.agreement);
    }
  }

  return { attributionDiffs, consumed };
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
