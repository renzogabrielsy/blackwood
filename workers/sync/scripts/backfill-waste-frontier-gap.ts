/**
 * backfill-waste-frontier-gap.ts — ONE-OFF repair for L-052 (2026-09-17).
 *
 * WHAT WENT WRONG. `reports/production/index.ts::runReport` computed ONE `since` from
 * `db.productionRunsFrontier()` — MC's frontier — and handed it to BOTH extractors.
 * `extractIvy`'s per-row filter is `txnIso <= since -> continue`: EXCLUSIVE and SILENT.
 * Ivy's WASTE PRODUCTION REPORT is CUMULATIVE and always lands later than MC's daily
 * report, so the moment MC's frontier crossed a day Ivy had not yet filed, that day's
 * waste was skipped with no finding, no hold and no log line — and a frontier only moves
 * forward, so no later run could ever retry it.
 *
 * Waste now has its own frontier and any remaining gap is raised as a finding
 * (`wasteGap.ts`). This script repairs what was already lost. Measured on the live
 * workbook: FIVE waste days never written, plus ONE shift holding the WRONG row.
 *
 * FIVE RULES IT OBEYS, each for a reason:
 *
 *  1. **It writes through the SAME doors the sync uses, never a bare UPDATE.** A new row
 *     goes in with `insertIfAbsent(natural_key=(shift_id,))` — the apply path's own guard,
 *     so running this twice inserts nothing the second time. A replacement goes through
 *     `fn_apply_production_upstream`, whose UPDATE carries `human_edited_at IS NULL` in its
 *     OWN WHERE: a row a person edited in the app comes back `human_edited`, is LISTED, and
 *     is left exactly as it is. (An instruction only counts if it is a predicate in a WHERE
 *     clause.)
 *  2. **Every write leaves an audit row** via `write_ingestion_audit`, carrying the
 *     before/after and `provenance=backfill-L052`.
 *  3. **It never invents a shift.** A row whose `(date, batch, shift)` triplet matches no
 *     `production_shifts` row is REPORTED, not created — this script exists to fill holes
 *     the sync made, not to open days nothing else reported. (Measured: 0 of 226.)
 *  4. **A REPLACE needs a STREAM to differ.** 140 of the workbook's rows differ from the
 *     database only in `remarks` (a buyer note the early-2026 rows were written without);
 *     rewriting those would be a mass edit of history smuggled in beside a repair. Exactly
 *     ONE row has a real disagreement: the 2026-08-01 AUGUST shift, which holds JULY's
 *     590.5 kg carryover instead of AUGUST's own 993.5 kg opening day — the L-046 collision
 *     that was held `already_exists` and never resolved.
 *  5. **`--dry-run` is the DEFAULT.** `--apply` writes. Both print the same table.
 *
 * Usage (from workers/sync):
 *   npx tsx scripts/backfill-waste-frontier-gap.ts            # dry run (default)
 *   npx tsx scripts/backfill-waste-frontier-gap.ts --apply
 *   npx tsx scripts/backfill-waste-frontier-gap.ts --from 2026-01-01 --apply
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { DbClient, type Row } from "../src/lib/db.js";
import { loadProductionWorkbook } from "../src/reports/production/sheet.js";
import { extractIvy, type WasteRow } from "../src/reports/production/extractIvy.js";
import {
  WASTE_STREAM_FIELDS,
  wasteStreamsEqual,
  type ShiftDbRow,
} from "../src/reports/production/classify.js";
import { SYNC_ERA_START } from "../src/reports/production/wasteGap.js";
import { roundHalfToEven } from "../src/lib/norm.js";

const BUCKET = "sync-inbox";
/**
 * THE FLOOR, imported not restated (`wasteGap.ts::SYNC_ERA_START`). Below 2026-05-25 the
 * database's waste rows are Renzo's own `MASTER ICTC INPUT FILE V1.xlsx` figures — 158 of
 * them, seeded in one write on 2026-05-27 covering 2025-11-27 … 2026-05-23 — not anything
 * the sync wrote and therefore not this bug. Replacing a human's number with a parser's is
 * not a repair (the L-051 backfill's rule 3, same date, same reason).
 *
 * MEASURED COST OF THE FLOOR, stated rather than hidden: it holds back exactly ONE real
 * disagreement, the 2026-02-02 JANUARY→FEBRUARY changeover, where Ivy's tabs put the day's
 * 2,380.5 kg on JANUARY and the seeded rows put it on FEBRUARY (with a 0 kg row on the
 * other side) — the L-046 question on a master-file-era day. `--from 2026-01-01` surfaces
 * it for a human who decides to act on it.
 */
const DEFAULT_FROM = SYNC_ERA_START;

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnv(): void {
  if (
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  ) {
    return;
  }
  for (const path of ["../../../.env.local", "../../.env.local", "../.env.local"]) {
    try {
      for (const line of readFileSync(new URL(path, import.meta.url), "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#") || !t.includes("=")) continue;
        const i = t.indexOf("=");
        const k = t.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
      return;
    } catch {
      /* try the next candidate */
    }
  }
}

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const fromIdx = argv.indexOf("--from");
const FROM = fromIdx >= 0 ? argv[fromIdx + 1] : DEFAULT_FROM;

interface StoredWorkbook {
  filename: string;
  storagePath: string;
  runDate: string;
}

/**
 * The NEWEST Ivy workbook still referenced by a `sync_runs` manifest. Hers is cumulative
 * and one file per year, so the newest copy contains every row every older copy did —
 * unlike MC's drip reports, there is nothing to merge across files.
 */
async function newestIvyWorkbook(db: DbClient): Promise<StoredWorkbook | null> {
  const { data, error } = await db.sb
    .from("sync_runs")
    .select("id, started_at, result")
    .order("started_at", { ascending: false })
    .limit(600);
  if (error) throw new Error(`sync_runs read failed: ${error.message}`);

  for (const r of (data ?? []) as unknown as Array<Row>) {
    const reports = (
      (r.result as Record<string, unknown> | null)?.manifest as Record<string, unknown> | undefined
    )?.reports as Record<string, unknown> | undefined;
    const list = reports?.production_waste;
    if (!Array.isArray(list)) continue;
    for (const att of list as Array<Record<string, unknown>>) {
      const filename = String(att.filename ?? "");
      const storagePath = String(att.storagePath ?? "");
      if (!filename || !storagePath) continue;
      return { filename, storagePath, runDate: String(r.started_at ?? "").slice(0, 10) };
    }
  }
  return null;
}

async function download(path: string): Promise<Buffer> {
  const sb = createClient(
    String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
    String(process.env.SUPABASE_SERVICE_ROLE_KEY),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`download ${path}: ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}

interface DbWaste {
  id: string;
  shift_id: string;
  remarks: string | null;
  human_edited_at: string | null;
  streams: Record<string, number>;
  total: number;
}

type PlanKind = "insert" | "replace" | "noop" | "latched" | "no_shift" | "below_from";

interface PlanRow {
  kind: PlanKind;
  row: WasteRow;
  shiftId: string | null;
  db: DbWaste | null;
  differing: string[];
  /** For a replace: the OTHER tab's row the stored figures actually belong to, when one
   *  exists. Diagnostic only — never a gate. */
  displacedFrom: string | null;
}

const keyPart = (s: unknown): string =>
  s === null || s === undefined ? "null" : String(s).trim().toUpperCase() || "null";
const triplet = (d: unknown, b: unknown, s: unknown) =>
  `${String(d ?? "null").slice(0, 10)}|${keyPart(b)}|${keyPart(s)}`;

function streamsOf(row: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of WASTE_STREAM_FIELDS) out[f] = Number(row[f] ?? 0);
  return out;
}
/** The extractor's OWN grain, through the one rounding helper — never a local Math.round. */
const total = (s: Record<string, number>) =>
  roundHalfToEven(Object.values(s).reduce((a, b) => a + b, 0), 4);
const fmt = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

async function main(): Promise<void> {
  loadEnv();
  const db = DbClient.fromEnv();
  console.log(
    `[backfill-L052] ${APPLY ? "LIVE — rows WILL be written" : "DRY RUN — nothing will be written"}  from=${FROM}`,
  );

  // ── 1. the newest cumulative waste workbook, read through the REAL extractor ──
  const book = await newestIvyWorkbook(db);
  if (!book) throw new Error("no WASTE PRODUCTION REPORT found in any sync_runs manifest");
  console.log(`[backfill-L052] workbook: ${book.filename} (run ${book.runDate})`);
  const wb = await loadProductionWorkbook(await download(book.storagePath));
  // `since = null` — this script's whole job is the rows the window excluded.
  const extracted = extractIvy(wb, null).waste;
  console.log(
    `[backfill-L052] ${extracted.length} row(s) across ${wb.sheetNames.length} tab(s): ` +
      `${wb.sheetNames.join(", ")}`,
  );

  // ── 2. what the database holds ────────────────────────────────────────────
  const shifts = (await db.readRows("production_shifts", {
    sinceDate: FROM,
    columns: ["id", "transaction_date", "production_batch", "shift"],
  })) as ShiftDbRow[];
  const shiftByTriplet = new Map<string, ShiftDbRow>();
  for (const s of shifts) {
    if (!s.id) continue;
    shiftByTriplet.set(triplet(s.transaction_date, s.production_batch, s.shift), s);
  }
  const wasteRows = await db.readRows("production_waste", {
    sinceColumn: null,
    columns: [
      "id",
      "shift_id",
      "human_edited_at",
      "remarks",
      ...WASTE_STREAM_FIELDS,
    ],
  });
  const wasteByShift = new Map<string, DbWaste>();
  for (const w of wasteRows) {
    const streams = streamsOf(w as Record<string, unknown>);
    wasteByShift.set(String(w.shift_id), {
      id: String(w.id),
      shift_id: String(w.shift_id),
      remarks: (w.remarks as string | null) ?? null,
      human_edited_at: (w.human_edited_at as string | null) ?? null,
      streams,
      total: total(streams),
    });
  }
  console.log(
    `[backfill-L052] ${shifts.length} shift(s) since ${FROM} · ${wasteRows.length} waste row(s)`,
  );

  // ── 3. plan ───────────────────────────────────────────────────────────────
  const plan: PlanRow[] = [];
  for (const row of extracted) {
    const base = { row, differing: [] as string[], displacedFrom: null as string | null };
    if (row.transaction_date < FROM) {
      plan.push({ ...base, kind: "below_from", shiftId: null, db: null });
      continue;
    }
    const shift = shiftByTriplet.get(
      triplet(row.transaction_date, row.production_batch, row.shift),
    );
    if (!shift?.id) {
      plan.push({ ...base, kind: "no_shift", shiftId: null, db: null });
      continue;
    }
    const shiftId = String(shift.id);
    const stored = wasteByShift.get(shiftId) ?? null;
    if (stored === null) {
      plan.push({ ...base, kind: "insert", shiftId, db: null });
      continue;
    }
    // Rule 4 — STREAMS only. A `remarks`-only difference is the historical cosmetic gap
    // and must not become a write.
    const differing = WASTE_STREAM_FIELDS.filter(
      (f) =>
        !wasteStreamsEqual(
          (row as unknown as Record<string, unknown>)[f],
          stored.streams[f],
        ),
    );
    if (differing.length === 0) {
      plan.push({ ...base, kind: "noop", shiftId, db: stored });
      continue;
    }
    // Diagnostic: is the stored row actually ANOTHER tab's row for the same date? That is
    // the L-046 collision signature, and saying so is what lets a person confirm the
    // repair rather than trust it.
    const displaced =
      extracted.find(
        (o) =>
          o !== row &&
          o.transaction_date === row.transaction_date &&
          total(streamsOf(o as unknown as Record<string, unknown>)) === stored.total,
      ) ?? null;
    plan.push({
      ...base,
      kind: stored.human_edited_at ? "latched" : "replace",
      shiftId,
      db: stored,
      differing: [...differing],
      displacedFrom: displaced ? `${displaced._source_sheet} row ${displaced._source_row}` : null,
    });
  }

  // ── 4. the table ──────────────────────────────────────────────────────────
  const writes = plan.filter((p) => p.kind === "insert" || p.kind === "replace");
  console.log("\n  action   date        batch      sh  report kg   stored kg   detail");
  console.log("  ---------------------------------------------------------------------------");
  for (const p of writes) {
    const sheetTotal = total(streamsOf(p.row as unknown as Record<string, unknown>));
    const detail =
      p.kind === "insert"
        ? `${p.row._source_sheet} row ${p.row._source_row} · "${p.row.remarks ?? ""}" · shift has no waste row`
        : `${p.differing.length} stream(s) differ (${p.differing.join(", ")}) · ` +
          `"${p.db?.remarks ?? ""}" -> "${p.row.remarks ?? ""}"` +
          (p.displacedFrom ? ` · stored figures belong to ${p.displacedFrom}` : "");
    console.log(
      `  ${p.kind.padEnd(8)} ${p.row.transaction_date}  ${p.row.production_batch.padEnd(9)}  ` +
        `${p.row.shift}   ${fmt(sheetTotal).padStart(9)}   ${fmt(p.db?.total ?? null).padStart(9)}   ${detail}`,
    );
  }
  if (writes.length === 0) console.log("  (nothing to write)");

  const counts = plan.reduce<Record<string, number>>((a, p) => {
    a[p.kind] = (a[p.kind] ?? 0) + 1;
    return a;
  }, {});
  console.log(
    `\n  ${extracted.length} row(s) examined — ` +
      Object.entries(counts)
        .sort()
        .map(([k, n]) => `${k}:${n}`)
        .join("  "),
  );
  for (const p of plan.filter((x) => x.kind === "latched")) {
    console.log(
      `      LEFT ALONE, a human owns it: ${p.row.transaction_date} ${p.row.production_batch} (${p.db?.id})`,
    );
  }
  for (const p of plan.filter((x) => x.kind === "no_shift")) {
    console.log(
      `      NO SHIFT for ${p.row.transaction_date} ${p.row.production_batch}/${p.row.shift} ` +
        `(${p.row._source_sheet} row ${p.row._source_row}) — reported, never created`,
    );
  }

  if (!APPLY) {
    console.log(
      `\n[backfill-L052] DRY RUN — ${writes.length} row(s) would be written ` +
        `(${counts.insert ?? 0} insert, ${counts.replace ?? 0} replace). Nothing written.`,
    );
    return;
  }
  if (writes.length === 0) {
    console.log("\n[backfill-L052] nothing to do.");
    return;
  }

  // ── 5. write ──────────────────────────────────────────────────────────────
  let inserted = 0;
  let replaced = 0;
  const refused: string[] = [];

  for (const p of writes.filter((x) => x.kind === "insert")) {
    const payload: Row = { shift_id: p.shiftId };
    for (const f of WASTE_STREAM_FIELDS) {
      payload[f] = Number((p.row as unknown as Record<string, unknown>)[f] ?? 0);
    }
    payload.remarks = p.row.remarks ?? null;
    const res = await db.insertIfAbsent("production_waste", [payload], ["shift_id"]);
    if (res.inserted.length === 0) {
      refused.push(`${p.row.transaction_date} ${p.row.production_batch}: already present`);
      continue;
    }
    inserted++;
    await db.writeIngestionAudit({
      tableName: "production_waste",
      recordId: String(res.inserted[0].id),
      operation: "INSERT",
      comment:
        `provenance=backfill-L052 | waste day the sync skipped in silence: Ivy's cumulative ` +
        `workbook inherited MC's runs frontier, so this row was excluded by an exclusive ` +
        `row filter and no later run could retry it | ${p.row.transaction_date} ` +
        `${p.row.production_batch} | ${fmt(total(streamsOf(p.row as unknown as Record<string, unknown>)))} kg ` +
        `from ${p.row._source_sheet} row ${p.row._source_row}`,
      snapshot: payload,
    });
  }

  const replaces = writes.filter((x) => x.kind === "replace");
  if (replaces.length > 0) {
    const ops: Row[] = replaces.map((p) => {
      const patch: Row = {};
      for (const f of WASTE_STREAM_FIELDS) {
        patch[f] = Number((p.row as unknown as Record<string, unknown>)[f] ?? 0);
      }
      patch.remarks = p.row.remarks ?? null;
      return { table: "production_waste", id: p.db!.id, patch };
    });
    const outcomes = await db.applyProductionUpstream(ops);
    const byId = new Map(outcomes.map((o) => [o.id, o.outcome]));
    for (const p of replaces) {
      const outcome = byId.get(p.db!.id) ?? "unknown";
      if (outcome !== "applied") {
        refused.push(`${p.row.transaction_date} ${p.row.production_batch}: ${outcome}`);
        continue;
      }
      replaced++;
      await db.writeIngestionAudit({
        tableName: "production_waste",
        recordId: p.db!.id,
        operation: "UPDATE",
        comment:
          `provenance=backfill-L052 | this shift held another batch's waste row (the L-046 ` +
          `collision that was held "already_exists" and never resolved); replaced with the ` +
          `figures its OWN tab states | ${p.row.transaction_date} ${p.row.production_batch} | ` +
          `${fmt(p.db!.total)} kg -> ` +
          `${fmt(total(streamsOf(p.row as unknown as Record<string, unknown>)))} kg` +
          (p.displacedFrom ? ` | displaced figures belong to ${p.displacedFrom}` : ""),
        diff: {
          before: { ...p.db!.streams, remarks: p.db!.remarks },
          after: {
            ...streamsOf(p.row as unknown as Record<string, unknown>),
            remarks: p.row.remarks ?? null,
          },
        },
        snapshot: { id: p.db!.id, shift_id: p.shiftId },
      });
    }
  }

  console.log(`\n[backfill-L052] inserted ${inserted}, replaced ${replaced}.`);
  for (const r of refused) console.log(`  refused: ${r}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
