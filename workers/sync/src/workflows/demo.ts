/**
 * demo.ts — the M0 CRASH-RESUME PROOF workflow.
 *
 * A 3-step durable workflow. Step 2 sleeps 10s. The proof (scripts/crash-resume-proof.ts):
 *   1. start the workflow with a known workflowID,
 *   2. `kill -9` the worker while it is inside step 2's sleep,
 *   3. restart the worker → DBOS recovers the PENDING workflow and RESUMES from the
 *      last completed step (step 1 is NOT re-run; step 2 continues; step 3 runs),
 *   4. the workflow completes and writes its result.
 *
 * Each step appends a line to a shared evidence file so we can PROVE which steps ran
 * in which process (each process writes its own PID). If recovery works, step 1's
 * line is written by the FIRST pid and NOT repeated by the second — step 2/3 by the
 * second pid. DBOS's own system tables (workflow_status / operation_outputs) are the
 * authoritative evidence; the file is the human-readable corroboration.
 */
import { DBOS } from "../dbos.js";
import { appendFileSync } from "node:fs";

export const DEMO_EVIDENCE_FILE =
  process.env.DEMO_EVIDENCE_FILE ?? "/tmp/dbos-crash-resume-evidence.log";

function evidence(line: string): void {
  const stamped = `${new Date().toISOString()} pid=${process.pid} ${line}\n`;
  appendFileSync(DEMO_EVIDENCE_FILE, stamped);
  // eslint-disable-next-line no-console
  console.log("[demo]", stamped.trim());
}

async function stepOne(runId: string): Promise<string> {
  evidence(`STEP1 start run=${runId}`);
  await new Promise((r) => setTimeout(r, 200));
  evidence(`STEP1 done run=${runId}`);
  return "step1-result";
}

async function stepTwoSlow(runId: string): Promise<string> {
  evidence(`STEP2 start run=${runId} (about to durable-sleep 10s)`);
  // DURABLE sleep — DBOS records the wakeup time, so if the process is killed mid
  // sleep and restarts, it does NOT re-run step 1 and resumes waiting here.
  await DBOS.sleep(10_000);
  evidence(`STEP2 done run=${runId}`);
  return "step2-result";
}

async function stepThree(runId: string): Promise<string> {
  evidence(`STEP3 start run=${runId}`);
  await new Promise((r) => setTimeout(r, 200));
  evidence(`STEP3 done run=${runId}`);
  return "step3-result";
}

/** The workflow body — three checkpointed steps. */
async function demoBody(runId: string): Promise<{ runId: string; steps: string[] }> {
  evidence(`WORKFLOW body enter run=${runId}`);
  const s1 = await DBOS.runStep(() => stepOne(runId), { name: "stepOne" });
  const s2 = await DBOS.runStep(() => stepTwoSlow(runId), { name: "stepTwoSlow" });
  const s3 = await DBOS.runStep(() => stepThree(runId), { name: "stepThree" });
  evidence(`WORKFLOW body complete run=${runId}`);
  return { runId, steps: [s1, s2, s3] };
}

export const demoWorkflow = DBOS.registerWorkflow(demoBody, { name: "demoWorkflow" });
