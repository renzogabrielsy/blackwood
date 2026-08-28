/**
 * prod-schedule-proof.ts — live end-to-end proof of the worker's schedule-refresh step.
 *
 *   npx tsx scripts/prod-schedule-proof.ts          # compute + print + REAL upsert
 *   npx tsx scripts/prod-schedule-proof.ts --dry     # compute + print only (no write)
 *
 * Exercises the SAME code the sync worker runs (reports/prodSchedule/refresh.ts): it
 * downloads Renzo's Sheet, fetches Joseph's latest schedule email over the worker's
 * imapflow GmailClient, computes the merge, prints the July slice + diagnostics, and
 * (unless --dry) writes CONDITIONALLY through the same planner + atomic RPC the worker
 * uses — plan.ts's six rules, `fn_apply_schedule_upstream`. It CANNOT clobber a
 * human-owned or already-reported day, and in the steady state it writes nothing.
 *
 * Env is read from workers/sync/.env (GMAIL_USER / GMAIL_APP_PASSWORD / SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY). Writes bypass RLS via the service role — never expose.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { DbClient } from "../src/lib/db.js";
import { downloadGsheet, GSHEET_EXPORT_URL, type FetchLike } from "../src/reports/gsheet/download.js";
import { fetchLatestJosephSchedule } from "../src/reports/prodSchedule/josephEmail.js";
import { computeMergedSchedule } from "../src/reports/prodSchedule/refresh.js";
import {
  planScheduleUpstream,
  stampSourceRevs,
  toScheduleStateRow,
} from "../src/reports/prodSchedule/plan.js";

/** Load workers/sync/.env into process.env without clobbering existing keys. */
function loadEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const dry = process.argv.includes("--dry");
  const db = DbClient.fromEnv();

  console.log("[proof] downloading Renzo's Sheet…");
  const renzoBuf = await downloadGsheet(globalThis.fetch as unknown as FetchLike, GSHEET_EXPORT_URL);
  console.log(`[proof] gsheet bytes: ${renzoBuf.length}`);

  console.log("[proof] fetching Joseph's latest schedule email over IMAP…");
  let joseph = null;
  try {
    joseph = await fetchLatestJosephSchedule();
    console.log(
      joseph
        ? `[proof] Joseph: ${joseph.origin} · rev=${joseph.rev.sourceTag} · ${joseph.buffer.length} bytes`
        : "[proof] Joseph: NO matching email → Renzo-only fallback",
    );
  } catch (err) {
    console.log(`[proof] Joseph fetch threw (${(err as Error).message}) → Renzo-only fallback`);
  }

  const merged = computeMergedSchedule(renzoBuf, joseph);
  console.log(
    `[proof] merged rows=${merged.rows.length}` +
      (merged.joseph
        ? ` · joseph tabs=[${merged.joseph.selectedTabs.join(", ")}] days=${merged.joseph.days} overridden=${merged.joseph.overridden} warnings=${merged.joseph.warnings.length}`
        : ` · Renzo-only (${merged.josephSkippedReason ?? "?"})`),
  );

  const july = merged.rows
    .filter((r) => r.plan_date >= "2026-07-01" && r.plan_date <= "2026-07-31")
    .sort((a, b) => a.plan_date.localeCompare(b.plan_date));
  console.log("\n[proof] JULY 2026 merged rows:");
  for (const r of july) {
    console.log(
      `  ${r.plan_date}  shifts=${r.shifts}  setup=${JSON.stringify(r.setup)}  ` +
        `tons=${r.projected_tons}  grades=${JSON.stringify(r.grades)}  ` +
        `src=${r.source}  remarks=${JSON.stringify(r.remarks)}`,
    );
  }

  if (dry) {
    console.log("\n[proof] --dry: skipping upsert.");
    return;
  }

  const nowIso = new Date().toISOString();
  const stamped = stampSourceRevs(merged.rows, joseph?.messageTag ?? null);
  const dates = stamped.map((r) => r.plan_date).sort();
  const state = (await db.readScheduleState(dates)).map((r) =>
    toScheduleStateRow(r as Record<string, unknown>),
  );
  const plan = planScheduleUpstream(stamped, state, nowIso);
  console.log(
    `\n[proof] plan: unchanged=${plan.counts.unchanged} frozen=${plan.counts.frozen} ` +
      `insert=${plan.counts.inserted} apply=${plan.counts.applied} ` +
      `reclaim=${plan.counts.reclaimed} park=${plan.counts.parked}`,
  );
  for (const c of plan.conflicts) {
    console.log(`  [conflict] ${c.plan_date} — human-owned; withheld ${c.changed_fields.join(", ")}`);
  }
  if (!plan.ops.length) {
    console.log("[proof] nothing to write — the DB already carries this revision.");
    return;
  }
  const outcomes = await db.applyScheduleUpstream(
    plan.ops.map((op) => ({
      plan_date: op.plan_date,
      action: op.action,
      expected_row_version: op.expected_row_version,
      expected_owner: op.expected_owner,
      source_rev: op.source_rev,
      new_owner: op.new_owner,
      row: op.row as unknown as Record<string, unknown>,
      pending: op.pending ?? null,
    })),
  );
  const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[proof] applied: ${JSON.stringify(tally)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[proof] FAILED:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
