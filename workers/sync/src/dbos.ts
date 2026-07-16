/**
 * dbos.ts — DBOS durable-execution setup for the sync worker.
 *
 * Written against the CURRENT @dbos-inc/dbos-sdk v4 functional API (verified from
 * https://docs.dbos.dev/typescript/programming-guide, 2026-07-04):
 *   - DBOS.setConfig({ name, systemDatabaseUrl })  — config (system DB = Postgres).
 *   - DBOS.launch()                                — connect + START RECOVERY of any
 *     incomplete workflows from their last completed step.
 *   - DBOS.registerWorkflow(fn)                    — register a durable workflow.
 *   - DBOS.runStep(fn, { name })                   — checkpoint a step's result.
 *   - DBOS.startWorkflow(wf, { workflowID })(...)  — start in background, get a handle.
 *   - DBOS.sleep(ms)                               — DURABLE sleep (survives restart).
 *
 * SYSTEM DATABASE (DBOS_DATABASE_URL): DBOS checkpoints every workflow/step into a
 * Postgres system database. It requires a DIRECT Postgres connection — NOT the
 * Supabase pooler in TRANSACTION mode (transaction pooling breaks the session-level
 * state DBOS relies on: advisory locks, LISTEN/NOTIFY, prepared statements). For
 * Supabase you must use either the SESSION-mode pooler (port 5432) or the direct DB
 * host connection string, with the DB password. See workers/sync/README.md and
 * .env.example (DBOS_DATABASE_URL).
 */
import { DBOS } from "@dbos-inc/dbos-sdk";

let _launched = false;

export interface DbosSetupOptions {
  /** App name recorded in the DBOS system tables. */
  appName?: string;
  /** Postgres URL for the DBOS SYSTEM database (checkpoints). */
  systemDatabaseUrl?: string;
}

/**
 * Configure + launch DBOS. Idempotent: safe to call once at process start.
 * On launch, DBOS automatically recovers (resumes) any workflows that were PENDING
 * when a previous process crashed — from their last completed step.
 */
export async function launchDbos(opts: DbosSetupOptions = {}): Promise<void> {
  if (_launched) return;
  const systemDatabaseUrl =
    opts.systemDatabaseUrl ?? process.env.DBOS_DATABASE_URL ?? process.env.DBOS_SYSTEM_DATABASE_URL;
  if (!systemDatabaseUrl) {
    throw new Error(
      "DBOS_DATABASE_URL is not set — DBOS needs a DIRECT Postgres connection string " +
        "for its system (checkpoint) database. In prod: the Supabase session-mode pooler " +
        "(port 5432) or direct DB host + password. See .env.example."
    );
  }
  DBOS.setConfig({
    name: opts.appName ?? "blackwood-sync",
    systemDatabaseUrl,
  });
  await DBOS.launch();
  _launched = true;
}

/** Shut DBOS down cleanly (tests / graceful stop). */
export async function shutdownDbos(): Promise<void> {
  if (!_launched) return;
  await DBOS.shutdown();
  _launched = false;
}

export function isDbosLaunched(): boolean {
  return _launched;
}

export { DBOS };
