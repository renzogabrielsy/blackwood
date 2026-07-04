/**
 * dryrun-proof.ts — the Wave-4A end-to-end DRY-RUN proof (the M4-worker DoD).
 *
 * Proves the REAL runSync workflow runs all six reports end to end against LIVE
 * Gmail/Sheet + the live DB, streaming events into sync_run_events and finishing with
 * a full result jsonb — WITHOUT writing any data (dryRun).
 *
 * Steps:
 *   1. Insert a sync_runs row (service role) → get its runId.
 *   2. Boot the worker (dist/index.js) as a child; wait for /health.
 *   3. POST /kick { runId, dryRun:true }.
 *   4. Poll sync_run_events + sync_runs until the run reaches a terminal status.
 *   5. Print the event stream, the six report envelopes, and the status transitions.
 *
 * Read-only against the DB in the sense that dryRun blocks every apply mutation; it
 * DOES insert the sync_runs/sync_run_events bookkeeping rows (that IS the ledger).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("worker /health never came up");
}

async function main(): Promise<void> {
  loadEnv();
  const port = process.env.PORT ?? "8080";
  const base = `http://127.0.0.1:${port}`;
  const kickSecret = process.env.SYNC_KICK_SECRET!;
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Insert a sync_runs row.
  const { data: run, error: insErr } = await sb
    .from("sync_runs")
    .insert({ status: "queued" })
    .select("id")
    .single();
  if (insErr || !run) throw new Error(`insert sync_runs failed: ${insErr?.message}`);
  const runId = (run as { id: string }).id;
  console.log(`\n[proof] created sync_runs row runId=${runId} (status=queued)\n`);

  // 2. Boot the worker.
  const worker: ChildProcess = spawn("node", ["dist/index.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  worker.on("exit", (code, sig) => console.log(`[proof] worker exited code=${code} sig=${sig}`));

  try {
    await waitForHealth(base);
    console.log(`[proof] worker healthy on ${base}\n`);

    // 3. Kick with dryRun.
    const kickRes = await fetch(`${base}/kick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kickSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runId, dryRun: true }),
    });
    const kickBody = await kickRes.json();
    console.log(`[proof] POST /kick → ${kickRes.status} ${JSON.stringify(kickBody)}\n`);

    // 4. Poll until terminal.
    const seenStatuses: string[] = [];
    let terminal: string | null = null;
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      const { data: r } = await sb.from("sync_runs").select("status").eq("id", runId).single();
      const st = (r as { status: string } | null)?.status ?? "?";
      if (seenStatuses[seenStatuses.length - 1] !== st) {
        seenStatuses.push(st);
        console.log(`[proof] sync_runs.status → ${st}`);
      }
      if (st === "succeeded" || st === "failed" || st === "partial") {
        terminal = st;
        break;
      }
      await sleep(2000);
    }

    // 5. Report.
    const { data: events } = await sb
      .from("sync_run_events")
      .select("report_type, stage, pct, label, detail, level, at")
      .eq("run_id", runId)
      .order("at", { ascending: true });
    const { data: finalRun } = await sb.from("sync_runs").select("*").eq("id", runId).single();

    console.log(`\n========== EVENT STREAM (sync_run_events) ==========`);
    for (const e of (events ?? []) as Array<Record<string, unknown>>) {
      const lvl = e.level === "warn" ? "WARN" : "info";
      console.log(
        `  [${String(e.report_type).padEnd(18)}] ${String(e.stage).padEnd(9)} ${String(e.pct).padStart(3)}%  ${lvl}  ${e.label}` +
          (e.detail ? `  ·· ${e.detail}` : ""),
      );
    }
    console.log(`  (${(events ?? []).length} events total)`);

    console.log(`\n========== STATUS TRANSITIONS ==========`);
    console.log(`  ${["queued", ...seenStatuses].join(" → ")}`);

    console.log(`\n========== REPORT ENVELOPES (sync_runs.result.reports) ==========`);
    const result = (finalRun as { result?: { reports?: Record<string, Record<string, unknown>> } } | null)?.result;
    const reports = result?.reports ?? {};
    for (const [rt, env] of Object.entries(reports)) {
      const c = (env.counts ?? {}) as Record<string, number>;
      const gates = (env.gate_failures as unknown[] | undefined)?.length ?? 0;
      console.log(
        `  ${rt.padEnd(20)} ok=${String(env.ok).padEnd(5)} noop=${c.noop ?? 0} new=${c.insert ?? 0} chg=${c.update ?? 0} flagged=${c.flagged ?? 0} gates=${gates}` +
          (env.error ? `  ERROR: ${env.error}` : ""),
      );
    }

    console.log(`\n========== FINAL RUN ROW ==========`);
    const fr = finalRun as Record<string, unknown> | null;
    console.log(`  status=${fr?.status} dryRun=${(result as { dryRun?: boolean })?.dryRun} reportsWithFiles=${(result as { reportsWithFiles?: number })?.reportsWithFiles}`);
    console.log(`  started_at=${fr?.started_at}`);
    console.log(`  finished_at=${fr?.finished_at}`);
    console.log(`  error=${fr?.error ?? "(none)"}`);

    const reportCount = Object.keys(reports).length;
    const ok = (terminal === "succeeded" || terminal === "partial") && reportCount === 6;
    console.log(`\n========== VERDICT ==========`);
    console.log(`  terminal status: ${terminal}`);
    console.log(`  reports produced: ${reportCount}/6`);
    console.log(ok ? "  ✓ DRY-RUN PROOF PASSED" : "  ✗ DRY-RUN PROOF FAILED");
    process.exitCode = ok ? 0 : 1;
  } finally {
    worker.kill("SIGTERM");
    await sleep(1500);
    if (!worker.killed) worker.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error("[proof] fatal:", err);
  process.exit(1);
});
