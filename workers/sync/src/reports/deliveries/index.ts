/**
 * index.ts — deliveries report port entrypoint (Wave 3, port #3 — the L-033 flagship).
 *
 * Exports:
 *   classifyCase(workbookPaths, dbWindow, opts)  — the FROZEN parity entrypoint
 *       (src/reports/types.ts). Runs extract→classify→guard OFFLINE against the DB
 *       snapshot and returns the classify oracle unit (the guarded result dict).
 *   runReport(deps, runId, manifest, opts)       — the two-phase orchestrator
 *       (fetch → extract → enrich → classify+guard → apply). DB + Gmail injected as
 *       deps (copied idiom from src/reports/flecon/index.ts + rc_out/index.ts); this
 *       file never imports gmail/db beyond shared lib types.
 *
 * Ground truth: sync_deliveries.py (orchestration), extract_rc_deliveries.py,
 * enrich_prices.py, classify_deliveries.py, lib/deductions.py, and
 * workers/sync/scripts/parity_guards.py (the guard layer, part of the classify oracle).
 *
 * The classify "envelope" is the guarded classifier RESULT dict (summary/new/changed/
 * noop/malformed/flagged/dup_noops) — exactly what build_oracle.py::oracle_deliveries
 * returns. NOT the orchestrator_common.classify_envelope wrapper.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  ClassifyCase,
  ClassifyEnvelope,
  ClassifyOpts,
  DbWindow,
} from "../types.js";
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";

import { loadDeliveriesWorkbook } from "./sheet.js";
import { extractDeliveries, type ExtractResult } from "./extract.js";
import {
  enrichPrices,
  MIN_BAND_SAMPLES,
  type CzarinaMatch,
  type EarnedAlias,
  type PriceBand,
  type PriceNote,
  type SourceAlias,
} from "./enrich.js";
import { canonicalSupplier } from "./supplierCanon.js";
import {
  classifyDeliveries,
  applyDeliveriesGuard,
  type DeliveriesDbRow,
  type GuardedResult,
} from "./classify.js";
import {
  applyDeliveries,
  type DeliveriesCompact,
  type ApplyResult,
  type UnpricedOverdue,
} from "./apply.js";
import { reportNotReceivedNote } from "../reportNotReceived.js";
import { findStreamStatus } from "../../lib/streamStaleness.js";

export const REPORT_TYPE = "deliveries";

const CODIFIED_RULES = [
  "L-001",
  "L-004",
  "L-006",
  "L-008",
  "L-020",
  "L-021",
  "L-033a",
  "L-033b",
  "batch_code-heuristic-translation",
  "never-auto-create-batch",
] as const;

// deliveries DB-window snapshot shape (types.ts: deliveries role keys).
//   deliveries   → deliveries rows the classifier diffs against
//   batch_codes  → the set of existing batch_codes the L-033b hint checks (offline
//                  stand-in for db.select_one("batches", ...), see parity_guards.py)
interface DeliveriesDbWindow {
  deliveries?: DeliveriesDbRow[];
  batch_codes?: string[];
}

function asDbWindow(dw: DbWindow): DeliveriesDbWindow {
  return (dw ?? {}) as DeliveriesDbWindow;
}

/** Shared extract→classify→guard body used by BOTH classifyCase and runReport. */
function runClassifyFromExtract(
  extract: ExtractResult,
  since: string,
  dbRows: DeliveriesDbRow[],
  batchCodes: Set<string>,
): GuardedResult {
  // Tail-filter by since (sync_deliveries.py filters Python-side after extract).
  const filtered: ExtractResult = {
    ...extract,
    rows: extract.rows.filter(
      (r) => String(r.transaction_date).slice(0, 10) >= since,
    ),
  };
  const classified = classifyDeliveries(filtered, dbRows);
  return applyDeliveriesGuard(classified, dbRows, batchCodes);
}

// ---------------------------------------------------------------------------
// FROZEN classify entrypoint (types.ts). Parity harness calls this per fixture.
// ---------------------------------------------------------------------------
export const classifyCase: ClassifyCase = async (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
): Promise<ClassifyEnvelope> => {
  const dw = asDbWindow(dbWindow);
  const since = String(opts.since);
  const dbRows = dw.deliveries ?? [];
  const batchCodes = new Set(dw.batch_codes ?? []);

  const primaryPath = workbookPaths.primary;
  // A missing primary workbook = the RC DELIVERIES email did not arrive: classify an
  // empty extract (mirrors sync_deliveries.py's no-xlsx early return), NOT throw.
  if (!primaryPath) {
    const emptyExtract: ExtractResult = {
      filename: "",
      sheets_processed: [],
      rows: [],
      summary: { total_rows: 0, extraction_warnings: [], overall_confidence: 0.0, unmapped_batches: [] },
    };
    const guarded = runClassifyFromExtract(emptyExtract, since, dbRows, batchCodes);
    return guarded as unknown as ClassifyEnvelope;
  }

  const buf = await readFile(primaryPath);
  const wb = await loadDeliveriesWorkbook(buf);
  const extract = extractDeliveries(wb, basename(primaryPath));

  // NOTE: the classify oracle path (build_oracle.py::oracle_deliveries) does NOT run
  // enrich_prices — enrichment is an apply-phase step whose only effect (cost_basis)
  // is never diffed when the extract side is null, and is not exercised by any
  // deliveries fixture. So classifyCase deliberately skips enrich, matching the oracle.
  const guarded = runClassifyFromExtract(extract, since, dbRows, batchCodes);
  return guarded as unknown as ClassifyEnvelope;
};

// ---------------------------------------------------------------------------
// Full orchestrator — runReport (apply-phase; DB + Gmail injected).
// ---------------------------------------------------------------------------

export interface StoredAttachmentLike {
  storagePath: string;
  filename: string;
  emailUid: number | string;
  emailSubject?: string;
  threadId?: string | null;
}

/** Per-report manifest slice: role → attachments. deliveries uses `deliveries`
 *  (operator RC DELIVERIES) + optional `deliveries_czarina` (price file). */
export interface DeliveriesManifest {
  reports: Record<string, StoredAttachmentLike[]>;
}

export interface RunReportDeps {
  db: DbClient;
  /** Download a stored attachment (Storage path → local file path) — injected. */
  fetchToLocalPath: (storagePath: string) => Promise<string>;
  /** Gmail labeler — injected (apply never imports gmail). */
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  /** Progress emitter bound to (runId, "deliveries"). */
  progress?: ProgressEmitter;
  noLabel?: boolean;
  runTs?: string;
}

export interface RunReportResult {
  classify: {
    report_type: string;
    ok: boolean;
    gate_failures: never[];
    counts: { noop: number; insert: number; update: number; flagged: number };
    watermark: string | null;
    codified_rules_applied: readonly string[];
  };
  apply: ApplyResult;
}

/**
 * The full deliveries sync (sync_deliveries.py phase_classify + phase_apply fused for
 * the worker). Computes since from the live DB watermark (−3d tail scope), extracts
 * the operator file, OPTIONALLY enriches from Czarina, classifies + runs the guard
 * layer, and applies. There is NO hard gate in deliveries (gate_failures always []).
 */
export async function runReport(
  deps: RunReportDeps,
  runId: string,
  manifest: DeliveriesManifest,
  opts: { since?: string } = {},
): Promise<RunReportResult> {
  void runId;
  const { db } = deps;
  const emit = deps.progress;

  await emit?.("fetch", "Checking Gmail for new delivery reports…", 5);

  // Watermark + since (sync_deliveries.py:81-83): watermark −3d tail scope, else 2025-01-01.
  const watermark = await db.dataWatermark("deliveries");
  const since = opts.since ?? (watermark ? minusDaysISO(watermark, 3) : "2025-01-01");

  const primaryAtt = firstAttachment(manifest, "deliveries");
  const czarinaAtt = firstAttachment(manifest, "deliveries_czarina");

  if (!primaryAtt) {
    // -------------------------------------------------------------------------
    // NO RC DELIVERIES REPORT AT ALL (L-044). This branch used to emit
    // "Nothing new today — no RC DELIVERIES report waiting." at 100% and return an empty
    // envelope, and it printed exactly that on the days RC IN was going stale. Two things
    // were wrong with it and both are fixed here:
    //
    //   1. It REASSURED. A run in which nothing arrived is indistinguishable from a quiet
    //      day unless something says otherwise, so the absence is now a durable FINDING
    //      whose severity comes from `view_digest_stream_status.missed_working_days` (the
    //      ONE lateness rule — see reports/reportNotReceived.ts; nothing is re-derived).
    //   2. It skipped the unpriced-overdue check, which reads the DATABASE and has nothing
    //      to do with the mailbox. That check exists precisely to catch a price outage
    //      "independent of why", and it was gated on the very thing that had failed — so
    //      on the first day it would have fired, it did not run. It now runs on EVERY run.
    // -------------------------------------------------------------------------
    const runTs = deps.runTs ?? new Date().toISOString();
    // L-048 part 3: an empty mailbox is not evidence the sender went quiet — an EARLIER
    // run today may have labeled the email `Blackwood-Processed`, which every primary
    // query excludes. Read the run bookkeeping before saying nothing arrived. Non-fatal
    // and never throws; an unreadable row leaves the note at full volume.
    const wmRead = await db.readIngestionWatermark(REPORT_TYPE);
    const notReceived = reportNotReceivedNote({
      reportType: REPORT_TYPE,
      sourceLabel: "RC DELIVERIES report",
      stream: "deliveries",
      since,
      runTs,
      read: await findStreamStatus(db, "deliveries"),
      watermarkRow: wmRead.row,
    });

    const overdueRead = await readUnpricedOverdue(db);
    const emptyNotes: PriceNote[] = [];
    if (overdueRead.error) emptyNotes.push(unpricedCheckFailedNote(overdueRead.error));

    // Overdue first (pct 99), then the closing beat (pct 100) — the emitter keeps pct
    // monotonic, so a 99 emitted after a 100 would be clamped and read out of order.
    await emitOverdueBeat(emit, overdueRead.rows);

    const missed = notReceived.missed_working_days;
    await emit?.(
      "finalize",
      notReceived.already_processed
        ? `No new RC DELIVERIES report — today's was already taken in by an earlier run.`
        : missed && missed > 0
        ? `No RC DELIVERIES report arrived — and RC IN has now missed ${missed} working ` +
            `day${missed === 1 ? "" : "s"}.`
        : "No RC DELIVERIES report arrived in this run's mailbox window.",
      100,
      notReceived.through_date
        ? `RC IN has data through ${notReceived.through_date}.`
        : undefined,
      notReceived.already_processed ? "info" : "warn",
    );

    const emptyApply: ApplyResult = {
      report_type: REPORT_TYPE,
      ok: true,
      inserts: 0,
      updates: 0,
      held: [],
      labeled: false,
      watermark_updated: false,
      errors: [],
      price_notes: emptyNotes,
      unpriced_overdue: overdueRead.rows,
      delivery_human_edits: [],
      awaiting_batch_assignment: [],
      report_not_received: notReceived,
    };
    return {
      classify: {
        report_type: REPORT_TYPE,
        ok: true,
        gate_failures: [],
        counts: { noop: 0, insert: 0, update: 0, flagged: 0 },
        watermark,
        codified_rules_applied: CODIFIED_RULES,
      },
      apply: emptyApply,
    };
  }

  await emit?.("fetch", `Found the report: ${primaryAtt.emailSubject ?? "RC DELIVERIES"}`, 15);
  const primaryPath = await deps.fetchToLocalPath(primaryAtt.storagePath);

  await emit?.("extract", "Reading the delivery spreadsheet…", 28);
  const wb = await loadDeliveriesWorkbook(await readFile(primaryPath));
  const extract = extractDeliveries(wb, basename(primaryPath));

  // Tail-filter for enrichment scope + Czarina sheet selection.
  const windowRows = extract.rows.filter(
    (r) => String(r.transaction_date).slice(0, 10) >= since,
  );

  // ---------------------------------------------------------------------------
  // PRICE ENRICHMENT (sync_deliveries.py:118-140). Mutates cost_basis on windowRows.
  //
  // THE OLD CODE HAD A BARE `catch` THAT SWALLOWED EVERYTHING as "Price file
  // unavailable — proceeding without prices." On 2026-08-07 that one silent catch was
  // found to have un-priced EVERY August delivery: the tab-name generator produced
  // "August 2026", Czarina's tab is "Aug. 2026", the exact-match lookup threw, and the
  // run carried on cheerfully. Nine truckloads sat at cost_basis = 0 for a week.
  //
  // Now there are THREE distinguishable outcomes, and none of them is quiet:
  //   1. no Czarina attachment at all      → a `price_file_missing` note + a WARN beat.
  //   2. the file is there but UNUSABLE    → a `price_*` note + a WARN/ERROR beat.
  //   3. the file worked, with caveats     → notes for every fuzzy/out-of-band match.
  //   4. the file worked and matched NOTHING → `price_no_row_matched`, high (L-044).
  // Every note becomes a run finding via `apply.price_notes`, so it survives past the
  // progress feed and shows up in Sync Review.
  //
  // OUTCOME 1 BECAME A DURABLE NOTE ON 2026-08-18 (L-044). It was a progress beat and
  // nothing else, i.e. it died with the run — and the mail clerk now REFUSES a workbook
  // from Czarina that is not the price file by name, which makes "no price file" a state
  // the sync can reach on its own. A guard that can silence the price step must not be
  // able to do so quietly. Note the 5-day mailbox window means a single missed send does
  // NOT reach here (yesterday's file is still in range), so this note firing means five
  // days without a recognisable price file — genuinely worth saying.
  // ---------------------------------------------------------------------------
  const priceNotes: PriceNote[] = [];
  let priceSummary: CzarinaMatch | null = null;

  if (!czarinaAtt) {
    // Outcome 1 — an honest, materially different message from "the file broke".
    if (windowRows.length) {
      priceNotes.push({
        kind: "price_file_missing",
        rows_considered: windowRows.length,
        detail:
          `No price file was found in the mailbox window, so none of the ${windowRows.length} ` +
          `deliveries in this run could be priced — new rows carry the unpriced placeholder. ` +
          `The sync looks for a workbook named "RAW CHARCOAL PURCHASES -Daily" from Czarina ` +
          `within the last 5 days and deliberately ignores her other attachments, so this ` +
          `means either nothing arrived or what arrived was named differently. Prices are ` +
          `not supposed to lag — chase the file.`,
      });
      await emit?.(
        "extract",
        "No price file came with today's report — new deliveries will be recorded unpriced.",
        40,
        undefined,
        "warn",
      );
    }
  } else if (windowRows.length) {
    await emit?.("extract", "Matching delivery prices from Czarina's file…", 40);
    try {
      const czarinaPath = await deps.fetchToLocalPath(czarinaAtt.storagePath);
      const czBuf = await readFile(czarinaPath);

      // Rung 2 of the match ladder + the result sanity check both read the DB, so they
      // are gathered HERE and passed in as data — enrich itself stays pure/offline.
      const [aliases, priceBands] = await Promise.all([
        readSourceAliases(db),
        readSupplierPriceBands(db, since),
      ]);

      // The FILENAME goes in with the bytes (L-044): `enrich` never matches on it, but
      // the finding it raises when nothing matched has to be able to say which workbook
      // it read, and that is the one fact this pipeline could not previously state.
      priceSummary = await enrichPrices(czBuf, windowRows, {
        aliases,
        priceBands,
        filename: czarinaAtt.filename,
      });
      priceNotes.push(...priceSummary.notes);

      // Persist every alias this run EARNED (each one already corroborated by a
      // uniqueness-gated fallback match), so the same source typo is a clean exact
      // match on every future run. Best-effort: a failure to remember must never
      // fail a run that priced correctly.
      await recordEarnedAliases(db, priceSummary.learned);

      if (!priceSummary.ok) {
        // Outcome 2 — the file was READ but could not be used. This is the beat that
        // used to lie. `error` level: louder than `warn`, and materially different
        // from "no price file arrived".
        const looked = priceSummary.months_requested.join(", ");
        await emit?.(
          "extract",
          `Could not read prices from Czarina's file — nothing was priced (needed ${looked}).`,
          40,
          priceNotes.map((n) => n.detail).join(" | ") || undefined,
          "error",
        );
      } else {
        const loud = priceNotes.length;
        await emit?.(
          "extract",
          `Priced ${priceSummary.matched_count} of ${windowRows.length} deliveries from ` +
            `${priceSummary.tabs_loaded.join(" + ") || "no tab"}` +
            (loud ? ` — ${loud} need${loud === 1 ? "s" : ""} a look` : ""),
          45,
          undefined,
          loud ? "warn" : "info",
        );
      }
    } catch (err) {
      // A genuinely unexpected failure (Storage fetch, corrupt buffer). Still NOT
      // reported as "unavailable" — say what actually happened and keep it as a note.
      const msg = err instanceof Error ? err.message : String(err);
      priceNotes.push({
        kind: "price_file_unreadable",
        detail:
          `The price file was attached but could not be processed: ${msg}. No delivery was ` +
          `priced in this run; new rows carry the unpriced placeholder until this is fixed.`,
      });
      await emit?.(
        "extract",
        "The price file was attached but could not be processed — nothing was priced.",
        40,
        msg,
        "error",
      );
    }
  }

  await emit?.("classify", "Comparing the report against the database…", 58);
  const dbRows = (await db.readRows("deliveries", {
    sinceDate: since,
    columns: [
      "id", "transaction_date", "supplier", "batch_code", "block_loc", "truck_plate",
      "sacks", "weight_kg", "cost_basis", "remarks", "lab_results",
    ],
  })) as DeliveriesDbRow[];
  const batchRows = await db.readRows("batches", { columns: ["batch_code"], sinceColumn: null });
  const batchCodes = new Set<string>();
  for (const b of batchRows) {
    if (b.batch_code) batchCodes.add(String(b.batch_code));
  }

  const filtered: ExtractResult = { ...extract, rows: windowRows };
  const classified = classifyDeliveries(filtered, dbRows);
  const guarded = applyDeliveriesGuard(classified, dbRows, batchCodes);

  const s = guarded.summary;
  await emit?.(
    "classify",
    `${s.noop_count} already recorded · ${guarded.new.length} new · ${s.changed_count} changed` +
      (s.awaiting_assignment_count
        ? ` · ${s.awaiting_assignment_count} waiting on a pile assignment`
        : ""),
    90,
  );

  const compact: DeliveriesCompact = {
    report_type: REPORT_TYPE,
    since,
    watermark,
    source: {
      email_subject: primaryAtt.emailSubject ?? null,
      email_uid: primaryAtt.emailUid,
      email_thread_id: primaryAtt.threadId ?? null,
    },
    actionable: {
      new: guarded.new,
      changed: guarded.changed,
      flagged: guarded.flagged,
      dup_noops: guarded.dup_noops,
      malformed: guarded.malformed.map((m) => ({ reason: m.reason, row: m.row })),
      // L-042 — carried through so apply can report it; it is never written or held.
      awaiting_assignment: guarded.awaiting_assignment.map((a) => ({
        index: a.index,
        reason: a.reason,
        row: a.row,
      })),
    },
    batch_codes: [...batchCodes],
  };

  const apply = await applyDeliveries(compact, {
    db,
    labeler: deps.labeler,
    progress: deps.progress,
    noLabel: deps.noLabel,
    runTs: deps.runTs,
  });

  // ---------------------------------------------------------------------------
  // THE UNPRICED WARNING (Renzo, 2026-08-07): "prices are not supposed to lag, and
  // they liquidate daily." So any delivery still unpriced MORE THAN ONE DAY after its
  // transaction_date is named here, every run, until someone fixes it.
  //
  // Read AFTER apply, so a row this very run inserted unpriced is included the moment
  // it goes overdue rather than a day late. The overdue rule itself is NOT re-derived
  // here — `view_digest_unpriced_deliveries` owns the ONE definition (and the existing
  // `view_digest_unpriced_recent` count is now a thin projection of that same view),
  // so the sync and the Home digest can never disagree about what "unpriced" means.
  // ---------------------------------------------------------------------------
  const overdueRead = await readUnpricedOverdue(db);
  // A FAILED read is reported, never swallowed (L-044). The bare `catch { return [] }`
  // this replaces made a broken check indistinguishable from a clean bill of health —
  // the exact shape of the "Price file unavailable" lie L-039 was written about.
  if (overdueRead.error) priceNotes.push(unpricedCheckFailedNote(overdueRead.error));

  // Attach both price channels to the apply envelope, so they become durable run
  // findings (lib/sync/findings.ts) rather than dying with the progress feed.
  apply.price_notes = priceNotes;
  apply.unpriced_overdue = overdueRead.rows;
  await emitOverdueBeat(emit, overdueRead.rows);

  return {
    classify: {
      report_type: REPORT_TYPE,
      ok: true, // no hard gate in deliveries
      gate_failures: [],
      counts: {
        noop: s.noop_count + guarded.dup_noops.length,
        insert: guarded.new.length,
        update: s.changed_count,
        flagged: guarded.flagged.length,
      },
      watermark,
      codified_rules_applied: CODIFIED_RULES,
    },
    apply,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function firstAttachment(manifest: DeliveriesManifest, key: string): StoredAttachmentLike | null {
  const arr = manifest.reports?.[key];
  return arr && arr.length ? arr[0] : null;
}

/** since = watermark − N days (sync_deliveries.py: date.fromisoformat − timedelta). */
function minusDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// NOTE: `czarinaMonthSheet()` and `maxDate()` used to live here. Both are DELETED.
//
//   czarinaMonthSheet(iso) returned `"<FullMonth> <YYYY>"` — "August 2026" — and the
//   result was handed to an EXACT worksheet lookup. Czarina's tab is "Aug. 2026", so
//   from the day she created that tab the sync could not price a single August
//   delivery, and the failure was swallowed. Tab resolution now normalizes both sides
//   to (month, year) in `czarinaSheet.ts::resolveCzarinaTab`.
//
//   maxDate(rows) picked ONE month — the newest in the window — so a run spanning a
//   month boundary silently left the older month unpriced. Replaced by
//   `czarinaSheet.ts::monthsSpanned`, which returns EVERY month the window touches.
//
// Do not reintroduce either one.

/**
 * Learned source-spelling pairs (rung 2 of the match ladder). Read from
 * `public.delivery_source_aliases`; `active = false` rows are excluded so a retired
 * alias stops firing without losing its history.
 *
 * Best-effort: if the table cannot be read the run still prices everything the exact
 * key and the fallback can reach. A missing memory must never block a working sync.
 */
async function readSourceAliases(db: DbClient): Promise<SourceAlias[]> {
  try {
    const rows = await db.readRows("delivery_source_aliases", {
      sinceColumn: null,
      columns: ["kind", "ours", "theirs"],
      extraFilters: { active: "is.true" },
    });
    const out: SourceAlias[] = [];
    for (const r of rows) {
      const kind = String(r.kind);
      if (kind !== "truck_plate" && kind !== "supplier") continue;
      const ours = String(r.ours ?? "");
      const theirs = String(r.theirs ?? "");
      if (!ours || !theirs) continue;
      out.push({ kind, ours, theirs });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Per-supplier observed ₱/kg band from PRICED history, for the result sanity check
 * (fault (h)): a match can pass every key test and still be wrong, and the only thing
 * that catches it is the number looking nothing like what this supplier normally
 * charges. Ornales in August is ₱39.50–₱40.50, so a ₱11 or ₱45 match stands out.
 *
 * Scoped to the trailing window (`since` − 90 days) so a genuine price move a few
 * months ago does not permanently widen the band into uselessness. Grouped by
 * `canonical_supplier`, the same key the matcher uses, so the band and the match agree
 * about who the supplier is. Best-effort — no band means no check, never a blocked run.
 */
async function readSupplierPriceBands(
  db: DbClient,
  since: string,
): Promise<Map<string, PriceBand>> {
  const bands = new Map<string, PriceBand>();
  try {
    const rows = await db.readRows("deliveries", {
      sinceDate: minusDaysISO(since, 90),
      columns: ["supplier", "cost_basis"],
    });
    for (const r of rows) {
      const php = typeof r.cost_basis === "number" ? r.cost_basis : Number(r.cost_basis);
      // cost_basis = 0 is the L-008 UNPRICED PLACEHOLDER, not a ₱0 delivery — including
      // it would drag every band's floor to 0 and make the check vacuous.
      if (!Number.isFinite(php) || php <= 0) continue;
      const key = canonicalSupplier(r.supplier == null ? null : String(r.supplier));
      const cur = bands.get(key);
      if (!cur) bands.set(key, { min: php, max: php, n: 1 });
      else {
        cur.min = Math.min(cur.min, php);
        cur.max = Math.max(cur.max, php);
        cur.n += 1;
      }
    }
    // Drop bands too thin to be evidence, so `enrich` never has to second-guess them.
    for (const [k, b] of bands) if (b.n < MIN_BAND_SAMPLES) bands.delete(k);
  } catch {
    return new Map();
  }
  return bands;
}

/**
 * Persist the aliases this run EARNED, via the service-role-only RPC
 * `fn_record_delivery_source_alias` (idempotent: a repeat sighting bumps `times_seen`
 * and never rewrites the original evidence).
 *
 * Best-effort and individually guarded: forgetting to remember a spelling must never
 * fail a run that priced every row correctly.
 */
async function recordEarnedAliases(db: DbClient, learned: readonly EarnedAlias[]): Promise<void> {
  for (const a of learned) {
    try {
      await db.recordSourceAlias(a);
    } catch (err) {
      console.error(
        `[deliveries] could not remember alias ${a.kind} ${a.ours}->${a.theirs} (non-fatal):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Deliveries still unpriced more than a day after they happened, oldest first.
 *
 * Reads `public.view_digest_unpriced_deliveries` and filters on the view's own
 * `is_overdue` — the overdue rule is NOT re-derived here. That view is also what
 * `view_digest_unpriced_recent` (the Home digest's count) projects from, so the sync
 * warning and the digest flag can never drift apart.
 *
 * IT RETURNS ITS FAILURE (2026-08-18, L-044). This function used to end in
 * `catch { return [] }`, so a broken read — a renamed column, a revoked grant, a timeout —
 * returned the same empty array as a genuinely clean database, and the run would state
 * "nothing overdue" on the strength of a question it never managed to ask. That is the
 * `catch` from `enrich_prices`' caller wearing a different hat, and it sits on the ONE
 * check that is meant to catch a price outage independent of its cause. The caller turns a
 * non-null `error` into a durable note; the empty list is only ever an ANSWER now.
 *
 * Callers: BOTH branches of `runReport`. It reads the database, not the mailbox, so it
 * must not be behind the "did an attachment arrive" guard.
 */
async function readUnpricedOverdue(
  db: DbClient,
): Promise<{ rows: UnpricedOverdue[]; error: string | null }> {
  try {
    const rows = await db.readRows("view_digest_unpriced_deliveries", {
      sinceColumn: null,
      columns: [
        "id", "transaction_date", "supplier", "batch_code",
        "truck_plate", "sacks", "weight_kg", "days_pending",
      ],
      extraFilters: { is_overdue: "is.true", order: "transaction_date.asc" },
    });
    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        transaction_date: String(r.transaction_date).slice(0, 10),
        supplier: r.supplier == null ? null : String(r.supplier),
        batch_code: r.batch_code == null ? null : String(r.batch_code),
        truck_plate: r.truck_plate == null ? null : String(r.truck_plate),
        weight_kg: r.weight_kg == null ? null : Number(r.weight_kg),
        sacks: r.sacks == null ? null : Number(r.sacks),
        days_pending: Number(r.days_pending ?? 0),
      })),
      error: null,
    };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The note for a FAILED overdue check. Says plainly that the answer is unknown rather
 * than clean, because those are different facts and only one of them is reassuring.
 * `attention`, not `high` (see `lib/sync/findings.ts::priceSeverity`): nothing is known to
 * be wrong with any delivery — what is broken is the sync's own ability to look.
 */
function unpricedCheckFailedNote(message: string): PriceNote {
  return {
    kind: "price_overdue_check_failed",
    detail:
      `The check for deliveries that are still unpriced could not be run this sync, so ` +
      `this run CANNOT say whether any are overdue — read the absence of that warning as ` +
      `"not checked", not as "none". Everything else in this run is unaffected. The read ` +
      `failed with: ${message}`,
  };
}

/** The one place the overdue warning is worded, so both run paths say it identically. */
async function emitOverdueBeat(
  emit: ProgressEmitter | undefined,
  overdue: readonly UnpricedOverdue[],
): Promise<void> {
  if (!overdue.length) return;
  await emit?.(
    "finalize",
    `${overdue.length} deliver${overdue.length === 1 ? "y" : "ies"} still have no price — ` +
      `oldest is ${overdue[0].days_pending} days old.`,
    99,
    undefined,
    "warn",
  );
}
