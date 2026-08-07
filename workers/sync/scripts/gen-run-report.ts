/**
 * gen-run-report.ts — generate the Excel sync report for a REAL run and prove what it holds.
 *
 *   npx tsx scripts/gen-run-report.ts <runId> [--out <path>] [--persist] [--fail]
 *   npx tsx scripts/gen-run-report.ts --list [n]
 *
 * Modes:
 *   (default)   build the workbook from the run's stored result + events + cases, write it to
 *               a local file, print the sheet-by-sheet row counts and a sample of real rows.
 *               NO Storage upload, NO `sync_run_reports` row — safe to run against history.
 *   --persist   ALSO upload to the private `sync-reports` bucket and record the artifact,
 *               exactly as the worker does at the end of a run.
 *   --fail      force the generator to throw, to prove the failure is contained and recorded.
 *   --list      show the most recent runs so you can pick one.
 *
 * Env comes from workers/sync/.env if present, else the repo-root .env.local — this script is
 * read-only by default and never prints a key.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import ExcelJS from "exceljs";

import { DbClient } from "../src/lib/db.js";
import {
  generateRunReport,
  reportFilename,
  reportStoragePath,
  SYNC_REPORTS_BUCKET,
} from "../src/reports/excel/generate.js";
import { SYNC_REPORT_SHEETS } from "../src/reports/excel/workbook.js";

function loadEnv(): void {
  for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env.local")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  }
}

async function listRuns(limit: number): Promise<void> {
  const db = DbClient.fromEnv();
  const rows = await db.readRows("sync_runs", {
    sinceColumn: null,
    columns: ["id", "status", "started_at", "finished_at"],
    extraFilters: { order: "created_at.desc", limit: String(limit) },
  });
  for (const r of rows) {
    console.log(`${r.id}  ${String(r.status).padEnd(10)}  ${r.started_at ?? "-"}`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);

  if (argv[0] === "--list") {
    await listRuns(Number(argv[1] ?? 15));
    return;
  }

  const runId = argv[0];
  if (!runId) {
    console.error("usage: npx tsx scripts/gen-run-report.ts <runId> [--out <path>] [--persist] [--fail]");
    process.exit(1);
  }
  const persist = argv.includes("--persist");
  const forceFail = argv.includes("--fail");
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;

  const db = DbClient.fromEnv();
  const run = await db.selectOne("sync_runs", { id: `eq.${runId}` }, "id,status,started_at,finished_at");
  if (!run) {
    console.error(`no sync_runs row with id ${runId}`);
    process.exit(1);
  }
  const startedAt = (run.started_at as string | null) ?? null;

  console.log(`run      ${runId}`);
  console.log(`status   ${run.status}`);
  console.log(`started  ${startedAt}`);
  console.log(`path     ${SYNC_REPORTS_BUCKET}/${reportStoragePath(runId, startedAt)}`);
  console.log(`filename ${reportFilename(runId, startedAt)}`);
  console.log("");

  const artifact = await generateRunReport(runId, {
    skipPersist: !persist,
    failForTest: forceFail,
  });

  if (!artifact.ok) {
    console.log(`GENERATION FAILED (contained): ${artifact.error}`);
    console.log("The run's own status is untouched — nothing about this failure changes it.");
    return;
  }

  console.log(`bytes            ${artifact.bytes}`);
  console.log(`findings         ${artifact.finding_count}`);
  console.log(`warn beats       ${artifact.warn_count}`);
  console.log(`error beats      ${artifact.error_count}`);
  console.log(`contains_prices  ${artifact.contains_prices}`);
  console.log("");
  console.log("sheet row counts (data rows, header excluded):");
  for (const sheet of SYNC_REPORT_SHEETS) {
    const n = artifact.sheet_counts?.[sheet];
    console.log(`  ${sheet.padEnd(18)} ${n ?? 0}`);
  }

  if (persist) {
    console.log("");
    console.log(`uploaded to ${artifact.bucket}/${artifact.path} and recorded in sync_run_reports`);
    return;
  }

  // Rebuild locally to write the file + print sample rows (skipPersist gave us no bytes back).
  const rebuilt = await generateRunReportToFile(runId, outPath ?? `./sync-report-${runId.slice(0, 8)}.xlsx`);
  console.log("");
  console.log(`written to ${rebuilt}`);
  await printSample(rebuilt);
}

/**
 * Build again and write the bytes to disk. `generateRunReport` deliberately does not hand the
 * buffer back (its job is store-and-record), so the script re-invokes the pure builder path
 * through it and captures the upload — here we just re-run with a local sink.
 */
async function generateRunReportToFile(runId: string, out: string): Promise<string> {
  const { buildSyncReportWorkbook } = await import("../src/reports/excel/workbook.js");
  const db = DbClient.fromEnv();
  const run = await db.selectOne(
    "sync_runs",
    { id: `eq.${runId}` },
    "id,status,started_at,finished_at,result,error",
  );
  const events = await db.readRows("sync_run_events", {
    sinceColumn: null,
    columns: ["report_type", "stage", "pct", "label", "detail", "level", "at"],
    extraFilters: { run_id: `eq.${runId}`, order: "at.asc,id.asc" },
  });
  const cases = await db.readRows("sync_held_cases", {
    sinceColumn: null,
    columns: [
      "report_type",
      "kind",
      "natural_key",
      "status",
      "reason",
      "detail",
      "row",
      "occurrence_count",
      "created_at",
      "last_seen_at",
      "known_ruling_id",
    ],
    extraFilters: { last_run_id: `eq.${runId}`, order: "kind.asc" },
  });
  const result = (run?.result ?? null) as Parameters<typeof buildSyncReportWorkbook>[0]["result"];
  const built = await buildSyncReportWorkbook({
    runId,
    runStatus: String(run?.status ?? "unknown"),
    startedAt: (run?.started_at as string | null) ?? null,
    finishedAt: (run?.finished_at as string | null) ?? null,
    dryRun: Boolean((result as Record<string, unknown> | null)?.dryRun),
    result,
    events: events as never,
    cases: cases as never,
    runError: (run?.error as string | null) ?? null,
    generatorVersion: "excel-1.0",
  });
  writeFileSync(out, built.buffer);
  return resolve(out);
}

/** Read the written file back and print a few REAL rows from the sheets that have any. */
async function printSample(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  console.log("");
  console.log("=== sample rows (read back out of the written file) ===");
  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    ws.eachRow((row, n) => {
      if (n <= 3 || rows.length >= 3) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        const t =
          v instanceof Date
            ? v.toISOString().slice(0, 10)
            : v == null
              ? ""
              : typeof v === "object"
                ? JSON.stringify(v)
                : String(v);
        if (t) cells.push(t.length > 90 ? `${t.slice(0, 90)}…` : t);
      });
      if (cells.length) rows.push(cells);
    });
    if (!rows.length) continue;
    console.log("");
    console.log(`-- ${ws.name} (${ws.rowCount} rows total)`);
    for (const r of rows) console.log(`   ${r.join(" | ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
