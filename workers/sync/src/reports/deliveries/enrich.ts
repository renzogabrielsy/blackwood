/**
 * enrich.ts — apply-phase price enrichment for RC DELIVERIES from Czarina's
 * "RAW CHARCOAL PURCHASES -Daily" workbook. TS port + hardening of
 * `.claude/skills/sync-ictc/scripts/enrich_prices.py` (read the Python as the
 * original spec). NOT part of the classify oracle: `build_oracle.py` never runs
 * enrich, and `cost_basis` is skipped in field_differences whenever the extracted
 * side is null, so nothing here is exercised by a parity fixture.
 *
 * ============================================================================
 * WHAT WENT WRONG, AND WHAT CHANGED (2026-08-07)
 * ============================================================================
 * The sync had priced ZERO August deliveries. Nine truckloads carried
 * `cost_basis = 0` for a week and dragged AUGUST-26-BLK1's average cost to ₱11.01
 * against a real ₱39.99. Four independent faults, all fixed here or in czarinaSheet.ts:
 *
 *  (a) TAB NAME. The caller generated "August 2026" and looked it up by EXACT
 *      match; her tab is "Aug. 2026". → czarinaSheet.ts resolves by (month, year).
 *  (b) SILENT WHOLE-FILE FAILURE. One bad tab name made `loadCzarinaRows` throw,
 *      and a bare `catch` in index.ts reported "Price file unavailable — proceeding
 *      without prices." The file WAS available. Because the file is loaded ONCE
 *      before the row loop, that single miss un-priced the ENTIRE run. → this
 *      module never throws for a tab problem: it returns `ok:false` plus a
 *      structured note naming the tab it wanted AND the tabs it found, which the
 *      caller raises as a real run finding. A tab miss is now the LOUDEST thing a
 *      deliveries run can report.
 *  (c) ONE MONTH ONLY. The caller loaded the tab for max(window date). The sync
 *      window is `watermark − 3 days`, so it straddles a month boundary on the 1st,
 *      2nd and 3rd of every month. → every month the window spans is loaded.
 *  (d) SUPPLIER VARIANTS. "Paquibot/Compra" (ours) vs "PAQUIBOT" (hers) never keyed
 *      equal. → both sides go through the `canonical_supplier()` mirror, which
 *      already knows that pair. L-010 covers PLATE typos; this class was uncovered.
 *
 * ============================================================================
 * IT HAPPENED AGAIN, THROUGH THE HOLE THE FIX ABOVE LEFT (2026-08-18, L-044)
 * ============================================================================
 * Four truckloads (2026-08-14, 69,900 kg) went in at cost_basis = 0 and the run
 * reported NOTHING. Not one note. The 2026-08-07 hardening was working exactly as
 * designed — on the wrong workbook.
 *
 * Czarina's price file is fetched by SENDER ONLY, and the clerk took the newest .xlsx
 * she had sent. On 2026-08-17 that was `BDO REQUISTION DETAILS & WEEKLY CHECK
 * ISSUANCE (REVISED)-2026.xlsx`, whose tabs include `AUGUST 2026`. So (a)'s semantic
 * resolver found a tab for August, was satisfied, and raised nothing; (b)'s loud
 * whole-file failure never fired because the file opened fine; (c) loaded every month
 * the window spanned, all from a cheque ledger. Then all four rows came back
 * `no_candidate` — "an ordinary unmatched row, not a finding" — and the run said
 * success.
 *
 * The lesson: VERIFYING THAT A NAME HAS THE RIGHT SHAPE IS NOT VERIFYING IT IS THE
 * RIGHT THING. Two changes, in two places, because either alone is insufficient:
 *
 *  (e) THE FILE IS NOW IDENTIFIED BY NAME, not merely by sender — `mailClerk.ts`,
 *      `MailQuery.attachmentMatches`. That is the fix; everything below is the alarm.
 *  (f) A 100% UNMATCHED RATE IS A LOUD FINDING — `price_no_row_matched`, below. ONE
 *      unmatched row is ordinary. EVERY row unmatched is not a row problem at all: it
 *      is the signature of the wrong workbook (or the right workbook whose month tab
 *      is a different document), and it is the ONLY symptom that survives when every
 *      other check is satisfied. It names the FILENAME and the TABS, because those are
 *      the two facts that were true, wrong, and invisible for two weeks.
 *
 * ============================================================================
 * THE MATCH LADDER — each rung is stricter about evidence than the last
 * ============================================================================
 *  1. EXACT   key = (canonical_supplier, plate[alnum-upper], weight[whole kg]).
 *             >1 candidate → closest in date drift (the Python's only tiebreak).
 *  2. ALIAS   the same key, but with our plate swapped for the spelling Czarina is
 *             KNOWN to use, from `public.delivery_source_aliases`. A typo confirmed
 *             once is a clean exact match forever after.
 *  3. FALLBACK key = (date ± tolerance, net weight, sacks), and ACCEPTED ONLY IF:
 *               i. the triple picks out exactly ONE Czarina row in scope, AND
 *              ii. the triple is unique among OUR rows in scope too, AND
 *             iii. at least one INDEPENDENT field corroborates — canonical supplier
 *                  equal, or plate shape a prefix/suffix or single-substitution
 *                  variant.
 *             Renzo measured (i): across 1,327 deliveries since Jan 2025 the triple
 *             is unique for 1,309, and all 9 colliding triples ARE known duplicate
 *             pairs — so uniqueness is simultaneously the safety property and a
 *             duplicate detector. A collision is REFUSED and reported, never picked.
 *             (iii) is a judgement added here: a lone unique (date, weight, sacks)
 *             hit whose plate AND supplier both disagree is a coincidence, not the
 *             same truckload.
 *
 * Plate shape is a TIE-BREAKER, NEVER A MATCHER — it only ever corroborates a hit
 * some other key already produced, and it is never used to build a lookup key.
 *
 * EVERY fuzzy match still ENRICHES, and is ALSO reported with both spellings side by
 * side ("bring it up in the sync but still proceed to enrich" — Renzo). Silence is
 * what cost nine truckloads.
 *
 * AFTER the match, the RESULT is sanity-checked against that supplier's recent price
 * band. This is the only check that can catch a match that passed every key test and
 * is still wrong.
 *
 * Pure + offline: no DB client, no I/O beyond the workbook Buffer it is handed.
 * Learned aliases come IN as data and newly-earned ones go OUT as data; the caller
 * owns persistence.
 */
import { loadWorkbook, type CellValue } from "../../lib/xlsx.js";
import { coerceDate } from "../../lib/norm.js";
import type { DeliveryRow } from "./extract.js";
import { canonicalSupplier, supplierAliasKey } from "./supplierCanon.js";
import { monthsSpanned, resolveCzarinaTab } from "./czarinaSheet.js";

// Czarina column layout (1-based), verified 2026-05-27, re-verified 2026-08-07.
const CZ_COL = {
  date: 1,
  supplier: 2,
  truck_plate: 3,
  sacks: 5,
  net_weight: 8,
  php_per_kg: 9,
} as const;

/** Data rows start at R5 (R3–R4 are the two header rows). */
const CZ_FIRST_DATA_ROW = 5;

/** Date tolerance ladder for the fallback. Czarina records the payment date, which is
 *  usually the delivery date but can be a day or two later. Tried in order; the FIRST
 *  tolerance that yields any candidate is the one that must be unique. */
const FALLBACK_DATE_TOLERANCES = [0, 1, 2] as const;

/** A plate shorter than this is too generic to corroborate anything by affix. */
const MIN_AFFIX_PLATE_LEN = 4;

/**
 * How far a Czarina row's date may sit from the delivery date on the EXACT/ALIAS rungs
 * before the match is refused. **This is the Python spec's own value** —
 * `enrich_prices.py::match_price(..., max_date_drift_days=7)` — not a number invented
 * here.
 *
 * WHY A BOUND AT ALL. The exact key is `(supplier, plate, weight)` and deliberately
 * carries NO date: the two files genuinely do not share a date key, because Czarina
 * records "Date of Del.paid" (the payment date, typically the delivery date or a day
 * or two after). A date-free key is therefore correct — but UNBOUNDED it will happily
 * price an August delivery from a December row, since a regular hauler running a full
 * load for the same supplier reproduces the same triple month after month.
 *
 * WHY 7 DAYS SEPARATES THE TWO CASES CLEANLY, measured on the real workbook
 * (1,347 rows, 24 tabs, 2026-08-07):
 *   - 34 exact keys have more than one Czarina row.
 *   - ALL 34 of those pairs are more than 7 days apart; NONE are within 7 days.
 *   - Their prices differ materially (e.g. PAQUIBOT/AAV6111/18,065 kg appears on
 *     "Aug. 2026" at ₱40.00 and on "Dec. 25." at ₱46.75 — 233 days and ₱6.75/kg apart).
 *   - All ten of the deliveries Renzo confirmed on 2026-08-07 matched at drift 0.
 * So the bound costs no real match and every case it excludes is a different truckload.
 *
 * WHY REFUSE RATHER THAN WARN. The Python warned on stdout and applied the price
 * anyway, which is defensible for a CLI a human is watching. In the worker nothing
 * watches stdout — that is precisely how "Price file unavailable" hid an un-priced
 * month for a week. Worse, the drift case usually arises when the delivery's OWN month
 * has no tab, so applying it would contradict the `price_tab_unresolved` note the same
 * run just raised. The price also flows into `batches.avg_cost` and the liquidation
 * figures, so a months-stale rate is not a cosmetic error.
 *
 * The FALLBACK rung is unaffected: it already bounds drift at ≤2 days (see
 * FALLBACK_DATE_TOLERANCES), which is stricter than this.
 */
const MAX_DATE_DRIFT_DAYS = 7;

interface CzarinaRow {
  _sheet: string;
  _source_row: number;
  date: string | null;
  supplier_raw: string;
  supplier_canon: string;
  supplier_alias_key: string;
  truck_raw: string;
  truck_norm: string | null;
  sacks: number | null;
  net_weight: number;
  php_per_kg: number;
}

/** One learned spelling pair from `public.delivery_source_aliases`. */
export interface SourceAlias {
  kind: "truck_plate" | "supplier";
  /** OUR value, already normalized (plates: alnum-upper; suppliers: UPPER(TRIM)). */
  ours: string;
  /** Czarina's value, same normalization. */
  theirs: string;
}

/** A pair this run EARNED and the caller should persist. */
export interface EarnedAlias {
  kind: "truck_plate" | "supplier";
  ours: string;
  theirs: string;
  ours_raw: string;
  theirs_raw: string;
  evidence: string;
  seen_on: string | null;
}

/** A supplier's recent observed ₱/kg band, from priced history. */
export interface PriceBand {
  min: number;
  max: number;
  /** Sample size. The band is only trusted at or above MIN_BAND_SAMPLES. */
  n: number;
}

/** Fewer priced samples than this and the band is not evidence of anything. */
export const MIN_BAND_SAMPLES = 3;

/** How far outside the observed band a price may sit before it is called out. */
const BAND_SLACK = 0.1; // ±10%

export type PriceNoteKind =
  | "price_tab_unresolved"
  | "price_tab_ambiguous"
  | "price_file_unreadable"
  | "price_file_missing"
  | "price_no_row_matched"
  | "price_fuzzy_match"
  | "price_fuzzy_ambiguous"
  | "price_date_drift"
  | "price_out_of_band"
  | "price_overdue_check_failed";

/**
 * One thing the price step wants a human to see. NEVER carries a ₱/cost value — the
 * run-findings channel is not price-gated, so an out-of-band note describes the
 * deviation qualitatively and identifies the ROW; the number itself stays in RC IN
 * behind `canViewPrices()`.
 */
export interface PriceNote {
  kind: PriceNoteKind;
  /** Plain-English specifics for the finding's reason line. */
  detail: string;
  // -- the affected delivery (identity only, no ₱) --------------------------
  transaction_date?: string | null;
  supplier?: string | null;
  batch_code?: string | null;
  truck_plate?: string | null;
  weight_kg?: number | null;
  sacks?: number | null;
  source_row?: string | number | null;
  // -- a spelling disagreement, both sides ---------------------------------
  field?: "truck_plate" | "supplier";
  our_value?: string | null;
  their_value?: string | null;
  /** Every field that differed, so one note can carry plate AND supplier. */
  differences?: Array<{ field: "truck_plate" | "supplier"; ours: string; theirs: string }>;
  // -- where the price came from -------------------------------------------
  matched_sheet?: string | null;
  matched_row?: number | null;
  date_tolerance_days?: number | null;
  /** How the match was made, for the finding's wording. */
  via?: "exact" | "alias" | "fallback";
  // -- tab-level failure ---------------------------------------------------
  looked_for?: string | null;
  tabs_found?: string[];
  candidates?: string[];
  // -- file-level identity (L-044): WHICH workbook, and WHICH tabs it read ---
  /** The attachment filename the run actually used. The fact nobody could see. */
  source_filename?: string | null;
  /** The worksheet tabs that resolved and were read, in the order requested. */
  tabs_loaded?: string[];
  /** How many priceable rows were read out of those tabs. 0 = the tab is empty. */
  rows_loaded?: number | null;
  /** How many of OUR deliveries the run tried to price. */
  rows_considered?: number | null;
  // -- refusal bookkeeping -------------------------------------------------
  collided_on?: "czarina" | "ours";
  collisions?: Array<{ sheet?: string; row: string | number; date?: string | null }>;
}

export interface EnrichDeps {
  /** Learned spelling pairs (rung 2 of the ladder). */
  aliases?: readonly SourceAlias[];
  /** canonical supplier → recent observed ₱/kg band (the result sanity check). */
  priceBands?: ReadonlyMap<string, PriceBand>;
  /**
   * The attachment filename this Buffer came from (L-044). Purely for the NOTES: the
   * matcher never reads it. A workbook that is the wrong document is identified to a
   * human by its NAME, and this module is handed bytes — so the caller, which knows the
   * manifest, must pass the name in or the loudest finding here cannot say what it read.
   */
  filename?: string | null;
}

export interface CzarinaMatch {
  /** FALSE only when the price file could not be used AT ALL (unreadable, or not one
   *  requested month resolved to a tab). A partial failure — some months resolved,
   *  some did not — stays `ok:true` with notes, because the months that did resolve
   *  were still priced correctly. */
  ok: boolean;
  czarina_rows_loaded: number;
  matched_count: number;
  unmatched_count: number;
  exact_match_count: number;
  alias_match_count: number;
  fallback_match_count: number;
  /** Worksheet names actually loaded, in the order requested. */
  tabs_loaded: string[];
  /** (year, month) pairs the window spanned, as "YYYY-MM". */
  months_requested: string[];
  notes: PriceNote[];
  learned: EarnedAlias[];
}

// ---------------------------------------------------------------------------
// Normalizers (VERBATIM from the Python, except supplier — see the header, (d))
// ---------------------------------------------------------------------------

/** norm_truck: strip whitespace/hyphen/underscore, uppercase. (Python parity.) */
export function normTruck(s: CellValue): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/[\s\-_]/g, "").toUpperCase();
  return t ? t : null;
}

/** norm_weight: round to whole kg for matching. (Python parity.) */
export function normWeight(v: CellValue): number | null {
  if (v === null || v === undefined) return null;
  const f = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(f)) return null;
  return Math.round(f);
}

/** Whole-count sacks, or null when absent/unreadable. */
function normSacks(v: CellValue): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const f = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(f)) return null;
  return Math.round(f);
}

function dateDiffDays(a: string | null, b: string | null): number {
  if (!a || !b) return Infinity;
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.abs((da - db) / 86400000);
}

// ---------------------------------------------------------------------------
// Plate shape — a TIE-BREAKER, never a matcher.
// ---------------------------------------------------------------------------

export type PlateShape = "exact" | "affix" | "substitution" | null;

/**
 * How close two normalized plates are. Deliberately only three verdicts:
 *   exact         — identical after normalization.
 *   affix         — one is a prefix or suffix of the other ("T138003" vs "138003"),
 *                   with the shorter side long enough not to be generic.
 *   substitution  — same length, exactly one character differs ("ALA3958" vs
 *                   "ALA9958").
 * Anything else is `null` — NOT a near miss, just different. No edit-distance
 * generalization, no transposition, no insertion: every extra rule is another way to
 * accept a truck that does not exist.
 */
export function platesCorroborate(a: string | null, b: string | null): PlateShape {
  if (!a || !b) return null;
  if (a === b) return "exact";

  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= MIN_AFFIX_PLATE_LEN && (long.startsWith(short) || long.endsWith(short))) {
    return "affix";
  }

  if (a.length === b.length) {
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        diffs++;
        if (diffs > 1) return null;
      }
    }
    if (diffs === 1) return "substitution";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Read one already-resolved worksheet into CzarinaRows. Skips subtotal rows. */
function readCzarinaSheet(
  ws: { name: string; rowCount: number; cell(r: number, c: number): CellValue },
): CzarinaRow[] {
  const rows: CzarinaRow[] = [];
  let lastSeenDate: string | null = null;

  for (let r = CZ_FIRST_DATA_ROW; r < ws.rowCount + 1; r++) {
    const supplier = ws.cell(r, CZ_COL.supplier);
    if (supplier === null || supplier === undefined || String(supplier).trim() === "") continue;
    const sl = String(supplier).trim().toLowerCase();
    if (sl === "average" || sl === "total" || sl === "sum") continue;

    // Date carry-forward: her sheet writes the date once per delivery day and leaves
    // "-" (or blank) on the rest of that day's trucks. Python parity.
    let dateStr = coerceDate(ws.cell(r, CZ_COL.date));
    if (dateStr === null) dateStr = lastSeenDate;
    else lastSeenDate = dateStr;

    const netWeight = normWeight(ws.cell(r, CZ_COL.net_weight));
    if (netWeight === null || netWeight <= 0) continue;

    const phpRaw = ws.cell(r, CZ_COL.php_per_kg);
    if (phpRaw === null || phpRaw === undefined) continue;
    const php = typeof phpRaw === "number" ? phpRaw : Number(String(phpRaw));
    if (!Number.isFinite(php)) continue;

    const truckRaw = String(ws.cell(r, CZ_COL.truck_plate) ?? "").trim();
    rows.push({
      _sheet: ws.name,
      _source_row: r,
      date: dateStr,
      supplier_raw: String(supplier).trim(),
      supplier_canon: canonicalSupplier(String(supplier)),
      supplier_alias_key: supplierAliasKey(String(supplier)),
      truck_raw: truckRaw,
      truck_norm: normTruck(truckRaw),
      sacks: normSacks(ws.cell(r, CZ_COL.sacks)),
      net_weight: netWeight,
      php_per_kg: php,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

function exactKey(supplierCanon: string, truck: string | null, weight: number | null): string {
  return JSON.stringify([supplierCanon, truck, weight]);
}

function tripleKey(weight: number | null, sacks: number | null): string {
  return JSON.stringify([weight, sacks]);
}

/** push into a Map<string, T[]>, creating the bucket on first use. */
function bucket<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

// ---------------------------------------------------------------------------
// The public entrypoint
// ---------------------------------------------------------------------------

/**
 * Enrich `rows` IN PLACE: set `cost_basis` on every row a Czarina price matches.
 * Never throws for a data problem — a failure comes back as `ok:false` + notes so the
 * caller can raise it loudly. Only a genuinely corrupt Buffer surfaces as `ok:false`
 * with a `price_file_unreadable` note.
 */
export async function enrichPrices(
  czarinaBuf: Buffer,
  rows: DeliveryRow[],
  deps: EnrichDeps = {},
): Promise<CzarinaMatch> {
  const notes: PriceNote[] = [];
  const learned: EarnedAlias[] = [];
  const months = monthsSpanned(rows.map((r) => String(r.transaction_date)));
  const monthsRequested = months.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`);

  const base = (): CzarinaMatch => ({
    ok: false,
    czarina_rows_loaded: 0,
    matched_count: 0,
    unmatched_count: rows.length,
    exact_match_count: 0,
    alias_match_count: 0,
    fallback_match_count: 0,
    tabs_loaded: [],
    months_requested: monthsRequested,
    notes,
    learned,
  });

  // -- open the workbook ----------------------------------------------------
  let sheetNames: string[];
  let wb: Awaited<ReturnType<typeof loadWorkbook>>;
  try {
    wb = await loadWorkbook(czarinaBuf);
    sheetNames = wb.sheetNames;
  } catch (err) {
    notes.push({
      kind: "price_file_unreadable",
      detail:
        `Czarina's price workbook could not be opened: ` +
        `${err instanceof Error ? err.message : String(err)}. No delivery was priced.`,
    });
    return base();
  }

  // -- resolve + load every month the window spans (fault (c)) --------------
  const czarinaRows: CzarinaRow[] = [];
  const tabsLoaded: string[] = [];
  let anyMonthResolved = false;

  for (const { year, month } of months) {
    const res = resolveCzarinaTab(sheetNames, year, month);
    if (!res.ok) {
      // Fault (a)+(b): say EXACTLY what was wanted and EXACTLY what is there.
      notes.push(
        res.reason === "ambiguous"
          ? {
              kind: "price_tab_ambiguous",
              looked_for: res.looked_for,
              candidates: res.candidates,
              tabs_found: res.available,
              detail:
                `Czarina's price file has ${res.candidates.length} tabs that all mean ` +
                `${res.looked_for} (${res.candidates.join(", ")}). Refusing to guess which one ` +
                `is the real month — deliveries in ${res.looked_for} were left unpriced. ` +
                `Remove or rename the duplicate tab and re-run.`,
            }
          : {
              kind: "price_tab_unresolved",
              looked_for: res.looked_for,
              tabs_found: res.available,
              detail:
                `Czarina's price file has NO tab for ${res.looked_for}, so every delivery in ` +
                `that month was left unpriced. The file itself opened fine. Tabs it does have: ` +
                `${res.available.join(", ")}.`,
            },
      );
      continue;
    }
    const ws = wb.sheet(res.tab.name);
    if (!ws) {
      // Should be unreachable (the name came from this workbook), but never assume.
      const ym = `${year}-${String(month).padStart(2, "0")}`;
      notes.push({
        kind: "price_tab_unresolved",
        looked_for: ym,
        tabs_found: sheetNames,
        detail:
          `Czarina's tab "${res.tab.name}" was matched for ${ym} but could not be opened. ` +
          `Deliveries in that month were left unpriced.`,
      });
      continue;
    }
    anyMonthResolved = true;
    tabsLoaded.push(res.tab.name);
    czarinaRows.push(...readCzarinaSheet(ws));
  }

  if (!anyMonthResolved) {
    // Every month failed → the file was effectively unusable for this run.
    return { ...base(), tabs_loaded: tabsLoaded, czarina_rows_loaded: 0 };
  }

  // -- build the indexes ---------------------------------------------------
  const byExact = new Map<string, CzarinaRow[]>();
  const byTriple = new Map<string, CzarinaRow[]>();
  for (const r of czarinaRows) {
    bucket(byExact, exactKey(r.supplier_canon, r.truck_norm, r.net_weight), r);
    bucket(byTriple, tripleKey(r.net_weight, r.sacks), r);
  }

  // OUR-side (weight, sacks, date) multiplicity — the other half of the uniqueness
  // gate. If two of our rows share the triple we cannot tell which one a single
  // Czarina row belongs to, so neither may take the price.
  const ourTriple = new Map<string, DeliveryRow[]>();
  for (const r of rows) {
    bucket(
      ourTriple,
      JSON.stringify([
        String(r.transaction_date).slice(0, 10),
        normWeight(r.weight_kg as CellValue),
        normSacks(r.sacks as CellValue),
      ]),
      r,
    );
  }

  // Plate aliases, keyed OUR value → the spellings Czarina is known to use.
  const plateAliases = new Map<string, string[]>();
  for (const a of deps.aliases ?? []) {
    if (a.kind !== "truck_plate") continue;
    const arr = plateAliases.get(a.ours);
    if (arr) arr.push(a.theirs);
    else plateAliases.set(a.ours, [a.theirs]);
  }

  // -- match ----------------------------------------------------------------
  let matched = 0;
  let unmatched = 0;
  let exactHits = 0;
  let aliasHits = 0;
  let fallbackHits = 0;

  for (const row of rows) {
    const ourDate = String(row.transaction_date).slice(0, 10);
    const ourCanon = canonicalSupplier(row.supplier);
    const ourPlate = normTruck(row.truck_plate as CellValue);
    const ourWeight = normWeight(row.weight_kg as CellValue);
    const ourSacks = normSacks(row.sacks as CellValue);

    const identity = {
      transaction_date: ourDate,
      supplier: row.supplier ?? null,
      batch_code: row.batch_code ?? null,
      truck_plate: row.truck_plate ?? null,
      weight_kg: ourWeight,
      sacks: ourSacks,
      source_row: (row._source_row as string | number | undefined) ?? null,
    };

    // ---- rung 1: EXACT --------------------------------------------------
    // `pickByDate` returns the closest candidate AND its drift; the drift is what
    // separates "Czarina paid this a day late" from "this is a different truckload
    // from another month that happens to share the key" (see MAX_DATE_DRIFT_DAYS).
    let best = pickByDate(byExact.get(exactKey(ourCanon, ourPlate, ourWeight)) ?? [], ourDate);
    let via: "exact" | "alias" | "fallback" = "exact";

    // ---- rung 2: a LEARNED plate alias ----------------------------------
    if (!best && ourPlate) {
      for (const theirPlate of plateAliases.get(ourPlate) ?? []) {
        const cand = pickByDate(byExact.get(exactKey(ourCanon, theirPlate, ourWeight)) ?? [], ourDate);
        if (cand) {
          best = cand;
          via = "alias";
          break;
        }
      }
    }

    // A keyed candidate too far away in time is REFUSED, loudly. It is not an ordinary
    // unmatched row (the key DID hit), and it must not silently fall through to the
    // fallback rung either — the fallback's own ≤2-day tolerance would reject it anyway,
    // and reporting it here says something far more useful: "her file has this exact
    // truck+weight, but months away".
    let hit: CzarinaRow | null = null;
    if (best) {
      if (best.driftDays <= MAX_DATE_DRIFT_DAYS) {
        hit = best.row;
      } else {
        notes.push({
          ...identity,
          kind: "price_date_drift",
          via,
          matched_sheet: best.row._sheet,
          matched_row: best.row._source_row,
          date_tolerance_days: best.driftDays,
          detail:
            `Could not price this delivery: Czarina's file DOES have a row for this supplier, ` +
            `plate and weight ("${best.row._sheet}" row ${best.row._source_row}, dated ` +
            `${best.row.date ?? "no date"}), but it is ${best.driftDays} days away from this ` +
            `delivery — far too long to be her usual payment lag of a day or two. A regular ` +
            `truck hauling the same full load for the same supplier looks identical month after ` +
            `month, so this is almost certainly a DIFFERENT trip at a different rate. Nothing ` +
            `was priced. Check whether this delivery is missing from her file, or whether her ` +
            `tab for ${ourDate.slice(0, 7)} is named unusually.`,
        });
      }
    }

    // ---- rung 3: the uniqueness-gated (date, weight, sacks) fallback ----
    let fallbackTolerance: number | null = null;
    if (!hit) {
      const gate = tryFallback({
        row,
        ourDate,
        ourCanon,
        ourPlate,
        ourWeight,
        ourSacks,
        byTriple,
        ourTriple,
      });
      if (gate.kind === "match") {
        hit = gate.czarina;
        via = "fallback";
        fallbackTolerance = gate.tolerance;
      } else if (gate.kind === "refused") {
        notes.push({ ...identity, ...gate.note });
      }
      // gate.kind === "no_candidate" → an ordinary unmatched row, not a finding.
    }

    if (!hit) {
      unmatched++;
      continue;
    }

    // ---- accept ----------------------------------------------------------
    row.cost_basis = hit.php_per_kg;
    matched++;
    if (via === "exact") exactHits++;
    else if (via === "alias") aliasHits++;
    else fallbackHits++;

    // Every spelling difference gets surfaced with BOTH values, on every rung —
    // including an exact-key match whose plate differs only because an alias made
    // the key line up. "Bring it up in the sync but still proceed to enrich."
    const differences: Array<{ field: "truck_plate" | "supplier"; ours: string; theirs: string }> = [];
    if (ourPlate && hit.truck_norm && ourPlate !== hit.truck_norm) {
      differences.push({
        field: "truck_plate",
        ours: String(row.truck_plate ?? ourPlate),
        theirs: hit.truck_raw || hit.truck_norm,
      });
    }
    if (supplierAliasKey(row.supplier) !== hit.supplier_alias_key) {
      differences.push({
        field: "supplier",
        ours: String(row.supplier ?? ""),
        theirs: hit.supplier_raw,
      });
    }

    if (differences.length) {
      const shapeWord =
        via === "alias"
          ? "a spelling this sync has already confirmed before"
          : via === "fallback"
            ? "the delivery date, net weight and sack count, which picked out exactly one of her rows"
            : "the supplier, plate and weight";
      notes.push({
        ...identity,
        kind: "price_fuzzy_match",
        via,
        matched_sheet: hit._sheet,
        matched_row: hit._source_row,
        date_tolerance_days: fallbackTolerance,
        differences,
        field: differences[0].field,
        our_value: differences[0].ours,
        their_value: differences[0].theirs,
        detail:
          `Priced from Czarina's "${hit._sheet}" row ${hit._source_row}, matched on ${shapeWord}. ` +
          `Her sheet spells it differently: ` +
          differences.map((d) => `${d.field} "${d.ours}" (ours) vs "${d.theirs}" (hers)`).join("; ") +
          `. The price WAS applied — please confirm the two records are the same truckload.`,
      });

      // LEARN the pair — but only from a fallback/alias match, i.e. one whose identity
      // was corroborated independently. An exact-key match that merely canonicalized a
      // supplier name taught us nothing new (canonical_supplier already knew it).
      if (via === "fallback") {
        for (const d of differences) {
          const ours = d.field === "truck_plate" ? ourPlate : supplierAliasKey(row.supplier);
          const theirs = d.field === "truck_plate" ? hit.truck_norm : hit.supplier_alias_key;
          if (!ours || !theirs || ours === theirs) continue;
          learned.push({
            kind: d.field,
            ours,
            theirs,
            ours_raw: d.ours,
            theirs_raw: d.theirs,
            evidence:
              `Earned by the sync on a uniqueness-gated fallback match: RC DELIVERIES ${ourDate} ` +
              `${row.supplier ?? "?"} ${ourWeight ?? "?"} kg / ${ourSacks ?? "?"} sacks ` +
              `(batch ${row.batch_code ?? "?"}) matched EXACTLY ONE row in Czarina's ` +
              `"${hit._sheet}" tab (row ${hit._source_row}) on date+weight+sacks, corroborated by ` +
              `${d.field === "truck_plate" ? "the supplier name" : "the plate"}.`,
            seen_on: ourDate,
          });
        }
      }
    }

    // ---- (h) sanity-check the RESULT, not just the key -------------------
    const band = deps.priceBands?.get(ourCanon);
    if (band && band.n >= MIN_BAND_SAMPLES) {
      const lo = band.min * (1 - BAND_SLACK);
      const hi = band.max * (1 + BAND_SLACK);
      if (hit.php_per_kg < lo || hit.php_per_kg > hi) {
        notes.push({
          ...identity,
          kind: "price_out_of_band",
          via,
          matched_sheet: hit._sheet,
          matched_row: hit._source_row,
          detail:
            `The price matched from Czarina's "${hit._sheet}" row ${hit._source_row} is OUTSIDE ` +
            `the range this supplier's last ${band.n} priced deliveries fall in. The match itself ` +
            `looked clean, so either her sheet has a typo in that row, or the row belongs to a ` +
            `different truckload. The price WAS applied — check it in RC IN.`,
        });
      }
    }
  }

  // -- (f) EVERY row unmatched is a FILE problem, not a row problem (L-044) --
  //
  // WHY 100% AND NOT A PERCENTAGE. A partial miss is normal and already covered: her
  // file records the PAYMENT date, so yesterday's trucks legitimately are not in it yet,
  // and the honest per-row alarm for that is `unpriced_overdue` — which is time-based,
  // names the specific truckload, and escalates. Any threshold between those two is a
  // number invented to feel safe, and a threshold that fires on a normal day is how an
  // operator learns to stop reading this list. 100% is the only line that means
  // something structural: the window is `watermark − 3 days`, so it always contains
  // several days of deliveries that ARE in her file — for not one of them to match, the
  // workbook we opened is not the price list, or its month tab is a different document.
  // Measured: on 2026-08-17 this condition was TRUE and nothing said so.
  //
  // Guarded on `czarinaRows.length` only for the wording — an EMPTY resolved tab is
  // just as alarming as a full wrong one, so it still fires, and `rows_loaded` says which.
  if (rows.length > 0 && matched === 0) {
    const where = tabsLoaded.length ? `"${tabsLoaded.join('", "')}"` : "no tab";
    notes.push({
      kind: "price_no_row_matched",
      source_filename: deps.filename ?? null,
      tabs_loaded: tabsLoaded,
      tabs_found: sheetNames,
      looked_for: monthsRequested.join(", "),
      rows_loaded: czarinaRows.length,
      rows_considered: rows.length,
      detail:
        `NOT ONE of the ${rows.length} deliveries in this window could be matched to the ` +
        `price file, so every one of them was left unpriced. The file opened fine and ` +
        `${where} resolved for ${monthsRequested.join(", ")}, holding ${czarinaRows.length} ` +
        `priceable row(s) — so this is not a spelling problem in one row; either the ` +
        `workbook that was used is not the price list, or that tab is not the daily ` +
        `purchase log. The file used was ` +
        `"${deps.filename ?? "(filename not recorded)"}". Check it is ` +
        `"RAW CHARCOAL PURCHASES -Daily" and not another workbook from the same sender.`,
    });
  }

  return {
    ok: true,
    czarina_rows_loaded: czarinaRows.length,
    matched_count: matched,
    unmatched_count: unmatched,
    exact_match_count: exactHits,
    alias_match_count: aliasHits,
    fallback_match_count: fallbackHits,
    tabs_loaded: tabsLoaded,
    months_requested: monthsRequested,
    notes,
    learned,
  };
}

/**
 * >1 candidate → closest in date drift. The Python's only tiebreak, preserved — but it
 * now also RETURNS the winning drift, because the tiebreak alone cannot tell "the only
 * candidate is a day late" from "the only candidate is four months away". The caller
 * enforces MAX_DATE_DRIFT_DAYS; measuring and deciding are kept separate so this stays
 * a pure ranking function.
 *
 * A candidate with no readable date scores `Infinity`, so it loses every tiebreak and is
 * refused by the bound — an undated row cannot corroborate a date.
 */
function pickByDate(
  candidates: CzarinaRow[],
  ourDate: string,
): { row: CzarinaRow; driftDays: number } | null {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort(
    (a, b) => dateDiffDays(ourDate, a.date) - dateDiffDays(ourDate, b.date),
  );
  return { row: ranked[0], driftDays: dateDiffDays(ourDate, ranked[0].date) };
}

/** The refusal payload, minus the row-identity fields the caller spreads in. */
type PartialNote = Partial<PriceNote> & { kind: PriceNoteKind; detail: string };

type FallbackOutcome =
  | { kind: "match"; czarina: CzarinaRow; tolerance: number }
  | { kind: "refused"; note: PartialNote }
  | { kind: "no_candidate" };

/**
 * Rung 3. Returns a match ONLY when the (date ± tolerance, weight, sacks) triple is
 * unique on BOTH sides and one independent field corroborates. Every refusal comes
 * back as a note, because a refused fallback is exactly the case a human needs to
 * look at (and, per Renzo's measurement, is usually a duplicate row).
 */
function tryFallback(args: {
  row: DeliveryRow;
  ourDate: string;
  ourCanon: string;
  ourPlate: string | null;
  ourWeight: number | null;
  ourSacks: number | null;
  byTriple: Map<string, CzarinaRow[]>;
  ourTriple: Map<string, DeliveryRow[]>;
}): FallbackOutcome {
  const { row, ourDate, ourCanon, ourPlate, ourWeight, ourSacks, byTriple, ourTriple } = args;

  // The triple must actually EXIST. A missing sack count is not a key.
  if (ourWeight === null || ourSacks === null) return { kind: "no_candidate" };

  // (ii) OUR side must be unique. Two of our deliveries sharing (date, weight, sacks)
  // is the duplicate-pair signature Renzo measured — refuse both, name the twin.
  const mine = ourTriple.get(JSON.stringify([ourDate, ourWeight, ourSacks])) ?? [];
  if (mine.length > 1) {
    return {
      kind: "refused",
      note: {
        kind: "price_fuzzy_ambiguous",
        collided_on: "ours",
        collisions: mine.map((m) => ({
          row: (m._source_row as string | number | undefined) ?? "?",
          date: String(m.transaction_date).slice(0, 10),
        })),
        detail:
          `Could not price this delivery: its supplier/plate/weight did not match Czarina's file, ` +
          `and the fallback (same date, net weight and sack count) matches ${mine.length} rows in ` +
          `OUR OWN report — so there is no way to tell which one her price belongs to. This is ` +
          `usually a duplicated row: check whether ${ourWeight} kg / ${ourSacks} sacks on ${ourDate} ` +
          `was really delivered twice. Nothing was priced.`,
      },
    };
  }

  // (i) HER side: walk the tolerance ladder; the first level with any candidate is the
  // level that must be unique. Widening after a hit would only manufacture ambiguity.
  const pool = byTriple.get(tripleKey(ourWeight, ourSacks)) ?? [];
  if (pool.length === 0) return { kind: "no_candidate" };

  for (const tol of FALLBACK_DATE_TOLERANCES) {
    const cands = pool.filter((c) => dateDiffDays(ourDate, c.date) <= tol);
    if (cands.length === 0) continue;

    if (cands.length > 1) {
      return {
        kind: "refused",
        note: {
          kind: "price_fuzzy_ambiguous",
          collided_on: "czarina",
          date_tolerance_days: tol,
          collisions: cands.map((c) => ({ sheet: c._sheet, row: c._source_row, date: c.date })),
          detail:
            `Could not price this delivery: its supplier/plate/weight did not match Czarina's file, ` +
            `and the fallback (same date, net weight and sack count) matches ${cands.length} of HER ` +
            `rows (${cands.map((c) => `"${c._sheet}" row ${c._source_row}`).join(", ")}). Refusing ` +
            `to guess which is the right one. Nothing was priced.`,
        },
      };
    }

    // (iii) Exactly one candidate — now require an INDEPENDENT corroborating field.
    const c = cands[0];
    const plateShape = platesCorroborate(ourPlate, c.truck_norm);
    const supplierAgrees = ourCanon === c.supplier_canon;
    if (!plateShape && !supplierAgrees) {
      return {
        kind: "refused",
        note: {
          kind: "price_fuzzy_ambiguous",
          collided_on: "czarina",
          date_tolerance_days: tol,
          collisions: [{ sheet: c._sheet, row: c._source_row, date: c.date }],
          differences: [
            { field: "truck_plate", ours: String(row.truck_plate ?? ""), theirs: c.truck_raw },
            { field: "supplier", ours: String(row.supplier ?? ""), theirs: c.supplier_raw },
          ],
          detail:
            `Could not price this delivery: the only row in Czarina's file with the same date, net ` +
            `weight and sack count ("${c._sheet}" row ${c._source_row}) names a DIFFERENT supplier ` +
            `AND a different plate — hers says ${c.supplier_raw} / ${c.truck_raw || "(no plate)"}, ` +
            `ours says ${row.supplier ?? "?"} / ${row.truck_plate ?? "(no plate)"}. Matching weight ` +
            `and sacks alone is a coincidence, not the same truckload. Nothing was priced.`,
        },
      };
    }

    return { kind: "match", czarina: c, tolerance: tol };
  }

  return { kind: "no_candidate" };
}
