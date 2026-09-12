/**
 * reprice.ts — THE RE-PRICE PASS: Czarina's file prices every unpriced delivery it can,
 * whoever put the row in the database (2026-09-12, L-050).
 *
 * ============================================================================
 * WHAT BROKE — AND WHY IT IS THE SAME SHAPE AS L-039 AND L-044, ONE LEVEL UP
 * ============================================================================
 * On 2026-09-12 eleven deliveries dated 2026-09-08 … 09-11 sat at `cost_basis = 0`
 * (run `8500acc9`). Czarina's `RAW CHARCOAL PURCHASES -Daily(1).xlsx` WAS in the
 * mailbox, WAS downloaded into `sync-inbox/<run>/deliveries_czarina/`, and its
 * `Sept. 2026` tab carries the matching priced rows — e.g. 2026-09-09 ORNALES
 * AAV6111 520 sacks 17,985 kg, 2026-09-10 PAQUIBOT MAN3625 485 sacks 20,235 kg.
 * `apply.price_notes` was `[]` on BOTH the deliveries and the gsheet section. Nothing
 * was wrong with the file, the tab resolver, the matcher, the aliases or the bands.
 *
 * THE PRICE STEP WAS SIMPLY NOT REACHABLE. `enrichPrices` runs in exactly one place —
 * inside the RC DELIVERIES email report, over THAT EMAIL'S EXTRACTED ROWS. No RC
 * DELIVERIES email had arrived since 2026-09-09 (`manifest.reports.deliveries = []`),
 * so `runReport` took its early return; every one of those eleven rows had been
 * INSERTED by the Google Sheet path, which writes `cost_basis = 0` and leaves a comment
 * saying "deliveries-manager to enrich from Czarina/email". Czarina's workbook was
 * fetched and then ignored.
 *
 * So: a delivery that entered through the Sheet was priced by NOBODY, and the
 * `unpriced_overdue` alarm then chased rows the sync itself was declining to price.
 * L-039 said an outage must be loud; L-044 said a check must not sit behind a
 * mailbox-shaped guard. THE PRICE STEP ITSELF WAS BEHIND THAT SAME GUARD. **The email
 * is a WITNESS to a delivery, not a GATE on its price.**
 *
 * ============================================================================
 * WHAT THIS PASS IS, AND THE FOUR THINGS IT DELIBERATELY DOES NOT DO
 * ============================================================================
 * Whenever Czarina's workbook is present — with or without an RC DELIVERIES email —
 * every delivery in the database that is STILL unpriced and that NO HUMAN OWNS is run
 * back through THE SAME `enrichPrices` ladder and, when it matches, written through
 * `fn_apply_delivery_upstream`.
 *
 *  1. NO SECOND MATCHER. It calls `enrichPrices`, the same rungs, the same aliases, the
 *     same bands, the same `MAX_DATE_DRIFT_DAYS`. A second matcher is a second
 *     definition of "the same truckload" and would drift from the first one the day
 *     either is touched.
 *  2. NO SECOND WRITE PATH. Matches go through `fn_apply_delivery_upstream` — the ONLY
 *     sanctioned UPDATE into `deliveries` — so a row a human edited is refused BY THE
 *     DATABASE, in the UPDATE's own WHERE, and reported exactly as the email path
 *     reports it. The candidate read already excludes `human_edited_at IS NOT NULL`;
 *     the RPC is what makes a save landing between read and write still win.
 *  3. NO NEW "UNPRICED" DEFINITION. A candidate is `cost_basis = 0` — the L-008
 *     placeholder, the same predicate `view_digest_unpriced_deliveries` owns.
 *  4. NO REPAIR OF A PRICE THAT ALREADY EXISTS. It only ever moves a row from ₱0 to a
 *     real rate. A row that already has a price is not a candidate, which is also what
 *     makes the pass IDEMPOTENT: run it twice against the same workbook and the second
 *     run finds nothing, writes nothing and says nothing.
 *
 * ============================================================================
 * WHICH NOTES THIS PASS RAISES — AND WHY THE REFUSALS ARE DELIBERATELY SILENT
 * ============================================================================
 * `enrichPrices` is written for the EMAIL population: rows freshly extracted from a
 * report, most of which are expected to price. This population is the exact opposite —
 * every row in it has ALREADY failed to price at least once, and every row of it that
 * matters is ALREADY named, by id, every run, by `unpriced_overdue`. So:
 *
 *   KEPT   `price_repriced`      (info)      — one per row this pass actually priced.
 *                                              A write into an existing row is a fact
 *                                              that deserves a trail of its own.
 *          `price_fuzzy_match`   (attention) — priced, but the two sheets spell it
 *                                              differently. Both spellings, as always.
 *          `price_out_of_band`   (attention) — priced at a rate unlike this supplier's.
 *          tab / file failures   (high)      — ONLY when the same failure is not
 *                                              already in this run's notes (see
 *                                              `dedupeAgainst`). When no RC DELIVERIES
 *                                              email arrived this pass is the ONLY price
 *                                              step in the run, and a month tab that
 *                                              does not resolve must still be the
 *                                              loudest thing the run says (L-039 §9.5).
 *
 *   DROPPED `price_fuzzy_ambiguous`, `price_date_drift` — a refusal here is "this row is
 *          still unpriced", which `unpriced_overdue` says about the same row, by id, in
 *          the same run, at a severity that escalates with age. Two voices about one
 *          fact is how an operator learns to stop reading the list.
 *
 *          `price_no_row_matched` — its whole justification (L-044 §9.10) is that the
 *          email window is `watermark − 3 days` and therefore ALWAYS contains several
 *          days of deliveries that ARE in her file, so 0-of-N is structural evidence of
 *          the wrong workbook. That argument does not survive the change of population:
 *          these rows are, by construction, the ones that did not price, and on a normal
 *          day none of them will — Czarina records the PAYMENT date and simply has not
 *          paid yet. Firing it here would be a threshold that trips on an ordinary
 *          Tuesday, which is exactly what §9.10 refuses to build. The email path still
 *          watches it over the population the argument does hold for.
 *
 * Pure-ish: the DB is injected, the workbook arrives as a Buffer, and the matcher itself
 * stays offline. Nothing here throws — a failure comes back in `errors[]`, because a
 * re-price is an improvement on the status quo and must never be able to fail a run that
 * ingested correctly.
 */
import type { DbClient } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";
import { type DeliveryHumanEdit, deliveryHumanEditNote } from "../deliveryHumanEdit.js";
import type { DeliveryRow } from "./extract.js";
import {
  enrichPrices,
  type EarnedAlias,
  type PriceBand,
  type PriceMatchProvenance,
  type PriceNote,
  type PriceNoteKind,
  type SourceAlias,
} from "./enrich.js";

/**
 * How far back the pass looks for a still-unpriced row.
 *
 * The email path's window is `watermark − 3 days`, which is right for ITS question ("what
 * does today's report say") and far too narrow for this one. §9.13 of the spec measured
 * the consequence exactly: four ₱0 rows dated 2026-08-14 could only self-heal while the
 * watermark stayed below 2026-08-18, and left the window PERMANENTLY the moment a later
 * delivery landed. A price that arrives a fortnight late is ordinary — Czarina records
 * the payment date and liquidates in batches — so the pass must outlive the report window.
 *
 * 45 days is bounded by what the workbook can answer, not by taste: her tabs are monthly,
 * so 45 days is "this month and the one before it, always", which is the largest span in
 * which a late payment is still plausibly her CURRENT bookkeeping rather than history.
 * Beyond that an unpriced row is not waiting on a price, it is a data problem, and
 * `unpriced_overdue` has been naming it at `high` for six weeks.
 *
 * It is a FLOOR, not the window: the caller passes the report's own `since` too, and the
 * EARLIER of the two wins, so this can only ever widen what the email path already covered.
 */
export const REPRICE_LOOKBACK_DAYS = 45;

/** Notes this pass may raise about ONE row it priced. Everything else is dropped — see header. */
const KEEP_ROW_NOTE: ReadonlySet<PriceNoteKind> = new Set<PriceNoteKind>([
  "price_fuzzy_match",
  "price_out_of_band",
]);

/** Whole-file / whole-month failures. Kept, but only if this run has not said it already. */
const FILE_LEVEL_NOTE: ReadonlySet<PriceNoteKind> = new Set<PriceNoteKind>([
  "price_tab_unresolved",
  "price_tab_ambiguous",
  "price_file_unreadable",
]);

/** One delivery sitting at the L-008 placeholder that no human owns. */
export interface RepriceCandidate {
  id: string;
  transaction_date: string;
  supplier: string | null;
  batch_code: string | null;
  block_loc: string | null;
  truck_plate: string | null;
  sacks: number | null;
  weight_kg: number;
}

export interface RepriceDeps {
  db: DbClient;
  /** The price workbook, or null when none reached this run. */
  czarina: { buf: Buffer; filename: string } | null;
  aliases: readonly SourceAlias[];
  priceBands: ReadonlyMap<string, PriceBand>;
  /**
   * The notes this run has ALREADY raised (the email path's). Used only to suppress a
   * duplicate whole-file/whole-month complaint — never to suppress a row note.
   */
  alreadyNoted?: readonly PriceNote[];
  /** The report's own window floor. The pass uses min(this, today − REPRICE_LOOKBACK_DAYS). */
  since: string;
  progress?: ProgressEmitter;
  runTs?: string;
}

export interface RepriceResult {
  /** False when no price workbook reached this run — nothing was attempted. */
  ran: boolean;
  /** How many still-unpriced, human-unowned deliveries were put through the ladder. */
  considered: number;
  /** How many of them were matched AND written. */
  priced: number;
  /** The earliest `transaction_date` the pass looked at. */
  since: string;
  /** Worksheet tabs that resolved and were read. */
  tabs_read: string[];
  /** The months the candidate rows spanned, as "YYYY-MM". */
  months_requested: string[];
  notes: PriceNote[];
  /** Rows the DB refused because a human owns them (a save landing mid-pass). */
  human_edits: DeliveryHumanEdit[];
  /** Spelling pairs earned here, for the caller to persist (same as the email path). */
  learned: EarnedAlias[];
  /** Non-fatal problems. A re-price must never fail a run that ingested correctly. */
  errors: string[];
}

/** The zero result — what an absent price file, or nothing to do, looks like. */
function empty(ran: boolean, since: string): RepriceResult {
  return {
    ran,
    considered: 0,
    priced: 0,
    since,
    tabs_read: [],
    months_requested: [],
    notes: [],
    human_edits: [],
    learned: [],
    errors: [],
  };
}

/**
 * Read every delivery still carrying the L-008 placeholder that NO HUMAN OWNS.
 *
 * `human_edited_at IS NULL` is in the QUERY as well as in the RPC deliberately: the RPC is
 * the control (it re-checks in the UPDATE's own WHERE and is what makes a concurrent save
 * win), and this is merely a courtesy that keeps a latched row out of the matcher, out of
 * the notes and out of the ops list. Two places, one of them authoritative — the same
 * belt-and-braces shape the human-edit latch uses everywhere else.
 */
export async function readRepriceCandidates(
  db: DbClient,
  since: string,
): Promise<RepriceCandidate[]> {
  const rows = await db.readRows("deliveries", {
    sinceDate: since,
    columns: [
      "id", "transaction_date", "supplier", "batch_code", "block_loc",
      "truck_plate", "sacks", "weight_kg",
    ],
    extraFilters: {
      cost_basis: "eq.0",
      human_edited_at: "is.null",
      order: "transaction_date.asc",
    },
  });
  const out: RepriceCandidate[] = [];
  for (const r of rows) {
    const id = r.id == null ? "" : String(r.id);
    const weight = typeof r.weight_kg === "number" ? r.weight_kg : Number(r.weight_kg);
    if (!id || !Number.isFinite(weight)) continue;
    out.push({
      id,
      transaction_date: String(r.transaction_date).slice(0, 10),
      supplier: r.supplier == null ? null : String(r.supplier),
      batch_code: r.batch_code == null ? null : String(r.batch_code),
      block_loc: r.block_loc == null ? null : String(r.block_loc),
      truck_plate: r.truck_plate == null ? null : String(r.truck_plate),
      sacks: r.sacks == null ? null : Number(r.sacks),
      weight_kg: weight,
    });
  }
  return out;
}

/**
 * A candidate as `enrichPrices` wants it.
 *
 * `enrichPrices` reports its matches BY POSITION in the array it was handed, which is a
 * correct but silent contract — the day anything inside the matcher filters or reorders,
 * a positional read would price the wrong delivery and nothing would say so. `DeliveryRow`
 * carries an index signature, so the delivery id rides along under `_delivery_id` (the
 * matcher never looks at it) and the caller CHECKS it against the candidate it resolved
 * positionally. A mismatch skips the row rather than writing a price to a truckload the
 * matcher never saw.
 */
function toDeliveryRow(c: RepriceCandidate): DeliveryRow {
  return {
    transaction_date: c.transaction_date,
    supplier: c.supplier,
    batch_code: c.batch_code,
    operator_batch_label: null,
    block_loc: c.block_loc,
    truck_plate: c.truck_plate,
    sacks: c.sacks,
    weight_kg: c.weight_kg,
    cost_basis: null,
    remarks: null,
    lab_results: null,
    true_weight_kg: null,
    deduction_note: null,
    warnings: [],
    confidence: 1,
    // `_source_row` is what every note's `source_row` field reports. For a row that is
    // already IN the database there is no spreadsheet row to point at, so it names the
    // record instead — the identifier an operator can actually act on from RC IN.
    _source_row: 0,
    _delivery_id: c.id,
  };
}

/** Keep a file-level note only if this run has not already raised the same one. */
function dedupeAgainst(alreadyNoted: readonly PriceNote[], n: PriceNote): boolean {
  return !alreadyNoted.some(
    (p) => p.kind === n.kind && (p.looked_for ?? null) === (n.looked_for ?? null),
  );
}

/**
 * THE PASS. Never throws.
 *
 * Ordering note for the caller: run it AFTER `applyDeliveries`, so a row this very run
 * inserted unpriced is a candidate immediately rather than a day late, and BEFORE the
 * `unpriced_overdue` read, so that alarm reflects what this pass just fixed instead of
 * chasing rows the same run has priced.
 */
export async function repriceUnpricedDeliveries(deps: RepriceDeps): Promise<RepriceResult> {
  const { db, czarina } = deps;
  const emit = deps.progress;
  const runTs = deps.runTs ?? new Date().toISOString();
  const floor = minusDaysISO(manilaDate(runTs), REPRICE_LOOKBACK_DAYS);
  const since = deps.since < floor ? deps.since : floor;

  if (!czarina) return empty(false, since);

  let candidates: RepriceCandidate[];
  try {
    candidates = await readRepriceCandidates(db, since);
  } catch (err) {
    const res = empty(true, since);
    res.errors.push(
      `Could not read the deliveries that are still unpriced, so none of them could be ` +
        `re-priced from the price file this run: ${msg(err)}`,
    );
    return res;
  }

  if (!candidates.length) return empty(true, since);

  const rows = candidates.map(toDeliveryRow);
  let match;
  try {
    match = await enrichPrices(czarina.buf, rows, {
      aliases: deps.aliases,
      priceBands: deps.priceBands,
      filename: czarina.filename,
    });
  } catch (err) {
    const res = empty(true, since);
    res.considered = candidates.length;
    res.errors.push(
      `The price file could not be read while re-pricing ${candidates.length} unpriced ` +
        `deliver${candidates.length === 1 ? "y" : "ies"}: ${msg(err)}`,
    );
    return res;
  }

  const alreadyNoted = deps.alreadyNoted ?? [];
  const notes: PriceNote[] = [];
  const errors: string[] = [];
  for (const n of match.notes) {
    if (KEEP_ROW_NOTE.has(n.kind)) notes.push(n);
    else if (FILE_LEVEL_NOTE.has(n.kind) && dedupeAgainst(alreadyNoted, n)) notes.push(n);
    // everything else is deliberately dropped — see the header.
  }

  // -- write every match through the ONE sanctioned update path ---------------
  //
  // The ops are built from `match.matches` (the matcher's own per-row provenance), NOT by
  // re-scanning `rows` for a non-zero `cost_basis`: the two would agree today, and the day
  // they did not it would be this pass writing a price the matcher did not vouch for.
  const byId = new Map<
    string,
    { candidate: RepriceCandidate; provenance: PriceMatchProvenance }
  >();
  const ops: Array<Record<string, unknown>> = [];
  for (const m of match.matches) {
    const c = candidates[m.index];
    const matchedRow = rows[m.index];
    const price = matchedRow?.cost_basis;
    if (!c || !matchedRow) continue;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    // The positional contract, checked rather than assumed (see `toDeliveryRow`).
    if (matchedRow._delivery_id !== c.id) {
      errors.push(
        `Refused to write a price for the delivery on ${c.transaction_date}: the price ` +
          `matcher's row order did not line up with the rows it was given, so the rate ` +
          `could have landed on the wrong truckload. Nothing was written.`,
      );
      continue;
    }
    byId.set(c.id, { candidate: c, provenance: m });
    ops.push({ id: c.id, patch: { cost_basis: price } });
  }

  const res: RepriceResult = {
    ran: true,
    considered: candidates.length,
    priced: 0,
    since,
    tabs_read: match.tabs_loaded,
    months_requested: match.months_requested,
    notes,
    human_edits: [],
    learned: match.learned,
    errors,
  };

  if (!ops.length) return res;

  await emit?.(
    "apply",
    `Filling in the price on ${ops.length} deliver${ops.length === 1 ? "y" : "ies"} that ` +
      `were recorded without one…`,
    84,
  );

  let outcomes: Array<{ id: string; outcome: string }> = [];
  try {
    outcomes = await db.applyDeliveryUpstream(ops);
  } catch (err) {
    res.errors.push(
      `Found prices for ${ops.length} deliver${ops.length === 1 ? "y" : "ies"} that were ` +
        `recorded without one, but the database refused the update, so they are still ` +
        `unpriced: ${msg(err)}`,
    );
    return res;
  }

  for (const o of outcomes) {
    const hit = byId.get(o.id);
    if (!hit) continue;
    const { candidate: c } = hit;

    if (o.outcome === "human_edited") {
      // Someone claimed the row between the read and the write. The latch wins, and the
      // refusal is reported by the SAME constructor the email path uses — which redacts
      // `cost_basis` to its NAME, because the findings channel is not price-gated.
      res.human_edits.push(
        deliveryHumanEditNote("deliveries", o.id, c, [
          { field: "cost_basis", yours: null, sheet: null },
        ]),
      );
      continue;
    }
    if (o.outcome !== "applied") {
      res.errors.push(
        `The price found for the delivery on ${c.transaction_date}` +
          `${c.truck_plate ? ` (${c.truck_plate})` : ""} could not be saved — the database ` +
          `would not accept the change (${o.outcome}). The row is still unpriced; the next ` +
          `run will try again.`,
      );
      continue;
    }

    res.priced += 1;
    notes.push(repricedNote(c, hit.provenance, czarina.filename));

    // The audit trail for a row that already existed. `deliveries` fires its own audit
    // trigger on UPDATE, so the provenance is STAMPED onto that row (L-001 — never a
    // second row); the manual writer is the fallback for the case where the trigger row
    // cannot be found. Best-effort: a delivery that is now correctly priced must not be
    // un-done because writing WHY failed.
    try {
      const comment = repriceProvenance(c, hit.provenance, czarina.filename, runTs);
      const stamped = await db.stampIngestionAudit({
        tableName: "deliveries",
        recordId: o.id,
        comment,
      });
      if (!stamped) {
        await db.writeIngestionAudit({
          tableName: "deliveries",
          recordId: o.id,
          operation: "UPDATE",
          comment,
        });
      }
    } catch (err) {
      res.errors.push(
        `The delivery on ${c.transaction_date}` +
          `${c.truck_plate ? ` (${c.truck_plate})` : ""} was priced, but recording WHY in the ` +
          `history trail failed: ${msg(err)}`,
      );
    }
  }

  if (res.priced) {
    await emit?.(
      "apply",
      `Filled in the price on ${res.priced} deliver${res.priced === 1 ? "y" : "ies"} that ` +
        `had been recorded without one.`,
      86,
    );
  }
  return res;
}

/**
 * One row this pass priced. `info` — nothing is wrong, something was FIXED — but it is a
 * durable finding rather than a progress beat, because the sync changed a value on a row
 * that was already in the database and that is exactly the kind of write a person later
 * wants to be able to find. NEVER carries the ₱ value (the findings channel is not
 * price-gated): it names the truckload and where the rate came from.
 */
function repricedNote(
  c: RepriceCandidate,
  p: PriceMatchProvenance,
  filename: string,
): PriceNote {
  return {
    kind: "price_repriced",
    transaction_date: c.transaction_date,
    supplier: c.supplier,
    batch_code: c.batch_code,
    truck_plate: c.truck_plate,
    weight_kg: c.weight_kg,
    sacks: c.sacks,
    source_filename: filename,
    matched_sheet: p.sheet,
    matched_row: p.row,
    via: p.via,
    date_tolerance_days: p.date_tolerance_days,
    detail:
      `This delivery was recorded without a price and has now been priced from the price ` +
      `file — ${c.sacks ?? "?"} sacks / ${Math.round(c.weight_kg).toLocaleString("en-US")} kg ` +
      `on ${c.transaction_date}${c.truck_plate ? `, truck ${c.truck_plate}` : ""}` +
      `${c.batch_code ? `, pile ${c.batch_code}` : ""}, matched to "${p.sheet}" row ${p.row}. ` +
      `Nothing was wrong — a row that arrives through the Google Sheet carries no price, and ` +
      `until now only the emailed RC DELIVERIES report could trigger a price lookup, so a ` +
      `delivery that came in any other way was never priced by anyone. The rate is now in ` +
      `RC IN and the batch's average cost has been recalculated to include it.`,
  };
}

/** The provenance comment stamped onto the delivery's audit row. */
function repriceProvenance(
  c: RepriceCandidate,
  p: PriceMatchProvenance,
  filename: string,
  runTs: string,
): string {
  const where = ` from "${p.sheet}" row ${p.row} (matched on the ${p.via} key)`;
  return (
    `provenance=deliveries-reprice | Price back-filled by the sync re-price pass on ${runTs}: ` +
    `this delivery (${c.transaction_date}${c.truck_plate ? ` · ${c.truck_plate}` : ""}` +
    `${c.batch_code ? ` · ${c.batch_code}` : ""}) was carrying the unpriced placeholder ` +
    `(cost_basis=0, L-008) and was matched against "${filename}"${where}. Written through ` +
    `fn_apply_delivery_upstream, so a row a human had edited would have been refused.`
  );
}

/** The Asia/Manila calendar date for an instant — the plant's day, never UTC's. */
function manilaDate(runTs: string): string {
  const t = Date.parse(runTs);
  const base = Number.isFinite(t) ? t : Date.now();
  return new Date(base + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** ISO date minus N days (UTC arithmetic on a bare calendar date). */
function minusDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
