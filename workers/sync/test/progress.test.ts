/**
 * progress.test.ts — emitter writes sync_run_events rows, clamps + enforces monotonic
 * pct per (runId, reportType), and NEVER throws into the pipeline.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeEmitter, _resetPct } from "../src/lib/progress.js";
import type { ProgressEventRow } from "../src/lib/db.js";

function fakeSink() {
  const rows: ProgressEventRow[] = [];
  return {
    rows,
    async insertProgressEvent(ev: ProgressEventRow) {
      rows.push(ev);
    },
  };
}

function throwingSink() {
  return {
    async insertProgressEvent(): Promise<void> {
      throw new Error("db down");
    },
  };
}

describe("progress emitter", () => {
  beforeEach(() => _resetPct());

  it("writes a well-formed event row", async () => {
    const sink = fakeSink();
    const emit = makeEmitter(sink, "run-1", "deliveries");
    await emit("fetch", "Checking Gmail for new reports…", 5, "detail-x");
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({
      run_id: "run-1",
      report_type: "deliveries",
      stage: "fetch",
      pct: 5,
      label: "Checking Gmail for new reports…",
      detail: "detail-x",
      level: "info",
    });
  });

  it("clamps pct into 0..100", async () => {
    const sink = fakeSink();
    const emit = makeEmitter(sink, "run-1", "rc_out");
    await emit("apply", "over", 150);
    expect(sink.rows[0].pct).toBe(100);
  });

  it("enforces monotonic nondecreasing pct per (run, report)", async () => {
    const sink = fakeSink();
    const emit = makeEmitter(sink, "run-1", "production");
    await emit("classify", "a", 40);
    await emit("classify", "b", 20); // must not go backwards
    expect(sink.rows.map((r) => r.pct)).toEqual([40, 40]);
  });

  it("keeps separate monotonic tracks per report type", async () => {
    const sink = fakeSink();
    const a = makeEmitter(sink, "run-1", "deliveries");
    const b = makeEmitter(sink, "run-1", "flecon");
    await a("classify", "a", 80);
    await b("classify", "b", 10); // different track — not clamped by a's 80
    expect(sink.rows[1].pct).toBe(10);
  });

  it("coerces unknown stage to 'classify' and unknown level to 'info'", async () => {
    const sink = fakeSink();
    const emit = makeEmitter(sink, "run-1", "x");
    // @ts-expect-error deliberately bad stage/level
    await emit("bogus", "l", 1, undefined, "loud");
    expect(sink.rows[0].stage).toBe("classify");
    expect(sink.rows[0].level).toBe("info");
  });

  it("NEVER throws even if the DB insert fails", async () => {
    const emit = makeEmitter(throwingSink(), "run-1", "deliveries");
    await expect(emit("fetch", "x", 1)).resolves.toBeUndefined();
  });
});
