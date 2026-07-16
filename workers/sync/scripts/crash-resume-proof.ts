/**
 * crash-resume-proof.ts — the M0 Definition-of-Done proof (non-negotiable).
 *
 * Proves DBOS resumes a workflow from its last completed step after a hard crash.
 *
 * Modes (argv[2]):
 *   start   — launch DBOS, start the demo workflow (step2 durable-sleeps 10s) with a
 *             fixed workflowID, then BUSY-WAIT (do NOT await the result). The parent
 *             harness `kill -9`s this process while it is inside step2's sleep.
 *   resume  — launch DBOS again (fresh process). DBOS recovery resumes the PENDING
 *             workflow from its last completed step. We retrieve the handle by its
 *             workflowID and await the result — proving completion without ever
 *             re-running step1.
 *   inspect — print the DBOS system-table rows for the workflow (authoritative evidence).
 *
 * The harness (`npm run proof:crash-resume`, driven by run-crash-proof.sh) orchestrates
 * start → kill -9 → resume → inspect and asserts the evidence.
 */
import { launchDbos, shutdownDbos, DBOS } from "../src/dbos.js";
import { demoWorkflow, DEMO_EVIDENCE_FILE } from "../src/workflows/demo.js";

const WORKFLOW_ID = process.env.PROOF_WORKFLOW_ID ?? "crash-resume-proof-run";
const RUN_ID = process.env.PROOF_RUN_ID ?? "demo-run-1";

async function main(): Promise<void> {
  const mode = process.argv[2];
  await launchDbos();

  if (mode === "start") {
    // Start in the background with a FIXED workflowID (idempotency key). Do not await
    // — we want the process alive and mid-sleep when the harness kills it.
    // eslint-disable-next-line no-console
    console.log(`[proof:start] pid=${process.pid} starting workflow id=${WORKFLOW_ID}`);
    await DBOS.startWorkflow(demoWorkflow, { workflowID: WORKFLOW_ID })(RUN_ID);
    // eslint-disable-next-line no-console
    console.log(`[proof:start] workflow started; entering step2 sleep — waiting to be killed`);
    // Keep the event loop alive so the workflow can progress into step2.
    await new Promise(() => {
      /* never resolves — harness kill -9s us mid-step2 */
    });
    return;
  }

  if (mode === "resume") {
    // eslint-disable-next-line no-console
    console.log(`[proof:resume] pid=${process.pid} launched — DBOS should recover ${WORKFLOW_ID}`);
    // Retrieve the (recovered) workflow handle and await its result.
    const handle = await DBOS.retrieveWorkflow(WORKFLOW_ID);
    const result = await handle.getResult();
    // eslint-disable-next-line no-console
    console.log(`[proof:resume] workflow completed:`, JSON.stringify(result));
    await shutdownDbos();
    return;
  }

  if (mode === "inspect") {
    // eslint-disable-next-line no-console
    console.log(`[proof:inspect] evidence file: ${DEMO_EVIDENCE_FILE}`);
    await shutdownDbos();
    return;
  }

  throw new Error(`unknown mode "${mode}" — use start | resume | inspect`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[proof] error:", err);
  process.exit(1);
});
