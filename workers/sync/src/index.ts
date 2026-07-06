/**
 * index.ts — the sync worker entrypoint.
 *
 * Boot order (matters):
 *   1. Import all workflow modules so DBOS.registerWorkflow runs for each BEFORE
 *      launch — DBOS must know every workflow at launch time so it can recover
 *      PENDING ones. (Side-effect imports below.)
 *   2. launchDbos() — connects to the system DB and RESUMES any incomplete workflows
 *      from their last completed step.
 *   3. recoverOrphanedRuns() — the ROOT self-heal: re-start any sync_runs row still
 *      'queued' (its kick was lost while the worker slept). Deterministic workflowID
 *      makes this idempotent (DBOS dedups an already-started/recovered run).
 *   4. startKickServer() — begins accepting POST /kick, POST /cancel, GET /health.
 *   5. startStaleRunWatchdog() — periodic sweep that auto-expires orphaned/stalled runs.
 *
 * On SIGTERM/SIGINT (Fly auto-stop, deploy) we stop the watchdog + shut DBOS down cleanly.
 */
// MUST be first: loads workers/sync/.env into process.env (local dev) before any
// module reads a credential. No-op on Fly (secrets already in the environment).
import "./loadEnv.js";

import { launchDbos, shutdownDbos } from "./dbos.js";
import { startKickServer } from "./server/kick.js";
import { recoverOrphanedRuns, startStaleRunWatchdog } from "./server/selfHeal.js";

// Side-effect imports: register every workflow before launch.
import "./workflows/demo.js";
import "./workflows/mailClerk.js";
import "./workflows/reportWorkflow.js";
import "./workflows/runSync.js";

async function main(): Promise<void> {
  await launchDbos();

  // Root self-heal: re-start orphaned 'queued' runs whose kick was lost. Best-effort —
  // never blocks the server from coming up. (Idempotent via deterministic workflowID.)
  void recoverOrphanedRuns();

  const server = startKickServer();
  const watchdog = startStaleRunWatchdog();

  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[worker] ${sig} — shutting down`);
    watchdog.stop();
    server.close();
    await shutdownDbos();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // eslint-disable-next-line no-console
  console.log("[worker] ready");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal:", err);
  process.exit(1);
});
