/**
 * index.ts — the sync worker entrypoint.
 *
 * Boot order (matters):
 *   0. logBuildBanner() — logs `[blackwood-sync] build <sha> · <mode> · started <time>`
 *      before anything else, so a restart's logs immediately answer "did this pick up
 *      the new code?" (guards a stale compiled dist/ silently running old code).
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

import { execSync } from "node:child_process";

import { launchDbos, shutdownDbos } from "./dbos.js";
import { startKickServer } from "./server/kick.js";
import { recoverOrphanedRuns, startStaleRunWatchdog } from "./server/selfHeal.js";

// Side-effect imports: register every workflow before launch.
import "./workflows/demo.js";
import "./workflows/mailClerk.js";
import "./workflows/reportWorkflow.js";
import "./workflows/runSync.js";

// Injected by esbuild.config.mjs's `define` at compile time (npm run build / npm start).
// NOT defined under `npm run dev` (tsx runs src/index.ts directly, no esbuild pass) —
// every read below must guard for `undefined`.
declare const __BUILD_SHA__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

/**
 * Logs a one-line build-identity banner as the very first thing the process does —
 * before DBOS/worker init — so "did my restart actually pick up the new code?" is
 * answerable at a glance. Guards a real gotcha: a stale compiled dist/ can silently
 * keep running old code after a source edit.
 */
function logBuildBanner(): void {
  const startedAt = new Date().toISOString();
  const isDist = typeof __BUILD_SHA__ !== "undefined";

  let sha: string;
  let mode: string;
  let builtSuffix = "";
  if (isDist) {
    sha = __BUILD_SHA__ as string;
    mode = "dist";
    if (typeof __BUILD_TIME__ !== "undefined") {
      builtSuffix = ` · built ${__BUILD_TIME__}`;
    }
  } else {
    mode = "source (tsx)";
    try {
      sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {
      sha = "source";
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[blackwood-sync] build ${sha} · ${mode}${builtSuffix} · started ${startedAt}`);
}

async function main(): Promise<void> {
  logBuildBanner();

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
