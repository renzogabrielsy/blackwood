/**
 * delivery-identity-dryrun.ts — the MANDATORY dry run for the L-040b two-tier delivery
 * identity (2026-08-08).
 *
 * Changing the identity means the next run re-evaluates every row against a new key, so
 * rows that previously looked NEW may now match an existing row and reclassify. Renzo
 * must see that list BEFORE anything writes. This script produces it.
 *
 * WHAT IT DOES
 *   1. Reads the LIVE database over REST — `deliveries`, `rc_out`, `batches` — through a
 *      DbClient wrapped in a proxy whose every WRITE method THROWS. Nothing can be
 *      written even by mistake.
 *   2. Fetches the REAL current sources:
 *        - the Google Sheet, pulled fresh from its XLSX export URL (the same call
 *          gsheet's runReport makes);
 *        - MC's most recent RC DELIVERIES workbook, taken from the PRIVATE `sync-inbox`
 *          Storage bucket where the Mail Clerk archives every attachment it has fetched.
 *          Storage is used deliberately INSTEAD of Gmail: an IMAP session is a scarce
 *          resource on this account (BUG-019) and a dry run must not spend one.
 *   3. Runs the frozen `classifyCase` for BOTH writers, twice:
 *        - NEW  — this working tree;
 *        - OLD  — a pristine `git worktree` at HEAD, i.e. the actual pre-change code,
 *                 driven by the same `identity-dryrun-classify.ts` over the same inputs.
 *      No re-implementation of the old rule, so the comparison cannot be flattered.
 *   4. Writes a markdown report: the bucket-count deltas, every row that changed bucket,
 *      and the field-level disagreement behind each one.
 *
 * WHAT IT NEVER DOES
 *   No INSERT / UPDATE / DELETE, no audit row, no Gmail label, no watermark move, no
 *   settlement row. Reads only. `deliveries`/`rc_out` row counts are re-read at the end
 *   and printed so the "nothing was written" claim is checkable rather than asserted.
 *
 * Usage:
 *   npx tsx scripts/delivery-identity-dryrun.ts [outDir]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { DbClient, type Row } from "../src/lib/db.js";
import { downloadGsheet, GSHEET_EXPORT_URL, type FetchLike } from "../src/reports/gsheet/download.js";

const REPO = resolve(new URL("../../..", import.meta.url).pathname);
const WORKER = join(REPO, "workers/sync");

function loadEnv(): void {
  try {
    for (const line of readFileSync(join(WORKER, ".env"), "utf8").split("\n")) {
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
    "insert", "insertIfAbsent", "update", "upsert", "upsertBatchIfAbsent", "delete",
    "deleteRows", "writeIngestionAudit", "upsertIngestionWatermark", "stampIngestionAudit",
    "insertSettlements", "rpc",
  ];
  const guard: Record<string, unknown> = {};
  for (const m of blocked) {
    guard[m] = async () => {
      throw new Error(`DRY RUN: blocked write DbClient.${m}()`);
    };
  }
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in guard) return guard[prop];
      return Reflect.get(target, prop, receiver);
    },
  }) as DbClient;
}

// ---------------------------------------------------------------------------
// Storage: newest archived RC DELIVERIES workbook (no Gmail session spent)
// ---------------------------------------------------------------------------
async function newestDeliveriesWorkbook(outDir: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  const runsRes = await fetch(
    `${url}/rest/v1/sync_runs?select=id,started_at&order=started_at.desc&limit=40`,
    { headers: h },
  );
  const runs = (await runsRes.json()) as Array<{ id: string; started_at: string }>;
  for (const r of runs) {
    const listRes = await fetch(`${url}/storage/v1/object/list/sync-inbox`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ prefix: `${r.id}/deliveries/`, limit: 20 }),
    });
    const objs = (await listRes.json()) as Array<{ name: string }>;
    const xlsx = (objs ?? []).find((o) => o.name?.toLowerCase().endsWith(".xlsx"));
    if (!xlsx) continue;
    const path = `${r.id}/deliveries/${xlsx.name}`;
    const dl = await fetch(`${url}/storage/v1/object/sync-inbox/${path}`, { headers: h });
    if (!dl.ok) continue;
    const buf = Buffer.from(await dl.arrayBuffer());
    const local = join(outDir, "rc_deliveries.xlsx");
    writeFileSync(local, buf);
    process.stdout.write(`  RC DELIVERIES workbook: sync-inbox/${path} (${buf.length} bytes, run ${r.id}, started ${r.started_at})\n`);
    return local;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
type Envelope = Record<string, unknown>;
interface Side {
  deliveries: Envelope;
  gsheet: { rc_in: Envelope; rc_out: Envelope };
}

/** A stable per-row label so the same physical row can be found on both sides. */
function rowLabel(o: Record<string, unknown>): string {
  const r = (o.row ?? o) as Record<string, unknown>;
  const bc = r.batch_code ?? r.batch_code_primary ?? r.batch_code_resolved ?? "";
  const w = r.weight_kg ?? "";
  return [
    String(r.transaction_date ?? "").slice(0, 10),
    String(bc),
    String(r.block_loc ?? ""),
    String(r.truck_plate ?? ""),
    String(r.sacks ?? ""),
    String(w),
  ].join(" | ");
}

/** bucket → Map<label, item> for every bucket that holds row-shaped items. */
function bucketMap(env: Envelope, buckets: string[]): Map<string, { bucket: string; item: Record<string, unknown> }> {
  const m = new Map<string, { bucket: string; item: Record<string, unknown> }>();
  for (const b of buckets) {
    const arr = env[b];
    if (!Array.isArray(arr)) continue;
    for (const it of arr as Array<Record<string, unknown>>) {
      const key = rowLabel(it);
      // First writer wins so a label appearing twice (a genuine same-key pair) keeps a
      // deterministic mapping; the count deltas below are what catch the multiplicity.
      if (!m.has(key)) m.set(key, { bucket: b, item: it });
    }
  }
  return m;
}

const DELIVERIES_BUCKETS = ["new", "changed", "identity_diff", "noop", "flagged", "dup_noops", "malformed"];
const GSHEET_BUCKETS = ["new", "changed", "flagged", "noop", "unmapped", "malformed"];

function counts(env: Envelope, buckets: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of buckets) out[b] = Array.isArray(env[b]) ? (env[b] as unknown[]).length : 0;
  return out;
}

function diffLines(item: Record<string, unknown>): string[] {
  const d = item.diff;
  if (!Array.isArray(d)) return [];
  return (d as Array<Record<string, unknown>>).map((x) => {
    const mine = "emailValue" in x ? x.emailValue : x.sheetValue;
    return `\`${String(x.field)}\`: report/sheet **${fmt(mine)}** vs app **${fmt(x.dbValue)}**`;
  });
}
function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  if (typeof v === "object") return "`" + JSON.stringify(v) + "`";
  return String(v);
}

function section(
  title: string,
  oldEnv: Envelope,
  newEnv: Envelope,
  buckets: string[],
): string {
  const oc = counts(oldEnv, buckets);
  const nc = counts(newEnv, buckets);
  const lines: string[] = [`### ${title}`, "", "| bucket | before | after | Δ |", "|---|---|---|---|"];
  for (const b of buckets) {
    const d = nc[b] - oc[b];
    lines.push(`| \`${b}\` | ${oc[b]} | ${nc[b]} | ${d === 0 ? "—" : d > 0 ? `+${d}` : String(d)} |`);
  }
  lines.push("");

  const om = bucketMap(oldEnv, buckets);
  const nm = bucketMap(newEnv, buckets);
  const moved: string[] = [];
  for (const [label, nv] of nm) {
    const ov = om.get(label);
    const from = ov ? ov.bucket : "(absent)";
    if (from === nv.bucket) continue;
    moved.push(
      `- **${from} → ${nv.bucket}** — \`${label}\`\n` +
        (diffLines(nv.item).length ? diffLines(nv.item).map((l) => `    - ${l}`).join("\n") + "\n" : "") +
        (nv.item.reason ? `    - reason: ${String(nv.item.reason)}\n` : "") +
        (nv.item.note ? `    - note: ${String(nv.item.note)}\n` : ""),
    );
  }
  for (const [label, ov] of om) {
    if (!nm.has(label)) moved.push(`- **${ov.bucket} → (absent)** — \`${label}\``);
  }
  lines.push(moved.length ? `**${moved.length} row(s) changed bucket:**\n` : "_No row changed bucket._\n");
  lines.push(...moved);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  loadEnv();
  const outDir = resolve(process.argv[2] ?? join(WORKER, ".dryrun-identity"));
  mkdirSync(outDir, { recursive: true });

  const live = DbClient.fromEnv();
  const db = readOnly(live);

  process.stdout.write("Reading the LIVE DB window (writes are proxied to throw)…\n");
  const watermark = await db.dataWatermark("deliveries");
  const delSince = watermark ? minusDays(watermark, 3) : "2025-01-01";
  const gsSince = "2025-01-01"; // gsheet's LOCKED 2025 scope floor
  process.stdout.write(`  deliveries watermark ${watermark} → since ${delSince}; gsheet since ${gsSince}\n`);

  // The union window: gsheet needs 2025+, deliveries needs its own tail. Read the WIDER
  // one once and let each classifier's own `since` filter do the narrowing, exactly as
  // each runReport does.
  const deliveriesRows = (await db.readRows("deliveries", {
    sinceDate: gsSince,
    columns: [
      "id", "transaction_date", "supplier", "batch_code", "block_loc",
      "truck_plate", "sacks", "weight_kg", "cost_basis", "remarks", "lab_results",
    ],
  })) as Row[];
  const rcOutRows = (await db.readRows("rc_out", {
    sinceDate: gsSince,
    columns: [
      "id", "transaction_date", "batch_id", "production_batch", "destination",
      "weight_kg", "block_loc", "remarks",
    ],
  })) as Row[];
  const batchRows = await db.readRows("batches", { columns: ["batch_code", "id"], sinceColumn: null });
  const batchLookup: Record<string, string> = {};
  const batchCodes: string[] = [];
  for (const b of batchRows) {
    if (b.batch_code) {
      batchLookup[String(b.batch_code)] = String(b.id);
      batchCodes.push(String(b.batch_code));
    }
  }
  process.stdout.write(
    `  deliveries=${deliveriesRows.length} rc_out=${rcOutRows.length} batches=${batchCodes.length}\n`,
  );

  const dbWindowPath = join(outDir, "dbwindow.json");
  writeFileSync(
    dbWindowPath,
    JSON.stringify({ deliveries: deliveriesRows, rc_out: rcOutRows, batch_lookup: batchLookup, batch_codes: batchCodes }),
  );

  process.stdout.write("Fetching the REAL current sources…\n");
  const gsBuf = await downloadGsheet(globalThis.fetch as unknown as FetchLike, GSHEET_EXPORT_URL);
  const gsPath = join(outDir, "gsheet.xlsx");
  writeFileSync(gsPath, gsBuf);
  process.stdout.write(`  Google Sheet: ${gsBuf.length} bytes (live export)\n`);
  const delPath = (await newestDeliveriesWorkbook(outDir)) ?? "-";
  if (delPath === "-") process.stdout.write("  RC DELIVERIES workbook: NONE found in sync-inbox\n");

  // --- NEW side: this working tree ------------------------------------------------
  const newPath = join(outDir, "classified.new.json");
  process.stdout.write("Classifying with the NEW identity…\n");
  execFileSync(
    "npx",
    ["tsx", join(WORKER, "scripts/identity-dryrun-classify.ts"), dbWindowPath, newPath, delSince, gsSince, delPath, gsPath],
    { cwd: WORKER, stdio: "inherit" },
  );

  // --- OLD side: a pristine worktree at HEAD --------------------------------------
  const wt = join(outDir, "baseline-worktree");
  if (!existsSync(wt)) {
    execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: REPO, stdio: "inherit" });
  }
  const wtWorker = join(wt, "workers/sync");
  if (!existsSync(join(wtWorker, "node_modules"))) {
    symlinkSync(join(WORKER, "node_modules"), join(wtWorker, "node_modules"), "dir");
  }
  copyFileSync(
    join(WORKER, "scripts/identity-dryrun-classify.ts"),
    join(wtWorker, "scripts/identity-dryrun-classify.ts"),
  );
  const oldPath = join(outDir, "classified.old.json");
  process.stdout.write("Classifying with the OLD identity (pristine worktree at HEAD)…\n");
  execFileSync(
    "npx",
    ["tsx", join(wtWorker, "scripts/identity-dryrun-classify.ts"), dbWindowPath, oldPath, delSince, gsSince, delPath, gsPath],
    { cwd: wtWorker, stdio: "inherit" },
  );

  const oldSide = JSON.parse(readFileSync(oldPath, "utf8")) as Side;
  const newSide = JSON.parse(readFileSync(newPath, "utf8")) as Side;

  // --- Prove nothing was written ---------------------------------------------------
  const afterDeliveries = (await db.readRows("deliveries", { sinceDate: gsSince, columns: ["id"] })).length;
  const afterRcOut = (await db.readRows("rc_out", { sinceDate: gsSince, columns: ["id"] })).length;
  const wmAfter = await db.dataWatermark("deliveries");

  const md: string[] = [
    "# Dry run — the two-tier delivery identity (L-040b)",
    "",
    `Generated ${new Date().toISOString()} · **nothing was written** (every DbClient write method was proxied to throw).`,
    "",
    "## Inputs",
    "",
    `- Live DB window: \`deliveries\` ${deliveriesRows.length} rows, \`rc_out\` ${rcOutRows.length} rows, \`batches\` ${batchCodes.length} codes (since ${gsSince}).`,
    `- Google Sheet: pulled live from its XLSX export (${gsBuf.length} bytes).`,
    `- RC DELIVERIES workbook: ${delPath === "-" ? "**none available**" : "newest copy archived in the private `sync-inbox` Storage bucket (no Gmail session spent)"}.`,
    `- \`deliveries\` since = ${delSince} (watermark ${watermark} − 3d) · gsheet since = ${gsSince} (locked 2025 floor).`,
    "",
    "## What changed",
    "",
    section("RC DELIVERIES email → `deliveries`", oldSide.deliveries, newSide.deliveries, DELIVERIES_BUCKETS),
    section("Google Sheet RC IN → `deliveries`", oldSide.gsheet.rc_in, newSide.gsheet.rc_in, GSHEET_BUCKETS),
    section("Google Sheet RC OUT → `rc_out` (must be untouched)", oldSide.gsheet.rc_out, newSide.gsheet.rc_out, GSHEET_BUCKETS),
    "## Write-freedom check (re-read AFTER classifying)",
    "",
    `- \`deliveries\` rows since ${gsSince}: ${deliveriesRows.length} before → **${afterDeliveries} after**`,
    `- \`rc_out\` rows since ${gsSince}: ${rcOutRows.length} before → **${afterRcOut} after**`,
    `- \`deliveries\` watermark: ${watermark} before → **${wmAfter} after**`,
    "",
  ];
  const reportPath = join(outDir, "REPORT.md");
  writeFileSync(reportPath, md.join("\n"));
  process.stdout.write(`\nReport: ${reportPath}\n`);
}

function minusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n");
  process.exit(1);
});
