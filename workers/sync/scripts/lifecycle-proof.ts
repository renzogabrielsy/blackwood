/**
 * lifecycle-proof.ts — M5.1 lifecycle-controls runtime proof, fully LOCAL.
 *
 * The sandbox cannot open a raw Postgres handshake to Supabase, so (like every other
 * DBOS runtime proof in this package) this runs against a LOCAL Postgres. Point
 * DBOS_DATABASE_URL and PROOF_PG_URL at it (the harness at the bottom of this file's
 * companion shell wires that up).
 *
 * It proves the three behaviors that genuinely need a running system:
 *
 *   PART A — GRACEFUL CANCEL (DBOS mechanics)
 *     A test workflow durable-sleeps, then does more work. We cancel it mid-sleep via
 *     DBOS.cancelWorkflow. Assert: (1) the workflow body observed a
 *     DBOSWorkflowCancelledError at its next step boundary — i.e. it can catch the
 *     cancel and settle 'cancelled' (exactly what runSync/reportWorkflow do);
 *     (2) DBOS.getWorkflowStatus → 'CANCELLED'; (3) the work AFTER the cancel point
 *     never ran (no rollback of the work BEFORE it — the "keep already-written rows"
 *     guarantee, modeled by an evidence file the pre-cancel step wrote).
 *
 *   PART B — STARTUP-RECOVERY DEDUP (deterministic workflowID)
 *     startWorkflow the SAME deterministic workflowID twice. Assert the body ran
 *     exactly ONCE — this is why recoverOrphanedRuns can blindly re-start every
 *     'queued' run without double-execution.
 *
 *   PART C — WATCHDOG's getWorkflowStatus cross-check
 *     A running workflow reports a LIVE status (PENDING); a cancelled one reports
 *     CANCELLED. This is the exact signal isLiveDbosWorkflow() reads to avoid
 *     expiring a genuinely-running run.
 *
 *   PART D — sync_runs SQL SEMANTICS (against local PG via `pg`, mirroring DbClient)
 *     Recreates the sync_runs/sync_run_events shape locally and drives the EXACT
 *     query semantics of cancelSyncRunIfActive / failSyncRunIfActive / listActiveRuns
 *     / latestEventAt + the sweepStaleRuns staleness math, proving: a stale run is
 *     expired, a FRESH run is NOT, and the status-guard never clobbers a terminal run.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { STALE_RUN_MINUTES } from "../src/server/selfHeal.js";

// `pg` ships no bundled types and this proof is its ONLY consumer here. Rather than add
// @types/pg as a dependency (or an ambient .d.ts that would leak into the whole build),
// load the Client via createRequire and give it a minimal local constructor type.
type PgClientCtor = new (config?: { connectionString?: string }) => unknown;
const require = createRequire(import.meta.url);
const Client = (require("pg") as { Client: PgClientCtor }).Client;

const EVIDENCE = process.env.PROOF_EVIDENCE_FILE ?? "/tmp/bw-lifecycle-evidence.txt";
const note = (s: string) => appendFileSync(EVIDENCE, s + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failures++;
  }
}

// ── A test workflow modeling runSync's cancel-catch shape. ───────────────────
// Step 1 (pre-cancel) writes "APPLIED" evidence — models rows written before Stop.
// Then a durable sleep (the cancel lands here). Step 2 (post-cancel) writes "AFTER"
// evidence — it must NEVER run once cancelled. The body catches the cancellation and
// records that it saw it (mirroring runSyncGuarded / reportWorkflowBody).
let cancelWorkflowRuns = 0;
async function cancelBody(runId: string): Promise<string> {
  cancelWorkflowRuns++;
  await DBOS.runStep(async () => {
    note(`APPLIED run=${runId}`); // pre-cancel work — kept, never rolled back
  }, { name: "preCancelApply" });
  try {
    await DBOS.sleep(8000); // cancel lands here (durable sleep = a step boundary)
    await DBOS.runStep(async () => {
      note(`AFTER run=${runId}`); // must NOT run if cancelled
    }, { name: "postCancelWork" });
    return "completed";
  } catch (err) {
    if (
      err instanceof DBOSErrors.DBOSWorkflowCancelledError ||
      err instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError
    ) {
      note(`CAUGHT_CANCEL run=${runId}`);
      throw err; // re-throw so DBOS records CANCELLED (exactly like the real workflows)
    }
    note(`CAUGHT_OTHER run=${runId} ${String(err)}`);
    throw err;
  }
}
const cancelWorkflow = DBOS.registerWorkflow(cancelBody, { name: "cancelTestWf" });

// ── A quick workflow for the dedup proof. ────────────────────────────────────
let dedupRuns = 0;
async function dedupBody(): Promise<number> {
  dedupRuns++;
  await DBOS.runStep(async () => { await sleep(50); }, { name: "s" });
  return dedupRuns;
}
const dedupWorkflow = DBOS.registerWorkflow(dedupBody, { name: "dedupTestWf" });

async function partA_and_C(): Promise<void> {
  console.log("\nPART A — graceful cancel + PART C — getWorkflowStatus cross-check:");
  const runId = "cancel-me-1";
  const wfId = `run:${runId}`;
  const handle = await DBOS.startWorkflow(cancelWorkflow, { workflowID: wfId })(runId);

  // Wait until the pre-cancel step has run (APPLIED evidence present).
  for (let i = 0; i < 60; i++) {
    if (readFileSync(EVIDENCE, "utf8").includes(`APPLIED run=${runId}`)) break;
    await sleep(100);
  }
  assert(readFileSync(EVIDENCE, "utf8").includes(`APPLIED run=${runId}`), "pre-cancel step ran (rows 'applied' before Stop)");

  // PART C: a running workflow reports a LIVE status (the watchdog would NOT expire it).
  const liveStatus = await DBOS.getWorkflowStatus(wfId);
  assert(!!liveStatus && ["PENDING", "ENQUEUED"].includes(liveStatus.status),
    `running workflow status is live (${liveStatus?.status}) — watchdog leaves it alone`);

  // Cancel it (the Stop button's DBOS.cancelWorkflow).
  await DBOS.cancelWorkflow(wfId, { cancelChildren: true });

  // The body should observe the cancellation and re-throw → handle rejects.
  let rejected = false;
  try {
    await handle.getResult();
  } catch {
    rejected = true;
  }
  assert(rejected, "cancelled workflow's getResult rejects (surfaced to the parent)");

  // Give DBOS a moment to persist the terminal status.
  await sleep(500);
  const ev = readFileSync(EVIDENCE, "utf8");
  assert(ev.includes(`CAUGHT_CANCEL run=${runId}`), "workflow body CAUGHT the DBOSWorkflowCancelledError (settles 'cancelled', not 'failed')");
  assert(!ev.includes(`AFTER run=${runId}`), "post-cancel work did NOT run (stopped at the next step boundary)");
  assert(ev.includes(`APPLIED run=${runId}`), "pre-cancel 'applied' evidence is STILL present (nothing rolled back)");

  // PART C: after cancel, status is CANCELLED (the watchdog's terminal signal).
  const cancelledStatus = await DBOS.getWorkflowStatus(wfId);
  assert(cancelledStatus?.status === "CANCELLED", `cancelled workflow status is CANCELLED (${cancelledStatus?.status})`);
}

async function partB(): Promise<void> {
  console.log("\nPART B — startup-recovery dedup (deterministic workflowID):");
  const wfId = "run:recover-dedup-1";
  const h1 = await DBOS.startWorkflow(dedupWorkflow, { workflowID: wfId })();
  await h1.getResult();
  // Re-start the SAME id — models recoverOrphanedRuns re-kicking an already-run run.
  const h2 = await DBOS.startWorkflow(dedupWorkflow, { workflowID: wfId })();
  await h2.getResult();
  assert(dedupRuns === 1, `body ran exactly ONCE across two startWorkflow calls with the same id (ran ${dedupRuns}×) — recovery is idempotent`);
}

// ── PART D — sync_runs SQL semantics against local PG (mirrors DbClient exactly). ──
// Minimal typed rows (no @types/pg dependency — this proof owns its own shapes).
interface ActiveRow {
  id: string;
  status: string;
  created_at: string;
}
// pg's Client is untyped here; a tiny structural type keeps tsc strict without @types/pg.
interface PgLike {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end(): Promise<void>;
}

async function partD(): Promise<void> {
  console.log("\nPART D — sync_runs SQL semantics + watchdog staleness (local PG):");
  const pgUrl = process.env.PROOF_PG_URL!;
  const pg = new Client({ connectionString: pgUrl }) as unknown as PgLike;
  await pg.connect();

  const id = (r: { rows: Array<Record<string, unknown>> }): string => String(r.rows[0].id);

  // Minimal shape (public schema) matching the migration's columns we touch.
  await pg.query(`
    drop table if exists sync_run_events;
    drop table if exists sync_runs;
    create table sync_runs (
      id uuid primary key default gen_random_uuid(),
      status text not null default 'queued',
      started_at timestamptz, finished_at timestamptz,
      result jsonb, error text, created_at timestamptz not null default now()
    );
    create table sync_run_events (
      id bigint generated always as identity primary key,
      run_id uuid not null references sync_runs(id) on delete cascade,
      report_type text, stage text, pct int, label text, detail text, level text,
      at timestamptz not null default now()
    );
  `);

  const staleMs = STALE_RUN_MINUTES * 60 * 1000;

  // Seed: (1) FRESH running run w/ a recent event; (2) STALE running run w/ an old
  // event; (3) STALE queued run w/ NO events (old created_at); (4) already-terminal
  // 'succeeded' run (the status-guard must never touch it).
  const fresh = id(await pg.query(`insert into sync_runs(status, created_at) values('running', now()) returning id`));
  await pg.query(`insert into sync_run_events(run_id, stage, label, at) values($1,'classify','recent', now())`, [fresh]);

  const staleRunning = id(await pg.query(`insert into sync_runs(status, created_at) values('running', now() - interval '30 min') returning id`));
  await pg.query(`insert into sync_run_events(run_id, stage, label, at) values($1,'classify','old', now() - interval '20 min')`, [staleRunning]);

  const staleQueued = id(await pg.query(`insert into sync_runs(status, created_at) values('queued', now() - interval '30 min') returning id`));

  const doneRun = id(await pg.query(`insert into sync_runs(status, created_at, finished_at) values('succeeded', now() - interval '30 min', now() - interval '29 min') returning id`));

  // --- listActiveRuns(queued|running) — the watchdog's candidate set. -----------
  const active = (
    await pg.query(`select id,status,created_at from sync_runs where status in ('queued','running') order by created_at asc`)
  ).rows as unknown as ActiveRow[];
  assert(active.length === 3 && !active.some((r) => r.id === doneRun),
    "listActiveRuns returns only non-terminal runs (terminal 'succeeded' excluded)");

  // --- latestEventAt + staleness math (isStale). --------------------------------
  const latestEventAt = async (runId: string): Promise<string | null> => {
    const r = await pg.query(`select at from sync_run_events where run_id=$1 order by at desc limit 1`, [runId]);
    const at = r.rows[0]?.at;
    return at ? new Date(at as string | number | Date).toISOString() : null;
  };
  const isStale = (latest: string | null, created: string): boolean => {
    const cutoff = Date.now() - staleMs;
    if (latest) return new Date(latest).getTime() < cutoff;
    return new Date(created).getTime() < cutoff;
  };
  const freshCreated = active.find((r) => r.id === fresh)!.created_at;
  const staleRunningCreated = active.find((r) => r.id === staleRunning)!.created_at;
  const staleQueuedCreated = active.find((r) => r.id === staleQueued)!.created_at;

  assert(!isStale(await latestEventAt(fresh), freshCreated), "FRESH run (recent event) is NOT stale — never expired");
  assert(isStale(await latestEventAt(staleRunning), staleRunningCreated), "STALE running run (old event) IS stale");
  assert(isStale(await latestEventAt(staleQueued), staleQueuedCreated), "STALE queued run (no events, old created_at) IS stale");

  // --- failSyncRunIfActive semantics: expire ONLY if still non-terminal. --------
  const failIfActive = async (runId: string): Promise<number> => {
    const r = await pg.query(
      `update sync_runs set status='failed', error=$2, finished_at=now() where id=$1 and status in ('queued','running') returning id`,
      [runId, "Auto-expired: no progress for >15 min (worker likely restarted or the run was orphaned)."],
    );
    return r.rowCount ?? 0;
  };
  assert((await failIfActive(staleRunning)) === 1, "watchdog expires the stale running run (→ failed)");
  assert((await failIfActive(staleQueued)) === 1, "watchdog expires the stale queued run (→ failed)");
  assert((await failIfActive(fresh)) === 1, "guard would expire fresh IF asked — but the staleness gate above prevents that call");
  // Terminal-guard: trying to expire the already-succeeded run changes NOTHING.
  assert((await failIfActive(doneRun)) === 0, "status-guard: expiring an already-terminal run is a no-op (never clobbers 'succeeded')");

  // --- cancelSyncRunIfActive semantics: cancel only non-terminal; never clobber. -
  const cancelIfActive = async (runId: string): Promise<number> => {
    const r = await pg.query(
      `update sync_runs set status='cancelled', finished_at=now() where id=$1 and status in ('queued','running') returning id`,
      [runId],
    );
    return r.rowCount ?? 0;
  };
  const toCancel = id(await pg.query(`insert into sync_runs(status) values('running') returning id`));
  assert((await cancelIfActive(toCancel)) === 1, "cancelSyncRunIfActive flips a running run → cancelled");
  assert((await cancelIfActive(toCancel)) === 0, "cancelSyncRunIfActive on an already-cancelled run is a no-op (idempotent Stop)");
  assert((await cancelIfActive(doneRun)) === 0, "cancelSyncRunIfActive never clobbers a terminal 'succeeded' run");

  await pg.end();
}

async function main(): Promise<void> {
  writeFileSync(EVIDENCE, "");
  await DBOS.setConfig({ name: "blackwood-sync-lifecycle-proof", systemDatabaseUrl: process.env.DBOS_DATABASE_URL! });
  await DBOS.launch();
  try {
    await partA_and_C();
    await partB();
    await partD();
  } finally {
    await DBOS.shutdown();
  }
  assert(cancelWorkflowRuns >= 1, "cancel test workflow executed");
  console.log(`\n${failures === 0 ? "=== ALL LIFECYCLE PROOFS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[lifecycle-proof] fatal:", err);
  process.exit(1);
});
