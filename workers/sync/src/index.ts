/**
 * index.ts — the sync worker entrypoint.
 *
 * Boot order (matters):
 *   1. Import all workflow modules so DBOS.registerWorkflow runs for each BEFORE
 *      launch — DBOS must know every workflow at launch time so it can recover
 *      PENDING ones. (Side-effect imports below.)
 *   2. launchDbos() — connects to the system DB and RESUMES any incomplete workflows
 *      from their last completed step.
 *   3. startKickServer() — begins accepting POST /kick and GET /health.
 *
 * On SIGTERM/SIGINT (Fly auto-stop, deploy) we shut DBOS down cleanly.
 */
import { launchDbos, shutdownDbos } from "./dbos.js";
import { startKickServer } from "./server/kick.js";

// Side-effect imports: register every workflow before launch.
import "./workflows/demo.js";
import "./workflows/mailClerk.js";
import "./workflows/runSync.js";

async function main(): Promise<void> {
  await launchDbos();
  const server = startKickServer();

  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[worker] ${sig} — shutting down`);
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
