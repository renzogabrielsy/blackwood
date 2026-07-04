/**
 * gen-norm-fixtures.ts — generate norm-parity fixtures by RUNNING THE PYTHON.
 *
 * The Python classifiers are the oracle. This script feeds a curated corpus of
 * input values (incl. .5 boundaries, binary-noise floats, null/0 distinctions)
 * through the ACTUAL Python norm_* / coerce_* functions via `python3 -c`, and
 * writes the expected outputs to test/fixtures/norm-parity.json. norm.test.ts then
 * asserts the TS ports reproduce those exact values.
 *
 * Run:  npm run gen:fixtures     (regenerates the committed fixture file)
 *
 * The fixture file is COMMITTED so CI can run the parity test without Python.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../test/fixtures/norm-parity.json");

// The value corpus — at least 40 cases across the numeric normalizers, incl. the
// dangerous ones the plan calls out explicitly. Kept as JSON-serializable so the
// same list drives both the Python oracle and the TS assertions.
const NUM_CASES: Array<{ v: unknown; places: number }> = [
  // .5 boundaries at 0 dp — the banker's-rounding heartland
  { v: 0.5, places: 0 },
  { v: 1.5, places: 0 },
  { v: 2.5, places: 0 },
  { v: 3.5, places: 0 },
  { v: 4.5, places: 0 },
  { v: -0.5, places: 0 },
  { v: -1.5, places: 0 },
  { v: -2.5, places: 0 },
  // .5 boundaries at 2 dp
  { v: 0.125, places: 2 },
  { v: 0.135, places: 2 },
  { v: 2.675, places: 2 }, // classic IEEE-754 noise case -> 2.67
  { v: 1.005, places: 2 }, // -> 1.0 (noise) in Python
  { v: 0.145, places: 2 },
  { v: 2.5, places: 2 },
  // .5 boundaries at 3 dp (the sync default)
  { v: 0.0005, places: 3 },
  { v: 0.0015, places: 3 },
  { v: 0.0025, places: 3 },
  { v: 21789.0005, places: 3 },
  { v: 21789.0015, places: 3 },
  // binary-noise floats like the plan's example
  { v: 21789.0000001, places: 3 },
  { v: 21789.0000001, places: 0 },
  { v: 5820.499999999, places: 0 },
  { v: 5820.5, places: 0 },
  { v: 5820.500000001, places: 0 },
  // ordinary values
  { v: 5820, places: 3 },
  { v: 5820.123, places: 3 },
  { v: 5820.1235, places: 3 },
  { v: 5820.1234, places: 3 },
  { v: 0, places: 3 },
  { v: -0.0, places: 3 },
  // numeric strings
  { v: "21789.0000001", places: 3 },
  { v: "5820.5", places: 0 },
  { v: "  123.456  ", places: 2 },
  { v: "1e3", places: 3 },
  { v: "0.145", places: 2 },
  // null / bad -> null
  { v: null, places: 3 },
  { v: "", places: 3 },
  { v: "   ", places: 3 },
  { v: "abc", places: 3 },
  { v: "12.3.4", places: 3 },
  // big + high precision
  { v: 999999.9995, places: 3 },
  { v: 100.055, places: 2 },
  { v: 100.045, places: 2 },
];

// int cases — cover both variants (trunc vs round).
const INT_CASES: unknown[] = [
  123, 123.0, 123.4, 123.5, 123.6, 122.5, 124.5, -1.9, -2.5, "123", "123.0",
  "123.9", "  45.5  ", 0, -0.0, null, "", "abc", 2.5, 3.5,
];

// str cases
const STR_CASES: unknown[] = [
  "  ABC ", "abc", "", "   ", null, "MiXeD Case", "  Trailing  ", "B-3A",
];

// block_loc cases
const BLOCK_CASES: unknown[] = ["b-3a", "  d-13d ", "", null, "A-1A", "c-15a"];

// date cases (strings only — Date objects are exercised separately in the TS test)
const DATE_CASES: unknown[] = [
  "2026-07-02", "07/02/2026", "2/7/2026", "2026/07/02", "07-02-2026",
  "2026-13-01", "02/30/2026", "", null, "garbage", "2026-2-3", "1/1/2020",
];

const PY = String.raw`
import json, sys
sys.path.insert(0, ".claude/skills/sync-ictc/scripts")
# Re-implement the EXACT functions inline so the oracle is self-contained and does
# not depend on import side effects. These are copied VERBATIM from the classifiers
# / extractor named in norm.ts. If the Python ever changes, regenerate.
from datetime import date, datetime

def norm_str(s):
    if s is None: return None
    s = str(s).strip()
    return s.lower() if s else None

def norm_block_loc(s):
    if s is None: return None
    s = str(s).strip()
    return s.upper() if s else None

def norm_num(v, places=3):
    if v is None: return None
    try:
        return round(float(v), places)
    except (TypeError, ValueError):
        return None

def norm_int_trunc(v):   # classify_deliveries.py
    if v is None: return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None

def norm_int_round(v):   # classify_gsheet.py
    if v is None: return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None

def coerce_date(value):
    if value is None or value == "": return None
    if isinstance(value, datetime): return value.date().isoformat()
    if isinstance(value, date): return value.isoformat()
    if isinstance(value, str):
        s = value.strip()
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d", "%m-%d-%Y"):
            try:
                return datetime.strptime(s, fmt).date().isoformat()
            except ValueError:
                continue
    return None

payload = json.load(sys.stdin)
out = {
    "num":   [norm_num(c["v"], c["places"]) for c in payload["num"]],
    "int_trunc": [norm_int_trunc(v) for v in payload["int"]],
    "int_round": [norm_int_round(v) for v in payload["int"]],
    "str":   [norm_str(v) for v in payload["str"]],
    "block": [norm_block_loc(v) for v in payload["block"]],
    "date":  [coerce_date(v) for v in payload["date"]],
}
print(json.dumps(out))
`;

const input = JSON.stringify({
  num: NUM_CASES,
  int: INT_CASES,
  str: STR_CASES,
  block: BLOCK_CASES,
  date: DATE_CASES,
});

const projectRoot = resolve(__dirname, "../../..");
let raw: string;
try {
  raw = execFileSync("python3", ["-c", PY], {
    input,
    cwd: projectRoot,
    encoding: "utf8",
  });
} catch (e) {
  console.error("Failed to run Python oracle. Is python3 on PATH?");
  throw e;
}

const expected = JSON.parse(raw);

const fixture = {
  _generated_by: "workers/sync/scripts/gen-norm-fixtures.ts (python3 oracle)",
  _note:
    "Expected values were produced by the ACTUAL Python norm_*/coerce_* functions. " +
    "Do not hand-edit; run `npm run gen:fixtures`.",
  cases: {
    num: NUM_CASES.map((c, i) => ({ ...c, expected: expected.num[i] })),
    int: INT_CASES.map((v, i) => ({
      v,
      expected_trunc: expected.int_trunc[i],
      expected_round: expected.int_round[i],
    })),
    str: STR_CASES.map((v, i) => ({ v, expected: expected.str[i] })),
    block: BLOCK_CASES.map((v, i) => ({ v, expected: expected.block[i] })),
    date: DATE_CASES.map((v, i) => ({ v, expected: expected.date[i] })),
  },
};

mkdirSync(dirname(FIXTURE), { recursive: true });
writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
console.log(
  `[fixtures] wrote ${FIXTURE}: ${NUM_CASES.length} num, ${INT_CASES.length} int, ` +
    `${STR_CASES.length} str, ${BLOCK_CASES.length} block, ${DATE_CASES.length} date cases`
);
