// ═════════════════════════════════════════════════════════════════════════════════
// a1.ts — THE ONE OWNER OF CELL ADDRESSING FOR THE OPERATIONS WORKBOOK.
//
// Every A1 reference, every sheet-name quote and every range string in
// `lib/operations/excel/**` is built here. No other file concatenates a column
// letter to a row number, and no other file writes a `'…'!` prefix.
//
// WHY THAT RULE EXISTS, concretely: the workbook is FORMULAS, not values (see
// `workbook.ts`), and a price-denied build REMOVES ₱ columns rather than blanking
// them — so a column letter is not a constant. `TTL FED` is `D` for an Owner and
// `C` for Production. A formula string assembled by hand in a sheet builder would
// be right in one build and silently wrong in the other, and a wrong reference in
// Excel is not a crash: it is a plausible number from the wrong column.
//
// So sheet builders declare a {@link Layout} of LOGICAL ids and ask it for
// letters. Nothing downstream knows what a letter is.
//
// SHEET NAMES ARE ALWAYS QUOTED. `'JULY 2026'!C4` is valid whether or not the name
// needs quoting, so there is one spelling rather than a predicate to get wrong, and
// {@link quoteSheet} doubles an embedded apostrophe the way Excel does.
// ═════════════════════════════════════════════════════════════════════════════════

/** Excel's hard limit on a worksheet name, and the characters it refuses. */
export const MAX_SHEET_NAME = 31;
const ILLEGAL_SHEET_CHARS = /[[\]:*?/\\]/;

/** `1 → A`, `26 → Z`, `27 → AA`. 1-BASED, like every Excel column index. */
export function colLetter(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`colLetter: column index must be a positive integer, got ${index}`);
  }
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `A → 1`. The inverse of {@link colLetter}, for reading a reference back. */
export function colIndex(letter: string): number {
  const up = letter.toUpperCase();
  if (!/^[A-Z]+$/.test(up)) throw new Error(`colIndex: not a column letter: ${letter}`);
  let n = 0;
  for (const ch of up) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** `a1('D', 12)` / `a1(4, 12)` → `D12`. */
export function a1(col: string | number, row: number): string {
  if (!Number.isInteger(row) || row < 1) {
    throw new Error(`a1: row must be a positive integer, got ${row}`);
  }
  return `${typeof col === 'number' ? colLetter(col) : col.toUpperCase()}${row}`;
}

/** `D5:D40` — one column, a span of rows. */
export function colRange(col: string | number, from: number, to: number): string {
  return `${a1(col, from)}:${a1(col, to)}`;
}

/** `F9:T9` — one row, a span of columns. */
export function rowRange(from: string | number, to: string | number, row: number): string {
  return `${a1(from, row)}:${a1(to, row)}`;
}

/** `B4:N7` — a rectangle. */
export function boxRange(
  colFrom: string | number,
  rowFrom: number,
  colTo: string | number,
  rowTo: number,
): string {
  return `${a1(colFrom, rowFrom)}:${a1(colTo, rowTo)}`;
}

/**
 * `JULY 2026` → `'JULY 2026'`. Always quoted (valid either way), apostrophes
 * doubled. REFUSES a name Excel itself would refuse, because a workbook that
 * saves with a broken reference is worse than one that never gets built.
 */
export function quoteSheet(name: string): string {
  assertSheetName(name);
  return `'${name.replace(/'/g, "''")}'`;
}

/** Throws unless `name` is a name Excel will accept for a worksheet. */
export function assertSheetName(name: string): void {
  if (name.length === 0) throw new Error('sheet name: must not be empty');
  if (name.length > MAX_SHEET_NAME) {
    throw new Error(`sheet name: "${name}" is ${name.length} chars, the limit is ${MAX_SHEET_NAME}`);
  }
  if (ILLEGAL_SHEET_CHARS.test(name)) {
    throw new Error(`sheet name: "${name}" contains one of [ ] : * ? / \\`);
  }
  if (name.startsWith("'") || name.endsWith("'")) {
    throw new Error(`sheet name: "${name}" may not begin or end with an apostrophe`);
  }
}

/** `'RC Movement'!E12` — a cross-tab reference. */
export function sheetRef(sheet: string, addr: string): string {
  return `${quoteSheet(sheet)}!${addr}`;
}

/** `'Checks'!F:F` — a whole-column cross-tab reference. */
export function sheetColRef(sheet: string, col: string): string {
  return `${quoteSheet(sheet)}!${col}:${col}`;
}

// ── formula composition ───────────────────────────────────────────────────────
// Deliberately thin: these exist so a range can never be pasted into a function
// name by hand, not to become a formula DSL. Anything more specific belongs in the
// sheet builder that means it.

/** `IF(<ref>="","",<ref>)` — the "pass a blank through as a blank" idiom. NULL IS
 *  NEVER 0 is a data rule (CLAUDE.md → Plant Operations Ledger); this is how the
 *  workbook keeps it across a link, since a bare `=X!A1` on an empty cell reads 0. */
export function passBlank(ref: string): string {
  return `IF(${ref}="","",${ref})`;
}

export function sum(range: string): string {
  return `SUM(${range})`;
}

/**
 * `IF(den>0, num/den, "")` — for a denominator that is a SUM over value cells, so
 * it is always a NUMBER. A blank cell compares as 0, so `>0` is a real guard here.
 *
 * ⚠ NOT safe when `den` is a cell that may hold a formula's `""`: in Excel TEXT is
 * greater than any number, so `""&gt;0` is TRUE and the division then raises
 * `#VALUE!`. Use {@link divBlank} for those — which is most of the rollup.
 */
export function safeDiv(num: string, den: string): string {
  return `IF(${den}>0,${num}/${den},"")`;
}

/**
 * `IFERROR(<expr>, "")` — THE ONE GUARD for a derived figure that may have nothing
 * to derive from. A blank is the honest answer; an error glyph in an emailed report
 * is a bug, and a 0 would read as a measurement (NULL IS NEVER 0).
 */
export function iferrorBlank(expr: string): string {
  return `IFERROR(${expr},"")`;
}

/**
 * `IFERROR(num/den, "")` — the division guard for EVERY ratio, price and per-kilo
 * figure in this workbook whose denominator is itself derived.
 *
 * WHY IFERROR AND NOT AN `IF(den>0,…)` TEST. Three different failures reach the
 * same cell and only one of them is a zero denominator:
 *   · `#DIV/0!` — a campaign with no fed kg, no produced kg, no CLOSED block, or no
 *     block inside the price set. All four occur: 22 of the 32 campaigns filed no
 *     production shift at all, and a campaign's first days have no closed block.
 *   · `#VALUE!` — a denominator CELL holding another formula's `""`. `""&gt;0` is TRUE
 *     in Excel, so an `IF(den>0,…)` test waves the blank straight through into the
 *     division. This is why `1-YIELD` and `FED PRICE/YIELD` cannot be guarded by a
 *     comparison at all.
 *   · `#VALUE!` from `SUMPRODUCT` over a range containing one of those `""` cells —
 *     which is how ONE campaign missing a price would otherwise poison the whole
 *     GROUP row.
 *
 * The consequence is deliberate and is the same refusal `fn_ops_ledger_group_kpis`
 * makes in SQL: a weighted group figure goes BLANK rather than quietly averaging
 * over a partial population.
 */
export function divBlank(num: string, den: string): string {
  return iferrorBlank(`${num}/${den}`);
}

// ── layout ────────────────────────────────────────────────────────────────────

/** One column of a sheet's layout: a LOGICAL id plus whatever the builder needs. */
export interface LayoutColumn {
  /** Stable across builds — `ttlFed`, `grade:3X50`, `block:JAN-26-BLK4`. */
  id: string;
  /** The header text. */
  label: string;
  /** Present so a builder never keeps a parallel array. */
  [k: string]: unknown;
}

/**
 * An ordered set of columns starting at `startIndex`, addressable by LOGICAL id.
 *
 * A price-denied build passes a shorter list; every letter moves and no caller
 * notices, which is the entire point. Asking for an id that is not present throws
 * — a ₱ formula must be OMITTED by the builder, never silently resolved to a
 * neighbouring column.
 */
export class Layout<C extends LayoutColumn = LayoutColumn> {
  readonly columns: readonly C[];
  readonly startIndex: number;
  private readonly index: Map<string, number>;

  constructor(columns: readonly C[], startIndex = 1) {
    this.columns = columns;
    this.startIndex = startIndex;
    this.index = new Map();
    columns.forEach((c, i) => {
      if (this.index.has(c.id)) throw new Error(`Layout: duplicate column id "${c.id}"`);
      this.index.set(c.id, startIndex + i);
    });
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** 1-based column index. Throws when the id is absent. */
  indexOf(id: string): number {
    const i = this.index.get(id);
    if (i === undefined) {
      throw new Error(
        `Layout: no column "${id}" in this build (present: ${[...this.index.keys()].join(', ')})`,
      );
    }
    return i;
  }

  letter(id: string): string {
    return colLetter(this.indexOf(id));
  }

  /** `C12` for this column on that row. */
  cell(id: string, row: number): string {
    return a1(this.indexOf(id), row);
  }

  /** `C9:C41` for this column over those rows. */
  span(id: string, from: number, to: number): string {
    return colRange(this.indexOf(id), from, to);
  }

  /** The column of the LAST declared column — used for `SUM(F9:<last>9)` row totals. */
  get lastIndex(): number {
    return this.startIndex + this.columns.length - 1;
  }

  get lastLetter(): string {
    return colLetter(this.lastIndex);
  }

  /** The columns between two ids inclusive, as a row range on `row`. */
  rowSpan(fromId: string, toId: string, row: number): string {
    return rowRange(this.indexOf(fromId), this.indexOf(toId), row);
  }

  get(id: string): C {
    const i = this.index.get(id);
    if (i === undefined) throw new Error(`Layout: no column "${id}"`);
    return this.columns[i - this.startIndex];
  }
}
