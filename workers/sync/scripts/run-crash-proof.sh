#!/usr/bin/env bash
# run-crash-proof.sh — orchestrates the M0 crash-resume proof end to end.
#
#   1. start the demo workflow in a child process (step2 durable-sleeps 10s),
#   2. wait until step2 has begun (evidence file shows "STEP2 start"),
#   3. `kill -9` the child MID-step2 (hard crash, no cleanup),
#   4. start a FRESH process in `resume` mode → DBOS recovers the PENDING workflow
#      from its last completed step and runs it to completion,
#   5. assert: step1 ran exactly ONCE (in the first pid), step2/step3 completed in
#      the SECOND pid, and DBOS system tables show the workflow SUCCESS.
#
# Requires DBOS_DATABASE_URL to point at a Postgres (local PG for the proof).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

: "${DBOS_DATABASE_URL:?set DBOS_DATABASE_URL to a Postgres connection string}"
export PROOF_WORKFLOW_ID="crash-resume-proof-$(date +%s)"
export PROOF_RUN_ID="demo-run-$(date +%s)"
export DEMO_EVIDENCE_FILE="$(mktemp -t dbos-crash-evidence.XXXXXX)"
: > "$DEMO_EVIDENCE_FILE"

echo "=== crash-resume proof ==="
echo "workflowID=$PROOF_WORKFLOW_ID"
echo "evidence=$DEMO_EVIDENCE_FILE"
echo "system db=$DBOS_DATABASE_URL"
echo

# --- 1. start (background) ----------------------------------------------------
# Invoke `node --import tsx` DIRECTLY (not via the `npx tsx` wrapper) so the PID we
# capture in $! IS the real Node worker process. `kill -9 $PID` then hard-crashes the
# worker itself. (The earlier failure killed the npx wrapper and left the real Node
# grandchild alive, which then finished the workflow on its own.)
node --import tsx scripts/crash-resume-proof.ts start > /tmp/proof-start.log 2>&1 &
START_PID=$!
echo "[harness] started worker pid=$START_PID"

# --- 2. wait until step2 begins ---------------------------------------------
for i in $(seq 1 60); do
  if grep -q "STEP2 start" "$DEMO_EVIDENCE_FILE" 2>/dev/null; then
    echo "[harness] step2 has begun — child is now inside the 10s durable sleep"
    break
  fi
  # bail if the child died early
  if ! kill -0 "$START_PID" 2>/dev/null; then
    echo "[harness] FAIL: child exited before step2 started"; cat /tmp/proof-start.log; exit 1
  fi
  sleep 0.5
done

if ! grep -q "STEP2 start" "$DEMO_EVIDENCE_FILE"; then
  echo "[harness] FAIL: step2 never started"; cat /tmp/proof-start.log; exit 1
fi

# --- 3. kill -9 MID step2 ----------------------------------------------------
sleep 1   # ensure we are firmly inside the sleep, before it would complete
echo "[harness] kill -9 $START_PID (hard crash of the worker, mid-step2)"
kill -9 "$START_PID" 2>/dev/null
wait "$START_PID" 2>/dev/null
sleep 0.5
echo "[harness] child killed. Evidence so far:"
sed 's/^/    /' "$DEMO_EVIDENCE_FILE"
echo

# sanity: step2 must NOT have completed before the kill
if grep -q "STEP2 done" "$DEMO_EVIDENCE_FILE"; then
  echo "[harness] FAIL: step2 completed before kill — sleep too short to prove resume"; exit 1
fi

# --- 4. resume (fresh process) ----------------------------------------------
echo "[harness] launching FRESH process in resume mode…"
npx tsx scripts/crash-resume-proof.ts resume > /tmp/proof-resume.log 2>&1
RESUME_RC=$?
echo "[harness] resume rc=$RESUME_RC"
cat /tmp/proof-resume.log | sed 's/^/    /'
echo

if [ "$RESUME_RC" -ne 0 ]; then
  echo "[harness] FAIL: resume process errored"; exit 1
fi

# --- 5. assert evidence ------------------------------------------------------
echo "[harness] final evidence:"
sed 's/^/    /' "$DEMO_EVIDENCE_FILE"
echo

FIRST_PID=$(grep "STEP1 start" "$DEMO_EVIDENCE_FILE" | head -1 | sed -E 's/.*pid=([0-9]+).*/\1/')
STEP1_STARTS=$(grep -c "STEP1 start" "$DEMO_EVIDENCE_FILE")
STEP2_DONE=$(grep -c "STEP2 done" "$DEMO_EVIDENCE_FILE")
STEP3_DONE=$(grep -c "STEP3 done" "$DEMO_EVIDENCE_FILE")
SECOND_PID=$(grep "STEP2 done" "$DEMO_EVIDENCE_FILE" | tail -1 | sed -E 's/.*pid=([0-9]+).*/\1/')

echo "[assert] STEP1 start count = $STEP1_STARTS (expect 1 — step1 NOT re-run on resume)"
echo "[assert] STEP2 done count  = $STEP2_DONE (expect 1)"
echo "[assert] STEP3 done count  = $STEP3_DONE (expect 1)"
echo "[assert] first pid=$FIRST_PID  second(resume) pid=$SECOND_PID"

FAIL=0
[ "$STEP1_STARTS" = "1" ] || { echo "[assert] FAIL: step1 ran $STEP1_STARTS times (durable step should NOT re-run)"; FAIL=1; }
[ "$STEP2_DONE" = "1" ]   || { echo "[assert] FAIL: step2 did not complete exactly once"; FAIL=1; }
[ "$STEP3_DONE" = "1" ]   || { echo "[assert] FAIL: step3 did not complete exactly once"; FAIL=1; }
[ -n "$FIRST_PID" ] && [ -n "$SECOND_PID" ] && [ "$FIRST_PID" != "$SECOND_PID" ] \
  || { echo "[assert] FAIL: expected step2/3 to complete in a DIFFERENT pid than step1"; FAIL=1; }

if [ "$FAIL" -eq 0 ]; then
  echo
  echo "=== PROOF PASSED: DBOS resumed the workflow from its last completed step across a kill -9 ==="
  exit 0
else
  echo
  echo "=== PROOF FAILED ==="
  exit 1
fi
