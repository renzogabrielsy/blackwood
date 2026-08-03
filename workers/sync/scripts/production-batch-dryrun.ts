/**
 * production-batch-dryrun.ts — offline DRY RUN of the REAL production port against a
 * local MC workbook, proving the batch-transition fix end to end.
 *
 * It calls the actual `runReport(...)` from src/reports/production/index.ts with:
 *   - a LOCAL workbook (no Gmail, no Storage) via a stubbed `fetchToLocalPath`;
 *   - a READ-ONLY DbClient facade over the live Supabase (`readRows`, watermark) whose
 *     every WRITE method THROWS, so the run physically cannot mutate the database;
 *   - no labeler (`noLabel: true`) — Gmail is never touched at all.
 *
 * It then prints, per date: the resolved batch plan, every run/downtime/electricity/
 * truck row that WOULD be written, the classify counts, and the changeover findings.
 *
 * Usage:
 *   npx tsx scripts/production-batch-dryrun.ts <workbook.xlsx> [sinceYYYY-MM-DD]
 * (`since` defaults to the live production_runs frontier — exactly what a real run uses.)
 */
import { readFileSync } from "node:fs";

import { DbClient, type Row } from "../src/lib/db.js";
import { runReport, type ProductionManifest } from "../src/reports/production/index.js";

function loadEnv(): void {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* env may already be set */
  }
}

/** Wrap a live DbClient so every WRITE throws. Reads pass straight through. */
function readOnly(db: DbClient): DbClient {
  const blocked = [
    "insert",
    "insertIfAbsent",
    "update",
    "upsert",
    "upsertBatchIfAbsent",
    "delete",
    "deleteRows",
    "writeIngestionAudit",
    "upsertIngestionWatermark",
    "rpc",
  ] as const;
  const guard: Record<string, unknown> = {};
  for (const m of blocked) {
    guard[m] = async () => {
      throw new Error(`DRY RUN: blocked write DbClient.${m}()`);
    };
  }
  // writeIngestionAudit / upsertIngestionWatermark are called on the happy path and
  // would abort the run, so give them inert no-op returns instead of a throw.
  guard.writeIngestionAudit = async () => ({ id: "DRYRUN-AUDIT" });
  guard.upsertIngestionWatermark = async () => false;
  // insertIfAbsent is the write we WANT to observe — record + fake the id.
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in guard) return guard[prop];
      return Reflect.get(target, prop, receiver);
    },
  }) as DbClient;
}

interface Observed {
  table: string;
  payload: Row;
}

async function main(): Promise<void> {
  loadEnv();
  const wbPath = process.argv[2];
  if (!wbPath) throw new Error("usage: tsx scripts/production-batch-dryrun.ts <workbook.xlsx> [since]");
  const sinceArg = process.argv[3];

  const live = DbClient.fromEnv();
  const guarded = readOnly(live);

  // Observe (and fake) every insertIfAbsent so we can print the exact write plan.
  const observed: Observed[] = [];
  let seq = 0;
  const db = new Proxy(guarded, {
    get(target, prop, receiver) {
      if (prop === "insertIfAbsent") {
        return async (table: string, rows: Row[]) => {
          observed.push({ table, payload: rows[0] });
          const inserted = { ...rows[0], id: `DRYRUN-${table}-${++seq}` };
          return { inserted: [inserted], skipped: [], insertedCount: 1, skippedCount: 0 };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as DbClient;

  const manifest: ProductionManifest = {
    reports: {
      production_mc: [
        {
          storagePath: wbPath,
          filename: wbPath.split("/").pop() ?? "mc.xlsx",
          emailUid: 0,
          emailSubject: "Daily Production Report (DRY RUN)",
          threadId: null,
        },
      ],
    },
  };

  const lines: string[] = [];
  const res = await runReport(
    {
      db,
      fetchToLocalPath: async (p: string) => p, // the manifest already holds a LOCAL path
      noLabel: true,
      progress: async (stage, label, pct, detail, level) => {
        lines.push(`[${String(pct).padStart(3)}%] ${stage.padEnd(9)} ${level === "warn" ? "! " : "  "}${label}${detail ? `  (${detail})` : ""}`);
      },
    },
    "dryrun",
    manifest,
    sinceArg ? { since: sinceArg } : {},
  );

  console.log("── progress ──────────────────────────────────────────────────────────");
  for (const l of lines) console.log(l);

  console.log("\n── WOULD WRITE ───────────────────────────────────────────────────────");
  for (const o of observed) {
    console.log(`  ${o.table.padEnd(22)} ${JSON.stringify(o.payload)}`);
  }
  if (!observed.length) console.log("  (nothing)");

  console.log("\n── classify ──────────────────────────────────────────────────────────");
  console.log(`  watermark=${res.classify.watermark}  counts=${JSON.stringify(res.classify.counts)}`);
  console.log(`  per_section=${JSON.stringify(res.classify.per_section)}`);

  console.log("\n── apply result ──────────────────────────────────────────────────────");
  console.log(`  ok=${res.apply.ok} inserts=${res.apply.inserts} updates=${res.apply.updates}`);
  console.log(`  held=${JSON.stringify(res.apply.held)}`);
  console.log(`  errors=${JSON.stringify(res.apply.errors)}`);
  console.log(`  production_batch_starts=${JSON.stringify(res.apply.production_batch_starts, null, 2)}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("DRY RUN FAILED:", err instanceof Error ? err.stack : String(err));
    process.exit(1);
  },
);
