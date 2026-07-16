/**
 * deviations.test.ts — unit tests for the expected-deviation matcher:
 * glob matching, kind/value pins, PASS-with-note vs FAIL partitioning, and
 * staleness detection. Also validates the shipped expected-deviations.json parses
 * and every entry is well-formed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { matchDeviations, staleDeviations, type ExpectedDeviation } from "./deviations.js";
import type { Diff } from "./differ.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dev = (over: Partial<ExpectedDeviation>): ExpectedDeviation => ({
  rule: "R",
  type: "flecon",
  case: "c1",
  path: "/**",
  note: "n",
  ...over,
});

const mkDiff = (over: Partial<Diff>): Diff => ({
  path: "/counts/insert",
  kind: "value",
  oracle: " num:1",
  ts: " num:2",
  ...over,
});

describe("matchDeviations", () => {
  it("matches a diff under a ** suffix glob (PASS-with-note)", () => {
    const used = new Set<ExpectedDeviation>();
    const r = matchDeviations("flecon", "c1", [mkDiff({})], [dev({ path: "/**" })], used);
    expect(r.matched).toHaveLength(1);
    expect(r.unmatched).toHaveLength(0);
    expect(used.size).toBe(1);
  });

  it("does NOT match when type/case differ (stays a FAIL)", () => {
    const used = new Set<ExpectedDeviation>();
    const r = matchDeviations("flecon", "c1", [mkDiff({})], [dev({ type: "rc_out" })], used);
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched).toHaveLength(1);
  });

  it("single-star matches one segment only", () => {
    const used = new Set<ExpectedDeviation>();
    const d = mkDiff({ path: "/counts/insert" });
    // /counts/* matches /counts/insert
    expect(matchDeviations("flecon", "c1", [d], [dev({ path: "/counts/*" })], used).matched).toHaveLength(1);
    used.clear();
    // /counts/* does NOT match /counts/a/b
    const deep = mkDiff({ path: "/counts/a/b" });
    expect(matchDeviations("flecon", "c1", [deep], [dev({ path: "/counts/*" })], used).unmatched).toHaveLength(1);
  });

  it("honors a kind constraint", () => {
    const used = new Set<ExpectedDeviation>();
    const d = mkDiff({ kind: "missing_in_ts" });
    // wrong kind -> no match
    expect(matchDeviations("flecon", "c1", [d], [dev({ kind: "value" })], used).unmatched).toHaveLength(1);
    used.clear();
    expect(matchDeviations("flecon", "c1", [d], [dev({ kind: "missing_in_ts" })], used).matched).toHaveLength(1);
  });

  it("honors an exact value pin (auto-canonicalizes numbers)", () => {
    const used = new Set<ExpectedDeviation>();
    const d = mkDiff({ oracle: " num:1", ts: " num:2" });
    // pin with raw numbers 1/2 -> canonicalized to the tagged strings -> match
    expect(matchDeviations("flecon", "c1", [d], [dev({ oracle: 1, ts: 2 })], used).matched).toHaveLength(1);
    used.clear();
    // wrong pin -> no match
    expect(matchDeviations("flecon", "c1", [d], [dev({ oracle: 5 })], used).unmatched).toHaveLength(1);
  });
});

describe("staleDeviations", () => {
  it("reports registered entries that never fired", () => {
    const a = dev({ rule: "A" });
    const b = dev({ rule: "B" });
    const used = new Set<ExpectedDeviation>([a]);
    expect(staleDeviations([a, b], used)).toEqual([b]);
  });
});

describe("shipped expected-deviations.json", () => {
  const raw = JSON.parse(
    readFileSync(resolve(__dirname, "expected-deviations.json"), "utf8"),
  ) as { deviations: ExpectedDeviation[]; apply_phase_deferred?: ExpectedDeviation[] };

  const allEntries = [...(raw.deviations ?? []), ...(raw.apply_phase_deferred ?? [])];

  it("parses and every entry (active + deferred) has rule/type/case/path/note", () => {
    expect(Array.isArray(raw.deviations)).toBe(true);
    expect(Array.isArray(raw.apply_phase_deferred)).toBe(true);
    for (const d of allEntries) {
      expect(typeof d.rule).toBe("string");
      expect(typeof d.type).toBe("string");
      expect(typeof d.case).toBe("string");
      expect(typeof d.path).toBe("string");
      expect(typeof d.note).toBe("string");
    }
  });

  it("still records PORTING_DECISIONS rulings #2-#5 (active OR apply-phase-deferred)", () => {
    // PD-5 fires at classify parity (active); PD-2/3/4 are gsheet APPLY-phase — parked in
    // apply_phase_deferred so they don't report STALE on every run, but the record persists
    // (Wave 4A: prune-stale-with-a-home, not silent-delete). See the file's $apply_phase_todo.
    const activeRules = new Set(raw.deviations.map((d) => d.rule));
    const allRules = new Set(allEntries.map((d) => d.rule));
    expect(activeRules.has("PD-5")).toBe(true);
    for (const r of ["PD-2", "PD-3", "PD-4", "PD-5"]) expect(allRules.has(r)).toBe(true);
  });

  it("keeps the deferred gsheet apply-phase entries out of the ACTIVE set (no STALE noise)", () => {
    const activeGsheet = raw.deviations.filter((d) => d.type === "gsheet");
    expect(activeGsheet).toHaveLength(0);
    expect((raw.apply_phase_deferred ?? []).every((d) => d.type === "gsheet")).toBe(true);
  });
});
