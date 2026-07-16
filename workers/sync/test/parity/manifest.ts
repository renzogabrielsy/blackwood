/**
 * manifest.ts — the fixture-corpus manifest schema + loader.
 *
 * Each report type has `fixtures/<type>/manifest.json`:
 *   {
 *     "report_type": "flecon",
 *     "cases": [
 *       {
 *         "id": "flecon_real_latest",
 *         "kind": "real" | "synthetic",
 *         "covers": ["day-set-multiset-noop", "column-header-signature-map"],
 *         "workbooks": { "primary": "workbooks/flecon_real_latest.xlsx" },
 *         "db_window": "db_window/flecon_real_latest.json",
 *         "opts": { "since": "2026-01-01" },
 *         "note": "…"
 *       }
 *     ]
 *   }
 *
 * Paths inside a case are RELATIVE to `fixtures/<type>/`. The loader resolves
 * them to absolute paths. `db_window` may be omitted for a case whose classify
 * needs no DB snapshot (rare). `covers` maps a case to the spec §7 / rule-checklist
 * items it exercises — surfaced in the coverage table.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** workers/sync/fixtures */
export const FIXTURES_ROOT = resolve(__dirname, "../../fixtures");
/** workers/sync/src/reports */
export const REPORTS_ROOT = resolve(__dirname, "../../src/reports");

export interface FixtureCase {
  id: string;
  kind: "real" | "synthetic";
  covers: string[];
  workbooks: Record<string, string>; // role -> abs path
  dbWindowPath: string | null; // abs path or null
  opts: Record<string, unknown>;
  note?: string;
}

export interface FixtureManifest {
  reportType: string;
  dir: string; // abs fixtures/<type>
  cases: FixtureCase[];
}

interface RawCase {
  id: string;
  kind?: "real" | "synthetic";
  covers?: string[];
  workbooks?: Record<string, string>;
  db_window?: string | null;
  opts?: Record<string, unknown>;
  note?: string;
}

export function loadManifest(reportType: string): FixtureManifest | null {
  const dir = join(FIXTURES_ROOT, reportType);
  const mpath = join(dir, "manifest.json");
  if (!existsSync(mpath)) return null;
  const raw = JSON.parse(readFileSync(mpath, "utf8")) as {
    report_type: string;
    cases: RawCase[];
  };
  const cases: FixtureCase[] = (raw.cases ?? []).map((c) => ({
    id: c.id,
    kind: c.kind ?? "synthetic",
    covers: c.covers ?? [],
    workbooks: Object.fromEntries(
      Object.entries(c.workbooks ?? {}).map(([role, rel]) => [role, join(dir, rel)]),
    ),
    dbWindowPath: c.db_window ? join(dir, c.db_window) : null,
    opts: c.opts ?? {},
    note: c.note,
  }));
  return { reportType: raw.report_type ?? reportType, dir, cases };
}

/** All report types that have a fixtures/<type>/manifest.json. */
export function discoverFixtureTypes(): string[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FIXTURES_ROOT, d.name, "manifest.json")))
    .map((d) => d.name)
    .sort();
}

/** Does a Wave-3 TS port exist for this type? (src/reports/<type>/index.ts) */
export function portExists(reportType: string): boolean {
  return existsSync(join(REPORTS_ROOT, reportType, "index.ts"));
}
