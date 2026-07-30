/**
 * prodSchedule-conditional.test.ts — the CONDITIONAL production-schedule refresh
 * (Phase A of the schedule "master plotter", 2026-07-30).
 *
 * Stage 3c used to upsert every plan_date on every run. It now plans purely
 * (src/reports/prodSchedule/plan.ts, the six rules) and applies through the atomic
 * `fn_apply_schedule_upstream`. This file is the race-condition suite:
 *
 *   R1 stale re-apply      — the SAME email on a later run touches NOTHING.
 *   R2 new-revision conflict — a genuinely newer revision on a human day PARKS and writes
 *                              no plan field.
 *   R3 actuals freeze      — a day with reported production is never written, any owner.
 *   R4 narrowed coverage   — an email that omits days neither deletes nor blanks them.
 *   R5 concurrent write    — an op against a stale row_version is REJECTED, not applied.
 *   R6 save-during-sync    — a human save landing BETWEEN the snapshot and the apply wins;
 *                            the ownership check and the write are one atomic unit.
 *
 * R5/R6 are enforced by SQL, so they are exercised here through `applyOpsLikeSql` — a
 * faithful in-memory mirror of `fn_apply_schedule_upstream`'s three guards
 * (row_version = expected, owner = expected, NOT EXISTS a production_shifts row). The REAL
 * function was proven against the live database in a rolled-back DO block when the
 * migration landed (`supabase/migrations/20260730060000_production_schedule_ownership.sql`);
 * the mirror is what keeps the guard contract regression-tested with no DB.
 */
import { describe, it, expect } from "vitest";
import {
  planScheduleUpstream,
  stampSourceRevs,
  computeSourceRev,
  canonicalDayPayload,
  changedPlanFields,
  ownerForSource,
  messageTagFor,
  toScheduleStateRow,
  type ScheduleOp,
  type ScheduleStateRow,
} from "../../src/reports/prodSchedule/plan.js";
import type { ProdScheduleRow } from "../../src/reports/prodSchedule/parse.js";

const OBSERVED = "2026-07-30T00:00:00.000Z";
const MSG_A = "gm1234.7"; // Joseph email #1
const MSG_B = "gm1234.9"; // a genuinely newer Joseph email

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

function josephRow(plan_date: string, over: Partial<ProdScheduleRow> = {}): ProdScheduleRow {
  return {
    plan_date,
    year: 2026,
    month: 8,
    dow: "Monday",
    shifts: 1,
    setup: "SOLID 3X50",
    projected_tons: 26,
    grades: { "3X50": 21, "4X8": 5 },
    remarks: "8-hr (per Joseph REV#5)",
    source: "joseph:REV5",
    ...over,
  };
}

/** A stored row that is BYTE-IDENTICAL to what `row` would produce for `messageTag`. */
function storedFrom(
  row: ProdScheduleRow,
  messageTag: string | null,
  over: Partial<ScheduleStateRow> = {},
): ScheduleStateRow {
  return {
    plan_date: row.plan_date,
    shifts: row.shifts,
    setup: row.setup,
    projected_tons: row.projected_tons,
    grades: row.grades,
    remarks: row.remarks,
    source: row.source,
    owner: ownerForSource(row.source),
    source_rev: computeSourceRev(row, row.source.startsWith("joseph:") ? messageTag : null),
    row_version: 3,
    pending_source_rev: null,
    is_reported: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// In-memory mirror of fn_apply_schedule_upstream (see the file header).
// ---------------------------------------------------------------------------

interface StoreRow extends ScheduleStateRow {
  pending_upstream: unknown | null;
}

interface Store {
  rows: Map<string, StoreRow>;
  reported: Set<string>;
}

function makeStore(rows: ScheduleStateRow[], reported: string[] = []): Store {
  const m = new Map<string, StoreRow>();
  for (const r of rows) m.set(r.plan_date, { ...r, pending_upstream: null });
  return { rows: m, reported: new Set(reported) };
}

function applyOpsLikeSql(
  store: Store,
  ops: ScheduleOp[],
): Array<{ plan_date: string; action: string; outcome: string }> {
  const out: Array<{ plan_date: string; action: string; outcome: string }> = [];
  for (const op of ops) {
    const cur = store.rows.get(op.plan_date);
    // GUARD 1 — actuals freeze, re-checked at write time (never trusted from the snapshot).
    if (store.reported.has(op.plan_date)) {
      out.push({ plan_date: op.plan_date, action: op.action, outcome: "frozen" });
      continue;
    }
    if (op.action === "insert") {
      if (cur) {
        out.push({ plan_date: op.plan_date, action: op.action, outcome: "exists" });
        continue;
      }
      store.rows.set(op.plan_date, {
        ...storedFrom(op.row, null),
        source_rev: op.source_rev,
        owner: op.new_owner,
        row_version: 1,
        pending_source_rev: null,
        pending_upstream: null,
      });
      out.push({ plan_date: op.plan_date, action: op.action, outcome: "inserted" });
      continue;
    }
    if (!cur) {
      out.push({ plan_date: op.plan_date, action: op.action, outcome: "missing" });
      continue;
    }
    // GUARD 2 + 3 — optimistic concurrency and ownership, checked with the write.
    const expectedOwner = op.action === "park" ? "human" : op.expected_owner;
    if (cur.row_version !== op.expected_row_version || cur.owner !== expectedOwner) {
      out.push({ plan_date: op.plan_date, action: op.action, outcome: "version_conflict" });
      continue;
    }
    if (op.action === "park") {
      // ONLY pending_upstream moves. Every plan field stays exactly as the human left it.
      store.rows.set(op.plan_date, {
        ...cur,
        pending_upstream: op.pending ?? null,
        pending_source_rev: op.pending?.source_rev ?? null,
        row_version: cur.row_version + 1,
      });
      out.push({ plan_date: op.plan_date, action: op.action, outcome: "parked" });
      continue;
    }
    store.rows.set(op.plan_date, {
      plan_date: op.plan_date,
      shifts: op.row.shifts,
      setup: op.row.setup,
      projected_tons: op.row.projected_tons,
      grades: op.row.grades,
      remarks: op.row.remarks,
      source: op.row.source,
      owner: op.new_owner,
      source_rev: op.source_rev,
      row_version: cur.row_version + 1,
      pending_source_rev: null,
      is_reported: false,
      pending_upstream: null,
    });
    out.push({
      plan_date: op.plan_date,
      action: op.action,
      outcome: op.action === "apply" ? "applied" : "reclaimed",
    });
  }
  return out;
}

const snapshot = (s: Store): ScheduleStateRow[] => [...s.rows.values()].map((r) => ({ ...r }));

// ===========================================================================
// source_rev
// ===========================================================================

describe("source_rev composition", () => {
  it("is `<source>|<messageTag>|<12-hex day hash>` and is STABLE for identical content", () => {
    const a = computeSourceRev(josephRow("2026-08-03"), MSG_A);
    const b = computeSourceRev(josephRow("2026-08-03"), MSG_A);
    expect(a).toBe(b);
    const [src, msg, hash] = a.split("|");
    expect(src).toBe("joseph:REV5");
    expect(msg).toBe(MSG_A);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is PER-DAY: changing one day does not change another day's rev", () => {
    const d3 = computeSourceRev(josephRow("2026-08-03"), MSG_A);
    const d4a = computeSourceRev(josephRow("2026-08-04"), MSG_A);
    const d4b = computeSourceRev(josephRow("2026-08-04", { shifts: 0 }), MSG_A);
    expect(d4a).not.toBe(d4b);
    expect(computeSourceRev(josephRow("2026-08-03"), MSG_A)).toBe(d3); // untouched
  });

  it("changes when the email changes, and grade key ORDER never matters", () => {
    expect(computeSourceRev(josephRow("2026-08-03"), MSG_A)).not.toBe(
      computeSourceRev(josephRow("2026-08-03"), MSG_B),
    );
    expect(
      canonicalDayPayload(josephRow("2026-08-03", { grades: { "3X50": 21, "4X8": 5 } })),
    ).toBe(canonicalDayPayload(josephRow("2026-08-03", { grades: { "4X8": 5, "3X50": 21 } })));
  });

  it("leaves Renzo-only days out of the email identity (no churn when Joseph moves)", () => {
    const renzo = josephRow("2026-08-03", { source: "gsheet:PROD SCHED" });
    const s1 = stampSourceRevs([renzo], MSG_A)[0].source_rev;
    const s2 = stampSourceRevs([renzo], MSG_B)[0].source_rev;
    expect(s1).toBe(s2);
    expect(s1.split("|")[1]).toBe("-");
  });

  it("messageTagFor renders gm<threadId>.<uid>, null without an email", () => {
    expect(messageTagFor({ uid: 7, threadId: "1234" })).toBe("gm1234.7");
    expect(messageTagFor({ uid: 7, threadId: null })).toBe("gm-.7");
    expect(messageTagFor(null)).toBeNull();
  });
});

// ===========================================================================
// R1 — stale re-apply
// ===========================================================================

describe("R1 stale re-apply — the same email on a later run writes NOTHING", () => {
  it("plans zero ops for a fully up-to-date calendar", () => {
    const rows = ["2026-08-03", "2026-08-04", "2026-08-05"].map((d) => josephRow(d));
    const stamped = stampSourceRevs(rows, MSG_A);
    const state = rows.map((r) => storedFrom(r, MSG_A));

    const plan = planScheduleUpstream(stamped, state, OBSERVED);
    expect(plan.ops).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.counts.unchanged).toBe(3);
  });

  it("does not touch a HUMAN-edited day when the revision is already parked on it", () => {
    const row = josephRow("2026-08-03", { shifts: 0, setup: null });
    const rev = computeSourceRev(row, MSG_A);
    const state: ScheduleStateRow[] = [
      {
        ...storedFrom(josephRow("2026-08-03"), MSG_A),
        owner: "human",
        source_rev: "joseph:REV4|gm1234.1|000000000000",
        // the human's OWN values, wildly different from Joseph's
        shifts: 2,
        setup: "3X50 / 6X50",
        // …and this exact revision was parked on a previous run
        pending_source_rev: rev,
      },
    ];
    const plan = planScheduleUpstream(stampSourceRevs([row], MSG_A), state, OBSERVED);
    expect(plan.ops).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.counts.unchanged).toBe(1);
  });

  it("end-to-end: a second identical run leaves every row_version untouched", () => {
    const rows = ["2026-08-03", "2026-08-04"].map((d) => josephRow(d));
    const stamped = stampSourceRevs(rows, MSG_A);
    const store = makeStore(rows.map((r) => storedFrom(r, MSG_A)));
    const before = snapshot(store).map((r) => r.row_version);

    const plan = planScheduleUpstream(stamped, snapshot(store), OBSERVED);
    const outcomes = applyOpsLikeSql(store, plan.ops);

    expect(outcomes).toEqual([]);
    expect(snapshot(store).map((r) => r.row_version)).toEqual(before);
  });
});

// ===========================================================================
// R2 — new-revision conflict on a human day
// ===========================================================================

describe("R2 new-revision conflict — a human day parks the proposal, writes no plan field", () => {
  const human: ScheduleStateRow = {
    plan_date: "2026-08-03",
    shifts: 2,
    setup: "3X50 / 6X50",
    projected_tons: 30,
    grades: { "3X50": 30 },
    remarks: "Renzo: double shift, customer pull-in",
    source: "joseph:REV5",
    owner: "human",
    source_rev: "joseph:REV5|gm1234.7|aaaaaaaaaaaa",
    row_version: 4,
    pending_source_rev: null,
    is_reported: false,
  };

  it("emits a PARK op (never apply) carrying the guards + the withheld value", () => {
    const incoming = stampSourceRevs(
      [josephRow("2026-08-03", { shifts: 0, setup: null, source: "joseph:REV6" })],
      MSG_B,
    );
    const plan = planScheduleUpstream(incoming, [human], OBSERVED);

    expect(plan.ops).toHaveLength(1);
    const op = plan.ops[0];
    expect(op.action).toBe("park");
    expect(op.expected_row_version).toBe(4);
    expect(op.expected_owner).toBe("human");
    expect(op.new_owner).toBe("human");
    expect(op.pending?.source_rev).toBe(incoming[0].source_rev);
    expect(op.pending?.changed_fields).toEqual(
      expect.arrayContaining(["shifts", "setup", "projected_tons", "grades", "remarks"]),
    );
    expect(op.pending?.observed_at).toBe(OBSERVED);

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      plan_date: "2026-08-03",
      source_rev: incoming[0].source_rev,
      current: { shifts: 2, setup: "3X50 / 6X50" },
      proposed: { shifts: 0, setup: null },
    });
    expect(plan.counts).toMatchObject({ parked: 1, applied: 0, reclaimed: 0 });
  });

  it("after the write, EVERY plan field is still the human's", () => {
    const store = makeStore([human]);
    const incoming = stampSourceRevs(
      [josephRow("2026-08-03", { shifts: 0, setup: null, projected_tons: 0, grades: null })],
      MSG_B,
    );
    const plan = planScheduleUpstream(incoming, snapshot(store), OBSERVED);
    const outcomes = applyOpsLikeSql(store, plan.ops);

    expect(outcomes).toEqual([
      { plan_date: "2026-08-03", action: "park", outcome: "parked" },
    ]);
    const after = store.rows.get("2026-08-03")!;
    expect(after.shifts).toBe(2);
    expect(after.setup).toBe("3X50 / 6X50");
    expect(after.projected_tons).toBe(30);
    expect(after.owner).toBe("human");
    expect(after.pending_upstream).toMatchObject({ source_rev: incoming[0].source_rev });
    expect(after.row_version).toBe(5); // parking IS a write → the token moves
  });

  it("RULE 4 — when the human's values now EQUAL the upstream, ownership goes back", () => {
    const caughtUp: ScheduleStateRow = {
      ...human,
      shifts: 1,
      setup: "SOLID 3X50",
      projected_tons: 26,
      grades: { "3X50": 21, "4X8": 5 },
      remarks: "8-hr (per Joseph REV#5)",
      pending_source_rev: "joseph:REV5|gm1234.7|zzzzzzzzzzzz",
    };
    const store = makeStore([caughtUp]);
    const incoming = stampSourceRevs([josephRow("2026-08-03")], MSG_B);
    const plan = planScheduleUpstream(incoming, snapshot(store), OBSERVED);

    expect(plan.ops[0]).toMatchObject({
      action: "reclaim",
      expected_owner: "human",
      expected_row_version: 4,
      new_owner: "joseph",
    });
    expect(plan.conflicts).toEqual([]);

    applyOpsLikeSql(store, plan.ops);
    const after = store.rows.get("2026-08-03")!;
    expect(after.owner).toBe("joseph");
    expect(after.pending_upstream).toBeNull();
    expect(after.source_rev).toBe(incoming[0].source_rev);
  });

  it("tolerates numeric/jsonb round-trip noise when comparing (no phantom conflict)", () => {
    const roundTripped: ScheduleStateRow = {
      ...human,
      shifts: 1,
      setup: "SOLID 3X50",
      // PostgREST returns numeric as a string, and jsonb key order is not insertion order
      projected_tons: "26.000" as unknown as number,
      grades: { "4X8": 5, "3X50": 21 },
      remarks: "8-hr (per Joseph REV#5)",
    };
    expect(changedPlanFields(roundTripped, josephRow("2026-08-03"))).toEqual([]);
  });
});

// ===========================================================================
// R3 — actuals freeze
// ===========================================================================

describe("R3 actuals freeze — a reported day is never written, whatever owns it", () => {
  it.each(["joseph", "gsheet", "human"] as const)("owner=%s → no op planned", (owner) => {
    const state: ScheduleStateRow[] = [
      {
        ...storedFrom(josephRow("2026-07-20"), MSG_A),
        owner,
        source_rev: "joseph:REV4|gm1234.1|000000000000",
        shifts: 9,
        is_reported: true,
      },
    ];
    const plan = planScheduleUpstream(
      stampSourceRevs([josephRow("2026-07-20", { source: "joseph:REV6" })], MSG_B),
      state,
      OBSERVED,
    );
    expect(plan.ops).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.counts.frozen).toBe(1);
  });

  it("the WRITE re-checks it: production reported after the snapshot still freezes", () => {
    // Snapshot says not-reported; by apply time a production_shifts row exists.
    const state = [storedFrom(josephRow("2026-07-20"), MSG_A, { shifts: 9 })];
    const store = makeStore(state);
    const plan = planScheduleUpstream(
      stampSourceRevs([josephRow("2026-07-20", { source: "joseph:REV6" })], MSG_B),
      snapshot(store),
      OBSERVED,
    );
    expect(plan.ops).toHaveLength(1);

    store.reported.add("2026-07-20"); // the actuals land mid-run
    const outcomes = applyOpsLikeSql(store, plan.ops);

    expect(outcomes[0].outcome).toBe("frozen");
    expect(store.rows.get("2026-07-20")!.shifts).toBe(9); // untouched
    expect(store.rows.get("2026-07-20")!.row_version).toBe(3);
  });

  it("does not even INSERT a plan for a reported day that has no row", () => {
    const store = makeStore([], ["2026-07-20"]);
    const plan = planScheduleUpstream(
      stampSourceRevs([josephRow("2026-07-20")], MSG_A),
      snapshot(store),
      OBSERVED,
    );
    // The planner proposes the insert; the write-time guard is what refuses it.
    expect(plan.ops[0].action).toBe("insert");
    expect(applyOpsLikeSql(store, plan.ops)[0].outcome).toBe("frozen");
    expect(store.rows.size).toBe(0);
  });
});

// ===========================================================================
// R4 — narrowed coverage
// ===========================================================================

describe("R4 narrowed coverage — omitted days are not deleted and not blanked", () => {
  it("a shorter incoming plan leaves the dropped days byte-identical", () => {
    const all = ["2026-08-03", "2026-08-04", "2026-08-05"].map((d) => josephRow(d));
    const store = makeStore(all.map((r) => storedFrom(r, MSG_A)));

    // The next email covers ONLY 08-03, and changes it.
    const narrowed = stampSourceRevs(
      [josephRow("2026-08-03", { shifts: 0, source: "joseph:REV6" })],
      MSG_B,
    );
    const plan = planScheduleUpstream(narrowed, snapshot(store), OBSERVED);

    expect(plan.ops.map((o) => o.plan_date)).toEqual(["2026-08-03"]);
    applyOpsLikeSql(store, plan.ops);

    expect(store.rows.size).toBe(3);
    for (const d of ["2026-08-04", "2026-08-05"]) {
      const r = store.rows.get(d)!;
      expect(r.shifts).toBe(1);
      expect(r.setup).toBe("SOLID 3X50");
      expect(r.projected_tons).toBe(26);
      expect(r.row_version).toBe(3); // never written
    }
  });

  it("an EMPTY incoming plan is a total no-op (the flecon delete-to-empty class)", () => {
    const store = makeStore(
      ["2026-08-03", "2026-08-04"].map((d) => storedFrom(josephRow(d), MSG_A)),
    );
    const plan = planScheduleUpstream([], snapshot(store), OBSERVED);
    expect(plan.ops).toEqual([]);
    applyOpsLikeSql(store, plan.ops);
    expect(store.rows.size).toBe(2);
  });
});

// ===========================================================================
// R5 — concurrent write
// ===========================================================================

describe("R5 concurrent write — a stale row_version is rejected, never silently applied", () => {
  it("every mutating op carries the version + owner it was planned against", () => {
    const state = [
      storedFrom(josephRow("2026-08-03"), MSG_A, { row_version: 11 }),
      { ...storedFrom(josephRow("2026-08-04"), MSG_A, { row_version: 12 }), owner: "human" as const },
    ];
    const plan = planScheduleUpstream(
      stampSourceRevs(
        [
          josephRow("2026-08-03", { shifts: 0, source: "joseph:REV6" }),
          josephRow("2026-08-04", { shifts: 0, source: "joseph:REV6" }),
        ],
        MSG_B,
      ),
      state,
      OBSERVED,
    );
    expect(plan.ops).toHaveLength(2);
    for (const op of plan.ops) {
      expect(op.expected_row_version).not.toBeNull();
      expect(op.expected_owner).not.toBeNull();
    }
    expect(plan.ops.find((o) => o.plan_date === "2026-08-03")!.expected_row_version).toBe(11);
    expect(plan.ops.find((o) => o.plan_date === "2026-08-04")!.expected_row_version).toBe(12);
  });

  it("bumping the version underneath the op turns an apply into version_conflict", () => {
    const store = makeStore([storedFrom(josephRow("2026-08-03"), MSG_A, { row_version: 3 })]);
    const plan = planScheduleUpstream(
      stampSourceRevs([josephRow("2026-08-03", { shifts: 0, source: "joseph:REV6" })], MSG_B),
      snapshot(store),
      OBSERVED,
    );

    // Somebody else writes between the snapshot and the apply.
    const cur = store.rows.get("2026-08-03")!;
    store.rows.set("2026-08-03", { ...cur, row_version: 4, shifts: 2 });

    const outcomes = applyOpsLikeSql(store, plan.ops);
    expect(outcomes[0].outcome).toBe("version_conflict");
    expect(store.rows.get("2026-08-03")!.shifts).toBe(2); // the other writer's value stands
    expect(store.rows.get("2026-08-03")!.row_version).toBe(4);
  });
});

// ===========================================================================
// R6 — save-during-sync
// ===========================================================================

describe("R6 save-during-sync — the ownership check and the write are one atomic unit", () => {
  it("a human save landing after the snapshot WINS: the planned apply is refused", () => {
    // Snapshot: 08-03 is joseph-owned at v3, so the planner plans a plain `apply`.
    const store = makeStore([storedFrom(josephRow("2026-08-03"), MSG_A, { row_version: 3 })]);
    const plan = planScheduleUpstream(
      stampSourceRevs([josephRow("2026-08-03", { shifts: 0, source: "joseph:REV6" })], MSG_B),
      snapshot(store),
      OBSERVED,
    );
    expect(plan.ops[0].action).toBe("apply");
    expect(plan.ops[0].expected_owner).toBe("joseph");

    // …then Renzo saves the day in the app (fn_save_schedule_day: owner→human, v3→v4).
    const cur = store.rows.get("2026-08-03")!;
    store.rows.set("2026-08-03", {
      ...cur,
      owner: "human",
      shifts: 2,
      setup: "RENZO OVERRIDE",
      row_version: 4,
    });

    const outcomes = applyOpsLikeSql(store, plan.ops);
    expect(outcomes[0].outcome).toBe("version_conflict");
    const after = store.rows.get("2026-08-03")!;
    expect(after.owner).toBe("human");
    expect(after.shifts).toBe(2);
    expect(after.setup).toBe("RENZO OVERRIDE");
  });

  it("the very next run sees the human day and PARKS instead of applying", () => {
    const store = makeStore([
      {
        ...storedFrom(josephRow("2026-08-03"), MSG_A, { row_version: 4 }),
        owner: "human",
        shifts: 2,
        setup: "RENZO OVERRIDE",
      },
    ]);
    const incoming = stampSourceRevs(
      [josephRow("2026-08-03", { shifts: 0, source: "joseph:REV6" })],
      MSG_B,
    );
    const plan = planScheduleUpstream(incoming, snapshot(store), OBSERVED);
    expect(plan.ops[0].action).toBe("park");
    expect(applyOpsLikeSql(store, plan.ops)[0].outcome).toBe("parked");
    expect(store.rows.get("2026-08-03")!.setup).toBe("RENZO OVERRIDE");
    expect(store.rows.get("2026-08-03")!.pending_upstream).toBeTruthy();
  });

  it("an ownership flip alone (same version) is still refused by the owner guard", () => {
    const store = makeStore([storedFrom(josephRow("2026-08-03"), MSG_A, { row_version: 3 })]);
    const plan = planScheduleUpstream(
      stampSourceRevs([josephRow("2026-08-03", { shifts: 0, source: "joseph:REV6" })], MSG_B),
      snapshot(store),
      OBSERVED,
    );
    const cur = store.rows.get("2026-08-03")!;
    store.rows.set("2026-08-03", { ...cur, owner: "human" }); // version unchanged
    expect(applyOpsLikeSql(store, plan.ops)[0].outcome).toBe("version_conflict");
    expect(store.rows.get("2026-08-03")!.shifts).toBe(1);
  });
});

// ===========================================================================
// misc: new days, and the PostgREST row coercer
// ===========================================================================

describe("new days + state coercion", () => {
  it("a day with no row is INSERTed with the owner its provenance implies", () => {
    const plan = planScheduleUpstream(
      stampSourceRevs(
        [josephRow("2026-09-01"), josephRow("2026-09-02", { source: "gsheet:PROD SCHED" })],
        MSG_A,
      ),
      [],
      OBSERVED,
    );
    expect(plan.ops.map((o) => [o.action, o.new_owner, o.expected_row_version])).toEqual([
      ["insert", "joseph", null],
      ["insert", "gsheet", null],
    ]);
    expect(plan.counts.inserted).toBe(2);
  });

  it("toScheduleStateRow survives PostgREST's string numerics and missing keys", () => {
    const r = toScheduleStateRow({
      plan_date: "2026-08-03T00:00:00",
      shifts: "2",
      projected_tons: "26.5",
      row_version: "7",
      grades: { "3X50": 21 },
      is_reported: false,
    });
    expect(r).toMatchObject({
      plan_date: "2026-08-03",
      shifts: 2,
      projected_tons: 26.5,
      row_version: 7,
      owner: "gsheet",
      source_rev: null,
      is_reported: false,
    });
  });
});
