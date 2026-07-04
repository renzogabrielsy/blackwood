/**
 * runner.ts — `npm run parity [-- --type <t>] [--verbose]`
 *
 * The HARD GATE every Wave-3 port must pass. For each fixture case:
 *   1. Load the DB-window snapshot (offline, stable forever).
 *   2. If a TS port exists (src/reports/<type>/index.ts), call `classifyCase`;
 *      else record the type as MISSING (not a failure — the port isn't built yet).
 *   3. Load the pre-built oracle (fixtures/<type>/oracle/<case>.json).
 *   4. Canonicalize BOTH sides identically, diff.
 *   5. Partition diffs into expected-deviation matches vs genuine FAILs.
 *   6. Print a per-type summary table; exit non-zero if ANY case FAILs.
 *
 * The oracle files are produced by scripts/build-oracle.ts (runs the Python).
 * This runner NEVER touches Python or the DB — it compares two static things.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { canonicalize } from "./canonical.js";
import { diff, type Diff } from "./differ.js";
import {
  matchDeviations,
  staleDeviations,
  type ExpectedDeviation,
} from "./deviations.js";
import {
  loadManifest,
  discoverFixtureTypes,
  portExists,
  REPORTS_ROOT,
  FIXTURES_ROOT,
  type FixtureCase,
} from "./manifest.js";
import type { ClassifyCase } from "../../src/reports/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── tiny ANSI helpers (no dep) ──────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c("31");
const green = c("32");
const yellow = c("33");
const cyan = c("36");
const dim = c("2");
const bold = c("1");

interface CaseOutcome {
  caseId: string;
  status: "pass" | "fail" | "missing" | "error";
  deviations: number;
  fails: Diff[];
  matched: Array<{ diff: Diff; dev: ExpectedDeviation }>;
  error?: string;
}

interface Args {
  type?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--type") out.type = argv[++i];
    else if (argv[i] === "--verbose" || argv[i] === "-v") out.verbose = true;
  }
  return out;
}

function loadDeviations(): ExpectedDeviation[] {
  const p = resolve(__dirname, "expected-deviations.json");
  const raw = JSON.parse(readFileSync(p, "utf8")) as { deviations: ExpectedDeviation[] };
  return raw.deviations ?? [];
}

function loadOracle(type: string, caseId: string): unknown | null {
  const p = join(FIXTURES_ROOT, type, "oracle", `${caseId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function loadDbWindow(fc: FixtureCase): Record<string, unknown> {
  if (!fc.dbWindowPath || !existsSync(fc.dbWindowPath)) return {};
  return JSON.parse(readFileSync(fc.dbWindowPath, "utf8")) as Record<string, unknown>;
}

async function loadPort(type: string): Promise<ClassifyCase | null> {
  if (!portExists(type)) return null;
  const entry = join(REPORTS_ROOT, type, "index.ts");
  const mod = (await import(pathToFileURL(entry).href)) as { classifyCase?: ClassifyCase };
  if (typeof mod.classifyCase !== "function") {
    throw new Error(`src/reports/${type}/index.ts exists but does not export classifyCase()`);
  }
  return mod.classifyCase;
}

function fmtVal(v: unknown): string {
  if (typeof v === "string" && v.startsWith(" num:")) return v.slice(5);
  if (v === undefined) return dim("‹absent›");
  return JSON.stringify(v);
}

function printDiff(d: Diff): void {
  const label =
    d.kind === "missing_in_ts"
      ? red("only in oracle")
      : d.kind === "missing_in_oracle"
        ? red("only in ts")
        : d.kind === "type"
          ? red("type")
          : red("value");
  console.log(`      ${cyan(d.path)}  [${label}]`);
  console.log(`        oracle: ${green(fmtVal(d.oracle))}`);
  console.log(`        ts:     ${yellow(fmtVal(d.ts))}`);
}

async function runType(
  type: string,
  registry: ExpectedDeviation[],
  used: Set<ExpectedDeviation>,
  args: Args,
): Promise<{ outcomes: CaseOutcome[]; ported: boolean }> {
  const manifest = loadManifest(type);
  if (!manifest) return { outcomes: [], ported: false };

  let port: ClassifyCase | null = null;
  let ported = false;
  try {
    port = await loadPort(type);
    ported = port !== null;
  } catch (e) {
    // A broken port file: report every case as error for this type.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ported: true,
      outcomes: manifest.cases.map((fc) => ({
        caseId: fc.id,
        status: "error" as const,
        deviations: 0,
        fails: [],
        matched: [],
        error: msg,
      })),
    };
  }

  const outcomes: CaseOutcome[] = [];
  for (const fc of manifest.cases) {
    const oracle = loadOracle(type, fc.id);
    if (oracle === null) {
      outcomes.push({
        caseId: fc.id,
        status: "error",
        deviations: 0,
        fails: [],
        matched: [],
        error: `no oracle at fixtures/${type}/oracle/${fc.id}.json — run \`npm run build:oracle\``,
      });
      continue;
    }

    if (!ported || !port) {
      outcomes.push({ caseId: fc.id, status: "missing", deviations: 0, fails: [], matched: [] });
      continue;
    }

    let tsOut: unknown;
    try {
      tsOut = await port(fc.workbooks, loadDbWindow(fc), fc.opts as never);
    } catch (e) {
      outcomes.push({
        caseId: fc.id,
        status: "error",
        deviations: 0,
        fails: [],
        matched: [],
        error: `classifyCase threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const diffs = diff(canonicalize(oracle), canonicalize(tsOut));
    const { matched, unmatched } = matchDeviations(type, fc.id, diffs, registry, used);
    outcomes.push({
      caseId: fc.id,
      status: unmatched.length === 0 ? "pass" : "fail",
      deviations: matched.length,
      fails: unmatched,
      matched,
    });
    void args; // verbose handled by caller
  }
  return { outcomes, ported };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadDeviations();
  const used = new Set<ExpectedDeviation>();

  const allTypes = discoverFixtureTypes();
  const types = args.type ? allTypes.filter((t) => t === args.type) : allTypes;

  if (types.length === 0) {
    console.error(red(`No fixture types found${args.type ? ` matching --type ${args.type}` : ""}.`));
    console.error(dim("Expected fixtures/<type>/manifest.json. Have you built the corpus?"));
    process.exit(1);
  }

  console.log(bold("\n  Golden-master parity harness  ") + dim("(M2)\n"));

  const rows: Array<{
    type: string;
    ported: boolean;
    cases: number;
    pass: number;
    dev: number;
    fail: number;
    missing: number;
    error: number;
  }> = [];
  let hardFail = false;

  for (const type of types) {
    const { outcomes, ported } = await runType(type, registry, used, args);
    const summary = {
      type,
      ported,
      cases: outcomes.length,
      pass: outcomes.filter((o) => o.status === "pass").length,
      dev: outcomes.reduce((n, o) => n + o.deviations, 0),
      fail: outcomes.filter((o) => o.status === "fail").length,
      missing: outcomes.filter((o) => o.status === "missing").length,
      error: outcomes.filter((o) => o.status === "error").length,
    };
    rows.push(summary);
    if (summary.fail > 0 || summary.error > 0) hardFail = true;

    // Per-case detail for anything not a clean pass (or all cases if --verbose).
    for (const o of outcomes) {
      const showDetail =
        o.status === "fail" || o.status === "error" || (args.verbose && o.status !== "missing");
      if (!showDetail && o.deviations === 0) continue;
      const tag =
        o.status === "pass"
          ? green("PASS")
          : o.status === "fail"
            ? red("FAIL")
            : o.status === "missing"
              ? dim("MISSING")
              : red("ERROR");
      const devTag = o.deviations ? yellow(` (+${o.deviations} expected-deviation)`) : "";
      console.log(`  ${tag} ${cyan(type)}/${o.caseId}${devTag}`);
      if (o.error) console.log(`      ${red(o.error)}`);
      if (args.verbose) {
        for (const m of o.matched) {
          console.log(`      ${yellow("↳ deviation")} ${dim(m.dev.rule)} @ ${cyan(m.diff.path)}`);
        }
      }
      for (const d of o.fails) printDiff(d);
    }
  }

  // ── summary table ─────────────────────────────────────────────────────────
  console.log("\n" + bold("  Summary"));
  const H = ["type", "ported", "cases", "pass", "dev", "fail", "missing", "error"];
  const widths = [22, 6, 5, 4, 4, 4, 7, 5];
  const fmtRow = (cols: string[]) =>
    "  " + cols.map((v, i) => v.padEnd(widths[i])).join(" ");
  console.log(dim(fmtRow(H)));
  for (const r of rows) {
    const cols = [
      r.type,
      r.ported ? "yes" : "no",
      String(r.cases),
      String(r.pass),
      String(r.dev),
      String(r.fail),
      String(r.missing),
      String(r.error),
    ];
    const line = fmtRow(cols);
    console.log(r.fail || r.error ? red(line) : r.missing && !r.ported ? dim(line) : green(line));
  }

  // ── stale deviation entries (registered but never fired) ────────────────────
  const stale = staleDeviations(registry, used).filter((d) => {
    // Only warn about a stale deviation whose TYPE is actually ported+run;
    // a deviation for an unbuilt port is EXPECTED to be dormant.
    const r = rows.find((x) => x.type === d.type);
    return r?.ported;
  });
  if (stale.length) {
    console.log("\n" + yellow("  Stale expected-deviations (ported type, never fired):"));
    for (const d of stale) console.log(`    ${dim(d.rule)} ${d.type}/${d.case} @ ${d.path}`);
    console.log(dim("    (a fixed port may no longer need these — prune if truly obsolete)"));
  }

  const totalFail = rows.reduce((n, r) => n + r.fail + r.error, 0);
  const totalMissing = rows.reduce((n, r) => n + r.missing, 0);
  console.log("");
  if (hardFail) {
    console.log(red(bold(`  ✗ ${totalFail} case(s) failed.`)) + dim(`  ${totalMissing} awaiting port.`));
    process.exit(1);
  }
  console.log(
    green(bold("  ✓ parity clean")) +
      dim(`  ${totalMissing} case(s) awaiting a TS port (MISSING, not failing).`),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(red("parity runner crashed:"), e);
  process.exit(1);
});
