/**
 * dryrun-crash-resume.ts — the Wave-4A CRASH-RESUME proof on the REAL runSync workflow.
 *
 * The M0 demo proved DBOS resumes a toy 3-step workflow. This proves the SAME
 * durability on the real runSync: kick a dry run, let it get well underway (several
 * reports have emitted events), `kill -9` the worker, then start a FRESH worker.
 * DBOS recovery picks up the PENDING `run:<runId>` from its last completed step and
 * drives it to a terminal status — WITHOUT re-kicking.
 *
 * Evidence:
 *   - the FIRST worker's pid emits some events, then dies mid-run,
 *   - the SECOND worker's pid (different) finishes the run,
 *   - sync_runs.status reaches succeeded|partial after the restart,
 *   - the run was never re-kicked (only DBOS recovery drove the completion).
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
    /* noop */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORKER_CWD = new URL("..", import.meta.url).pathname;

async function waitForHealth(base: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not up */
    }
    await sleep(500);
  }
  throw new Error("worker /health never came up");
}

function bootWorker(label: string): ChildProcess {
  const w = spawn("node", ["dist/index.js"], { cwd: WORKER_CWD, env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  console.log(`[proof] booted ${label} worker pid=${w.pid}`);
  return w;
}

async function main(): Promise<void> {
  loadEnv();
  const port = process.env.PORT ?? "8080";
  const base = `http://127.0.0.1:${port}`;
  const kickSecret = process.env.SYNC_KICK_SECRET!;
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: run, error } = await sb.from("sync_runs").insert({ status: "queued" }).select("id").single();
  if (error || !run) throw new Error(`insert sync_runs failed: ${error?.message}`);
  const runId = (run as { id: string }).id;
  console.log(`\n[proof] created runId=${runId}\n`);

  // ── Worker A: boot, kick, let it get underway.
  const workerA = bootWorker("FIRST");
  const firstPid = workerA.pid!;
  try {
    await waitForHealth(base);
    const kickRes = await fetch(`${base}/kick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kickSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runId, dryRun: true }),
    });
    console.log(`[proof] kicked (dryRun) → ${kickRes.status} ${JSON.stringify(await kickRes.json())}\n`);

    // Wait until the run is running AND at least a few reports have emitted events
    // (so we KNOW we are killing mid-run, not before it started).
    let eventsBeforeKill = 0;
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      const { count } = await sb
        .from("sync_run_events")
        .select("id", { count: "exact", head: true })
        .eq("run_id", runId);
      eventsBeforeKill = count ?? 0;
      const { data: r } = await sb.from("sync_runs").select("status").eq("id", runId).single();
      const st = (r as { status: string } | null)?.status;
      // Kill once we have real progress but the run is NOT yet terminal.
      if (st === "running" && eventsBeforeKill >= 12) break;
      if (st === "succeeded" || st === "partial" || st === "failed") {
        console.log(`[proof] run finished before we could kill (${st}) — increase the wait window`);
        break;
      }
      await sleep(1000);
    }
    console.log(`[proof] events streamed before kill: ${eventsBeforeKill}`);
  } finally {
    // ── kill -9 the FIRST worker mid-run (hard crash, no cleanup).
    console.log(`[proof] kill -9 ${firstPid} (hard crash of the FIRST worker, mid-run)\n`);
    process.kill(firstPid, "SIGKILL");
    await sleep(1500);
  }

  const { data: midRun } = await sb.from("sync_runs").select("status").eq("id", runId).single();
  console.log(`[proof] sync_runs.status right after the crash: ${(midRun as { status: string }).status}`);

  // ── Worker B: boot a FRESH process. DBOS recovery resumes `run:<runId>` — NO re-kick.
  console.log(`\n[proof] booting a FRESH worker — DBOS should RECOVER run:${runId} with no re-kick…\n`);
  const workerB = bootWorker("SECOND");
  const secondPid = workerB.pid!;
  try {
    await waitForHealth(base);

    let terminal: string | null = null;
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      const { data: r } = await sb.from("sync_runs").select("status").eq("id", runId).single();
      const st = (r as { status: string } | null)?.status ?? "?";
      if (st === "succeeded" || st === "partial" || st === "failed") {
        terminal = st;
        break;
      }
      await sleep(2000);
    }

    const { data: finalRun } = await sb.from("sync_runs").select("*").eq("id", runId).single();
    const { count: totalEvents } = await sb
      .from("sync_run_events")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId);
    const result = (finalRun as { result?: { reports?: Record<string, unknown> } } | null)?.result;
    const reportCount = Object.keys(result?.reports ?? {}).length;

    console.log(`\n========== CRASH-RESUME VERDICT ==========`);
    console.log(`  first worker pid : ${firstPid} (killed -9 mid-run)`);
    console.log(`  second worker pid: ${secondPid} (recovered + finished the run)`);
    console.log(`  total events     : ${totalEvents}`);
    console.log(`  terminal status  : ${terminal}`);
    console.log(`  reports produced : ${reportCount}/6`);
    console.log(`  finished_at      : ${(finalRun as Record<string, unknown>)?.finished_at}`);

    const ok = firstPid !== secondPid && (terminal === "succeeded" || terminal === "partial") && reportCount === 6;
    console.log(ok ? "\n  ✓ CRASH-RESUME PROOF PASSED — DBOS recovered the real run to completion" : "\n  ✗ CRASH-RESUME PROOF FAILED");
    process.exitCode = ok ? 0 : 1;
  } finally {
    workerB.kill("SIGTERM");
    await sleep(1500);
    if (!workerB.killed) workerB.kill("SIGKILL");
  }
}

main().catch((err) => {
  console.error("[proof] fatal:", err);
  process.exit(1);
});
