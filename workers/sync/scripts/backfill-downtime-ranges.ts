/**
 * backfill-downtime-ranges.ts — ONE-OFF repair for L-051 (2026-09-14).
 *
 * WHAT WENT WRONG. `production_downtime.dt_hrs`/`dt_mins` came from MC's hand-written
 * DURATION cell and `shift_hrs` was the literal constant 12. MC stopped filling the
 * DURATION cell on 2026-08-01, so August published **0.0 downtime hours across 23 of 23
 * rows** and September **0.0 across 10 of 10** — beside a fully-written list of stop
 * times. July was understated too, because the DURATION cell normally summarises only
 * the FIRST range. The extractor now reads the list; this script re-reads the workbooks
 * still in Storage through the NEW extractor and repairs the rows already written.
 *
 * FOUR RULES IT OBEYS, each for a reason:
 *
 *  1. **It never writes through a bare UPDATE.** Every change goes through
 *     `fn_apply_production_upstream`, whose UPDATE carries `human_edited_at IS NULL` in
 *     its OWN WHERE clause. A row a person edited in the app comes back `human_edited`,
 *     is LISTED, and is left exactly as it is. (An instruction only counts if it is a
 *     predicate in a WHERE clause.)
 *  2. **Every changed row leaves an audit row** via `write_ingestion_audit`, carrying the
 *     before/after diff and `provenance=backfill-L051`.
 *  3. **It stops at the sync-written era by default (`--from 2026-05-25`).** Everything
 *     before that date came from `MASTER ICTC INPUT FILE V1.xlsx` (audit-checked: 158
 *     rows, 2025-11-27 … 2026-05-23, all carrying `shift_hrs = 9`) — those are RENZO'S
 *     OWN curated figures, and on 2026-04-21/22 his file records 4 minutes where the
 *     ranges read 309 (the sheet's own reason says "NO STOPPING OF OPERATION"). Replacing
 *     a human's number with a parser's is not a repair. `--from` moves the floor if he
 *     decides otherwise.
 *  4. **`--dry-run` writes nothing** and prints the same table.
 *
 * WHAT IT CANNOT REACH. Only two MC workbooks survive in `sync-inbox`: the 2Q file
 * (2026-03-31 … 05-27) and the newest 3Q file (2026-07-01 … 09-11). **JUNE 2026 has no
 * workbook in Storage at all**, so its 23 rows keep their DURATION-derived figures; they
 * are reported as out-of-reach rather than silently skipped.
 *
 * RE-RUN 2026-09-14 (L-051b): the same script carries Renzo's two rulings — a normal shift
 * is NINE hours, and a range whose reason says the plant did not stop is an INCIDENT, not
 * downtime. It re-derives from the same workbooks through the same RPC, so there is no
 * second repair mechanism and no second definition of either rule.
 *
 * Usage (from workers/sync):
 *   npx tsx scripts/backfill-downtime-ranges.ts --dry-run
 *   npx tsx scripts/backfill-downtime-ranges.ts
 *   npx tsx scripts/backfill-downtime-ranges.ts --from 2025-11-01   # include the master era
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { DbClient, type Row } from "../src/lib/db.js";
import { loadProductionWorkbook } from "../src/reports/production/sheet.js";
import { extractMc, type DowntimeRow } from "../src/reports/production/extractMc.js";

/** First day the SYNC wrote a downtime row. Before it, the rows are Renzo's master file. */
const SYNC_ERA_START = "2026-05-25";
const BUCKET = "sync-inbox";

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnv(): void {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY && (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
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
const DRY = argv.includes("--dry-run");
const fromIdx = argv.indexOf("--from");
const FROM = fromIdx >= 0 ? argv[fromIdx + 1] : SYNC_ERA_START;

interface StoredWorkbook {
  filename: string;
  storagePath: string;
  runDate: string;
}

/**
 * Every DISTINCT MC workbook still referenced by a `sync_runs` manifest, newest run
 * first. A cumulative workbook supersedes its own earlier copies, so only the newest
 * copy of each filename is kept — and the newest 3Q file contains every day the earlier
 * 3Q files did.
 */
async function storedWorkbooks(db: DbClient): Promise<StoredWorkbook[]> {
  const { data, error } = await db.sb
    .from("sync_runs")
    .select("id, started_at, result")
    .order("started_at", { ascending: false })
    .limit(600);
  if (error) throw new Error(`sync_runs read failed: ${error.message}`);

  const seen = new Set<string>();
  const out: StoredWorkbook[] = [];
  for (const r of (data ?? []) as unknown as Array<Row>) {
    const result = r.result as Record<string, unknown> | null;
    const reports = (result?.manifest as Record<string, unknown> | undefined)?.reports as
      | Record<string, unknown>
      | undefined;
    const list = reports?.production_mc;
    if (!Array.isArray(list)) continue;
    for (const att of list as Array<Record<string, unknown>>) {
      const filename = String(att.filename ?? "");
      const storagePath = String(att.storagePath ?? "");
      if (!filename || !storagePath || seen.has(filename)) continue;
      seen.add(filename);
      out.push({ filename, storagePath, runDate: String(r.started_at ?? "").slice(0, 10) });
    }
  }
  return out;
}

async function download(path: string): Promise<Buffer> {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sb = createClient(String(url), String(key), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`download ${path}: ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}

interface DbDowntime {
  id: string;
  shift_id: string;
  shift_hrs: number | null;
  dt_hrs: number | null;
  dt_mins: number | null;
  dt_ranges: string | null;
  dt_incident_ranges: string | null;
  shift_hrs_source: string | null;
  human_edited_at: string | null;
  transaction_date: string;
  production_batch: string;
}

const FIELDS = [
  "dt_hrs",
  "dt_mins",
  "dt_ranges",
  "dt_incident_ranges",
  "shift_hrs",
  "shift_hrs_source",
] as const;

const same = (a: unknown, b: unknown): boolean => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === "number" || typeof b === "number") {
    return Math.abs(Number(a) - Number(b)) < 1e-9;
  }
  return String(a) === String(b);
};

const month = (iso: string) => iso.slice(0, 7);
const hrs = (h: unknown, m: unknown) => (Number(h ?? 0) * 60 + Number(m ?? 0)) / 60;

async function main(): Promise<void> {
  loadEnv();
  const db = DbClient.fromEnv();
  console.log(`[backfill-L051] ${DRY ? "DRY RUN — nothing will be written" : "LIVE"}  from=${FROM}`);

  // ── 1. every downtime row, joined to its shift's date + batch ──────────────
  const { data: rows, error } = await db.sb
    .from("production_downtime")
    .select(
      "id, shift_id, shift_hrs, dt_hrs, dt_mins, dt_ranges, dt_incident_ranges, " +
        "shift_hrs_source, human_edited_at, " +
        "production_shifts!inner(transaction_date, production_batch)",
    );
  if (error) throw new Error(`production_downtime read failed: ${error.message}`);

  const byDate = new Map<string, DbDowntime[]>();
  for (const r of (rows ?? []) as unknown as Array<Record<string, unknown>>) {
    const sh = r.production_shifts as Record<string, unknown>;
    const rec: DbDowntime = {
      id: String(r.id),
      shift_id: String(r.shift_id),
      shift_hrs: r.shift_hrs as number | null,
      dt_hrs: r.dt_hrs as number | null,
      dt_mins: r.dt_mins as number | null,
      dt_ranges: r.dt_ranges as string | null,
      dt_incident_ranges: r.dt_incident_ranges as string | null,
      shift_hrs_source: r.shift_hrs_source as string | null,
      human_edited_at: (r.human_edited_at as string | null) ?? null,
      transaction_date: String(sh.transaction_date),
      production_batch: String(sh.production_batch ?? ""),
    };
    const list = byDate.get(rec.transaction_date) ?? [];
    list.push(rec);
    byDate.set(rec.transaction_date, list);
  }
  console.log(`[backfill-L051] ${(rows ?? []).length} downtime rows over ${byDate.size} dates`);

  // ── 2. re-extract every surviving MC workbook, newest first ────────────────
  const books = await storedWorkbooks(db);
  console.log(`[backfill-L051] ${books.length} MC workbook(s) in Storage`);
  /** date -> the freshest extracted downtime rows for it. */
  const fresh = new Map<string, DowntimeRow[]>();
  for (const b of books) {
    let extracted: DowntimeRow[];
    try {
      const wb = await loadProductionWorkbook(await download(b.storagePath));
      // `since` is a floor only — 2020-01-01 keeps every day tab in the workbook.
      extracted = extractMc(wb, 2026, "2020-01-01").downtime;
    } catch (e) {
      console.log(`  ! ${b.filename}: ${(e as Error).message}`);
      continue;
    }
    let added = 0;
    for (const d of extracted) {
      if (fresh.has(d.transaction_date)) continue; // a newer workbook already spoke
      fresh.set(d.transaction_date, extracted.filter((x) => x.transaction_date === d.transaction_date));
      added++;
    }
    console.log(`  · ${b.filename} (run ${b.runDate}): ${extracted.length} downtime rows, ${added} new date(s)`);
  }

  // ── 3. plan ────────────────────────────────────────────────────────────────
  interface Change {
    row: DbDowntime;
    patch: Row;
    before: Row;
    beforeHrs: number;
    afterHrs: number;
  }
  const changes: Change[] = [];
  const latched: DbDowntime[] = [];
  const unreachable: DbDowntime[] = [];
  const belowFloor: DbDowntime[] = [];

  for (const [date, dbRows] of [...byDate.entries()].sort()) {
    if (date < FROM) {
      belowFloor.push(...dbRows);
      continue;
    }
    const src = fresh.get(date);
    if (!src || src.length === 0) {
      unreachable.push(...dbRows);
      continue;
    }
    for (const r of dbRows) {
      // A changeover day has two downtime rows, one per batch; match on the batch so a
      // split day's two halves each get their own (already apportioned) figures.
      const m =
        src.find((s) => s.production_batch === r.production_batch) ??
        (src.length === 1 ? src[0] : undefined);
      if (!m) {
        unreachable.push(r);
        continue;
      }
      const patch: Row = {};
      const before: Row = {};
      for (const f of FIELDS) {
        if (!same(r[f], m[f])) {
          patch[f] = m[f];
          before[f] = r[f];
        }
      }
      if (Object.keys(patch).length === 0) continue;
      if (r.human_edited_at) {
        latched.push(r);
        continue;
      }
      changes.push({
        row: r,
        patch,
        before,
        beforeHrs: hrs(r.dt_hrs, r.dt_mins),
        afterHrs: hrs(m.dt_hrs, m.dt_mins),
      });
    }
  }

  // ── 4. the table ───────────────────────────────────────────────────────────
  const months = new Map<
    string,
    { rows: number; before: number; after: number; shiftMoved: number; incidents: number }
  >();
  const incidentRows: Array<{ date: string; ranges: string }> = [];
  for (const c of changes) {
    const k = month(c.row.transaction_date);
    const agg = months.get(k) ?? { rows: 0, before: 0, after: 0, shiftMoved: 0, incidents: 0 };
    agg.rows++;
    agg.before += c.beforeHrs;
    agg.after += c.afterHrs;
    if ("shift_hrs" in c.patch) agg.shiftMoved++;
    if (typeof c.patch.dt_incident_ranges === "string" && c.patch.dt_incident_ranges) {
      agg.incidents++;
      incidentRows.push({ date: c.row.transaction_date, ranges: c.patch.dt_incident_ranges });
    }
    months.set(k, agg);
  }
  console.log("\n  month    rows  downtime hrs before -> after   shift moved  incidents");
  console.log("  --------------------------------------------------------------------");
  for (const [k, v] of [...months.entries()].sort()) {
    console.log(
      `  ${k}  ${String(v.rows).padStart(5)}  ${v.before.toFixed(2).padStart(9)} -> ` +
        `${v.after.toFixed(2).padStart(9)}   ${String(v.shiftMoved).padStart(11)}  ` +
        `${String(v.incidents).padStart(9)}`,
    );
  }
  if (incidentRows.length > 0) {
    console.log("\n  INCIDENTS (reason says the plant did not stop — 0 downtime, range kept):");
    for (const r of incidentRows) console.log(`      ${r.date}  ${r.ranges}`);
  }
  const tot = [...months.values()].reduce(
    (a, v) => ({ rows: a.rows + v.rows, before: a.before + v.before, after: a.after + v.after }),
    { rows: 0, before: 0, after: 0 },
  );
  console.log(
    `  TOTAL    ${String(tot.rows).padStart(5)}  ${tot.before.toFixed(2).padStart(9)} -> ${tot.after.toFixed(2).padStart(9)}`,
  );

  const say = (name: string, list: DbDowntime[]) => {
    if (list.length === 0) return;
    const ms = new Map<string, number>();
    for (const r of list) ms.set(month(r.transaction_date), (ms.get(month(r.transaction_date)) ?? 0) + 1);
    console.log(
      `\n  ${name}: ${list.length} row(s) — ` +
        [...ms.entries()].sort().map(([k, n]) => `${k}:${n}`).join("  "),
    );
  };
  say("LEFT ALONE, a human owns them (human_edited_at set)", latched);
  say("LEFT ALONE, below --from (Renzo's MASTER ICTC INPUT FILE era)", belowFloor);
  say("OUT OF REACH, no workbook for that date in Storage", unreachable);
  for (const r of latched) {
    console.log(`      latched: ${r.transaction_date} ${r.production_batch} (${r.id})`);
  }

  if (DRY) {
    console.log(`\n[backfill-L051] DRY RUN — ${changes.length} row(s) would change. Nothing written.`);
    return;
  }
  if (changes.length === 0) {
    console.log("\n[backfill-L051] nothing to do.");
    return;
  }

  // ── 5. write, latch-aware, one audit row per changed row ───────────────────
  const ops: Row[] = changes.map((c) => ({
    table: "production_downtime",
    id: c.row.id,
    patch: c.patch,
  }));
  const outcomes = await db.applyProductionUpstream(ops);
  const byId = new Map(outcomes.map((o) => [o.id, o.outcome]));

  let applied = 0;
  const refused: string[] = [];
  for (const c of changes) {
    const outcome = byId.get(c.row.id) ?? "unknown";
    if (outcome !== "applied") {
      refused.push(`${c.row.transaction_date} ${c.row.production_batch}: ${outcome}`);
      continue;
    }
    applied++;
    await db.writeIngestionAudit({
      tableName: "production_downtime",
      recordId: c.row.id,
      operation: "UPDATE",
      comment:
        `provenance=backfill-L051 | downtime re-read from MC's own time ranges ` +
        `(the DURATION cell was blank or covered only the first stoppage) and shift_hrs ` +
        `derived from the day's overtime signal (9 h normal, 12 h on overtime) and any ` +
        `"no stop operation" range recorded as an INCIDENT rather than downtime | ` +
        `${c.row.transaction_date} ` +
        `${c.row.production_batch} | ${c.beforeHrs.toFixed(2)} h -> ${c.afterHrs.toFixed(2)} h`,
      diff: { before: c.before, after: c.patch },
      snapshot: { id: c.row.id, transaction_date: c.row.transaction_date, ...c.patch },
    });
  }

  console.log(`\n[backfill-L051] applied ${applied} of ${changes.length} row(s).`);
  for (const r of refused) console.log(`  refused: ${r}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
