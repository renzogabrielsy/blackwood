// =====================================================================
// ICTC Owner Analytics — THE YEAR OVERLAY (owner feedback R9, 2026-09-03)
// =====================================================================
// Renzo: *"For all dropdown charts, instead of making it a long chart that
// encompasses multiple years, you could have each year be represented by a
// line — solid line, dotted, area line, etc of differing colors (which we can
// also customize and set) — and have the axes be set to just January to
// December, Q1 to Q4 and batches to be JANUARY to DECEMBER. If we have a
// custom batch name that isn't a month (this is for production batches), then
// it should be placed chronologically within its production date month."*
//
// ── WHAT CHANGED, IN ONE SENTENCE ────────────────────────────────────
// The expand chart's X axis stops being TIME and becomes POSITION-IN-THE-YEAR,
// and the year moves from the axis into the SERIES.
//
// ── WHY THIS FILE IS PURE, AND WHAT IT DELIBERATELY DOES NOT DO ──────
// It does exactly two things — decide the SLOTS an axis has, and PLACE each
// point in one of them. It never adds, averages, weights or rounds anything.
// That line is where every previous round's arithmetic bug lived: the moment a
// placement helper starts folding two points together it has become a second
// definition of a number that `matrix.ts` already owns. So a slot that somehow
// receives two points for one year KEEPS THE FIRST AND REPORTS THE COLLISION
// (`OverlayFold.collisions`) rather than summing them — the same discipline as
// `foldCampaignRows` counting its `fed_kg` disagreements instead of asserting
// there are none.
//
// **A missing point is `null`, never `0`.** The whole page rests on that.
// A year with no April is a year that has no April, and a zero there would
// draw a line down to the floor and back.
//
// ── THE ONE EXCEPTION, AND WHY IT IS NOT `connectNulls` ──────────────
// A CUSTOM campaign slot belongs to the year that ran it. `SRC` is a 2026
// campaign, so 2024 and 2025 have no slot there at all — and a broken line at
// that tick says "2024 is missing a figure here", which is false. Those years
// are not missing anything; the column is simply not theirs.
//
// So a run of custom slots that belong to OTHER years is **BRIDGED**: the point
// is given the straight-line value between its two real neighbours and flagged
// `bridged`, so the line draws through it while the dot and the tooltip stay
// away. It is a placement fact, marked per point, and NOT a blanket
// `connectNulls` — which would also paper over a genuinely missing MARCH, the
// one thing a broken line must keep saying. Two guards keep the distinction
// exact: only a slot the year has NO POINT AT ALL at can be bridged (a year
// that ran SRC and recorded nothing still breaks), and the run must be bounded
// by REAL values on both sides (so a bridge can never span a missing month).
//
// ── THE CUSTOM-CAMPAIGN RULE, AND THE THREE THINGS IT REFUSES TO GUESS ─
// A campaign is normally NAMED for a month (`AUGUST 2026`), which is the only
// thing about it that is reliably chronological — `campaignMonthIndex()` in
// `campaign.ts` is THE definition and is reused here rather than re-spelled.
// A campaign whose name is NOT one of the twelve (Renzo's hypothetical `SRC`)
// gets a slot of its OWN, placed immediately after the month its START DATE
// falls in. Three refusals keep that honest:
//
//   1. **The name always wins for a month-named campaign.** `AUGUST 2026` sits
//      in the AUGUST slot even if its first reported day is in September or in
//      the December before. Moving it would silently re-file a campaign the
//      plant itself named, and the name is the plant's own statement.
//   2. **A custom name with NO start date is never placed by inference.** It
//      goes to the END of the axis carrying `placement: "unplaced"`, so the UI
//      can say why rather than putting it in January and hoping.
//   3. **Two customs in one month are ordered by start date, then by name** —
//      a total order, so the axis is stable across renders and across years
//      rather than depending on which year happened to load first.
//
// ── THE PALETTE IS COMPUTED, NOT CHOSEN ──────────────────────────────
// The eight year colours are the validated categorical palette (light and dark
// columns both), checked with the data-viz validator rather than eyeballed:
// light — worst adjacent CVD ΔE 9.1, normal-vision ΔE 19.6; dark — 8.4 / 19.3;
// every slot inside its mode's lightness band and over the chroma floor. Three
// light slots sit under 3:1 against the surface, which obliges *relief*: the
// chart always ships a legend with the year spelled out, so identity is never
// carried by colour alone. The stroke style is the second encoding on top of
// that, which is also what makes the printed sheet legible in mono.
//
// Colour and style are both PURE FUNCTIONS OF THE YEAR — never of the year's
// position in a filtered list. That is the data-viz rule "colour follows the
// entity, never its rank": switching 2024 off must not repaint 2025, and the
// same year must be the same colour in every expand on the page (which is also
// what makes a `localStorage` override keyed by year mean anything).
//
// Pure and client-safe: no React, no Supabase, no `server-only`, no DOM.
// =====================================================================

import { campaignMonthIndex } from "./campaign";

// ---------------------------------------------------------------------
// The axis
// ---------------------------------------------------------------------

/**
 * The three clocks an overlay is possible on.
 *
 * `Y` is deliberately absent: at YEAR granularity a year IS one point, so
 * "one series per year" is twelve series of one point each — a scatter of
 * disconnected dots where the single line it replaces was already the answer.
 * The card says so where a reader meets it rather than only here.
 */
export type OverlayClock = "M" | "Q" | "B";

export type OverlaySlotKind = "month" | "quarter" | "custom";

/** How a CUSTOM campaign slot earned its position. `null` for a fixed slot. */
export type OverlayPlacement = "start_date" | "unplaced" | null;

export interface OverlaySlot {
  /** Stable identity — `m08`, `q3`, `c:SRC`. Unique within an axis. */
  key: string;
  /** What the axis tick says — `Aug`, `Q3`, `AUGUST`, `SRC`. */
  label: string;
  /** The tick's long form, for a tooltip heading. */
  fullLabel: string;
  kind: OverlaySlotKind;
  /**
   * 1–12 for a month slot, 1–4 for a quarter, and for a CUSTOM slot the month
   * it was placed after (or `null` when it could not be placed at all).
   */
  month: number | null;
  placement: OverlayPlacement;
  /** Earliest start date seen for a custom slot — what ordered it. */
  startDate: string | null;
}

/** One point handed to the fold. Everything it needs, nothing it does not. */
export interface OverlayPoint {
  periodKey: string;
  year: number;
  /**
   * Position within the year, as `Period.seq` already carries it: 1–12 at
   * month granularity, 1–4 at quarter. **Ignored on the batch clock**, where
   * the campaign's own NAME is the placement fact and `seq` is merely its
   * echo.
   */
  seq: number;
  value: number | null;
  /** `March 2026` / `Q1 2026` / `AUGUST 2026` — what a tooltip shows. */
  fullLabel: string;
  /** Batch clock only: the campaign's own name — `AUGUST`, `SRC`. */
  name?: string | null;
  /** Batch clock only: `YYYY-MM-DD`, the campaign's first production day. */
  startDate?: string | null;
}

export interface OverlaySeries {
  year: number;
  /** The recharts data key — `y2026`. */
  dataKey: string;
  /** The tooltip's label key alongside it — `f2026`. */
  labelKey: string;
  /** How many slots this year actually carries a figure in. */
  withValue: number;
}

/**
 * One recharts row: a slot, plus `y<year>` / `f<year>` / `b<year>` per series —
 * the value, its full period label, and whether the value at that slot is a
 * BRIDGE rather than a figure (see the header). A bridged cell must never be
 * drawn as a dot or read out in a tooltip: it is a line segment, not a number.
 */
export type OverlayRow = {
  slotKey: string;
  label: string;
  fullLabel: string;
  kind: OverlaySlotKind;
  placement: OverlayPlacement;
} & Record<string, unknown>;

export interface OverlayCollision {
  slotKey: string;
  year: number;
  /** The point that kept the slot, and the one that was refused it. */
  kept: string;
  dropped: string;
}

export interface OverlayFold {
  slots: OverlaySlot[];
  /** Ascending by year — the legend's order and the draw order. */
  series: OverlaySeries[];
  rows: OverlayRow[];
  /** Empty in every measured case; reported rather than assumed away. */
  collisions: OverlayCollision[];
  /** Custom campaign names that carry no start date, so could not be placed. */
  unplaced: string[];
  /**
   * Every (year, slot) a line is drawn STRAIGHT THROUGH because the slot is a
   * custom campaign belonging to a different year. Reported rather than left
   * implicit — a value on the chart that is not a figure is exactly the kind of
   * thing that has to be nameable.
   */
  bridges: { year: number; slotKey: string }[];
}

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `AUGUST` … the twelve, upper-cased, as the campaign axis prints them. */
const MONTH_UPPER = MONTH_LONG.map((m) => m.toUpperCase());

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-08-29` → 8. Null for anything that is not a `YYYY-MM-DD` prefix. */
export function monthOfDate(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? month : null;
}

/** The 12 fixed month slots, in calendar order. */
function monthSlots(kind: "month" | "campaign"): OverlaySlot[] {
  return MONTH_LONG.map((_, i) => ({
    key: `m${pad2(i + 1)}`,
    label: kind === "campaign" ? MONTH_UPPER[i] : MONTH_SHORT[i],
    fullLabel: MONTH_LONG[i],
    kind: "month" as const,
    month: i + 1,
    placement: null,
    startDate: null,
  }));
}

const QUARTER_SLOTS: readonly OverlaySlot[] = [1, 2, 3, 4].map((q) => ({
  key: `q${q}`,
  label: `Q${q}`,
  fullLabel: `Quarter ${q}`,
  kind: "quarter" as const,
  month: q,
  placement: null,
  startDate: null,
}));

/**
 * The slot one point belongs in — THE placement rule, in one function so the
 * axis builder and the fold can never disagree about where a point goes.
 *
 * Returns `null` for a point that names no slot at all (a month `seq` outside
 * 1–12, a batch-clock point with a blank name). A null is DROPPED by the fold
 * and never quietly bucketed somewhere.
 */
export function slotKeyForPoint(
  clock: OverlayClock,
  point: Pick<OverlayPoint, "seq" | "name">,
): string | null {
  if (clock === "M") {
    return point.seq >= 1 && point.seq <= 12 ? `m${pad2(point.seq)}` : null;
  }
  if (clock === "Q") {
    return point.seq >= 1 && point.seq <= 4 ? `q${point.seq}` : null;
  }
  const name = (point.name ?? "").trim().toUpperCase();
  if (!name) return null;
  // THE NAME WINS. `campaignMonthIndex` is the ONE definition of "is this one
  // of the twelve", already used by the column sort and the checklist.
  const named = campaignMonthIndex(name);
  return named >= 0 ? `m${pad2(named + 1)}` : `c:${name}`;
}

/**
 * The complete axis for a batch-clock overlay: the twelve month slots, with
 * every custom campaign inserted immediately after the month its start date
 * falls in, and the datessless ones parked at the end.
 */
function campaignSlots(points: readonly OverlayPoint[]): {
  slots: OverlaySlot[];
  unplaced: string[];
} {
  const base = monthSlots("campaign");

  /** One entry per DISTINCT custom name, holding its earliest start date. */
  const customs = new Map<string, { name: string; startDate: string | null }>();
  for (const p of points) {
    const key = slotKeyForPoint("B", p);
    if (!key || !key.startsWith("c:")) continue;
    const name = key.slice(2);
    const prev = customs.get(key);
    const start = p.startDate ?? null;
    if (!prev) {
      customs.set(key, { name, startDate: start });
      continue;
    }
    // The EARLIEST start date a name was ever seen with. A custom name that
    // recurs in two years is one slot, and its position is the first time the
    // plant ran it — a later, later-starting repeat may not shuffle the axis
    // under a reader comparing the two.
    if (start && (prev.startDate == null || start < prev.startDate)) {
      prev.startDate = start;
    }
  }

  const placed = new Map<number, OverlaySlot[]>();
  const unplaced: OverlaySlot[] = [];

  for (const [key, c] of customs) {
    const month = monthOfDate(c.startDate);
    const slot: OverlaySlot = {
      key,
      label: c.name,
      fullLabel: c.name,
      kind: "custom",
      month,
      placement: month == null ? "unplaced" : "start_date",
      startDate: c.startDate,
    };
    if (month == null) unplaced.push(slot);
    else placed.set(month, [...(placed.get(month) ?? []), slot]);
  }

  /** Total order: start date first, then name. Never render-order dependent. */
  const order = (a: OverlaySlot, b: OverlaySlot) => {
    const ad = a.startDate ?? "";
    const bd = b.startDate ?? "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  };

  const slots: OverlaySlot[] = [];
  for (const m of base) {
    slots.push(m);
    const extra = placed.get(m.month!);
    if (extra) slots.push(...[...extra].sort(order));
  }
  slots.push(...[...unplaced].sort(order));

  return { slots, unplaced: unplaced.map((s) => s.label) };
}

/** The fixed axis for one clock, given the points that will ride on it. */
export function buildOverlaySlots(
  clock: OverlayClock,
  points: readonly OverlayPoint[],
): { slots: OverlaySlot[]; unplaced: string[] } {
  if (clock === "M") return { slots: monthSlots("month"), unplaced: [] };
  if (clock === "Q") return { slots: [...QUARTER_SLOTS], unplaced: [] };
  return campaignSlots(points);
}

export function seriesDataKey(year: number): string {
  return `y${year}`;
}

export function seriesLabelKey(year: number): string {
  return `f${year}`;
}

/** `b2026` — true where the value at that slot is a bridge, not a figure. */
export function seriesBridgedKey(year: number): string {
  return `b${year}`;
}

/**
 * THE FOLD — one series per year, placed into the fixed axis.
 *
 * Nothing is aggregated (see the file header). `points` is expected to be one
 * row's `history`, already filtered to the years the reader left switched on.
 */
export function buildYearOverlay(
  clock: OverlayClock,
  points: readonly OverlayPoint[],
): OverlayFold {
  const { slots, unplaced } = buildOverlaySlots(clock, points);
  const slotIndex = new Map(slots.map((s, i) => [s.key, i] as const));

  const years = [...new Set(points.map((p) => p.year))].sort((a, b) => a - b);
  const series: OverlaySeries[] = years.map((year) => ({
    year,
    dataKey: seriesDataKey(year),
    labelKey: seriesLabelKey(year),
    withValue: 0,
  }));
  const seriesByYear = new Map(series.map((s) => [s.year, s] as const));

  const rows: OverlayRow[] = slots.map((s) => {
    const row: OverlayRow = {
      slotKey: s.key,
      label: s.label,
      fullLabel: s.fullLabel,
      kind: s.kind,
      placement: s.placement,
    };
    for (const y of years) {
      row[seriesDataKey(y)] = null;
      row[seriesLabelKey(y)] = null;
      row[seriesBridgedKey(y)] = false;
    }
    return row;
  });

  const collisions: OverlayCollision[] = [];
  const taken = new Map<string, string>();

  for (const p of points) {
    const key = slotKeyForPoint(clock, p);
    if (key == null) continue;
    const i = slotIndex.get(key);
    if (i == null) continue;
    const cell = `${key}|${p.year}`;
    const already = taken.get(cell);
    if (already !== undefined) {
      // NOT summed, NOT averaged, NOT overwritten — recorded. See the header.
      collisions.push({
        slotKey: key,
        year: p.year,
        kept: already,
        dropped: p.periodKey,
      });
      continue;
    }
    taken.set(cell, p.periodKey);
    rows[i][seriesDataKey(p.year)] = p.value;
    rows[i][seriesLabelKey(p.year)] = p.fullLabel;
    if (p.value != null) {
      const s = seriesByYear.get(p.year);
      if (s) s.withValue += 1;
    }
  }

  // ── THE BRIDGE PASS ───────────────────────────────────────────────────
  // Runs LAST, over the placed rows, so it can only ever add a value to a cell
  // that placement left empty — it can never touch, move or restate a figure.
  const bridges: { year: number; slotKey: string }[] = [];
  for (const year of years) {
    const vKey = seriesDataKey(year);
    const bKey = seriesBridgedKey(year);
    // "Has a point" is the placement fact, NOT "has a value". A year that ran
    // this campaign and recorded nothing is genuinely missing a figure and its
    // line must break there, exactly as a missing month does.
    const owns = (i: number) => taken.has(`${slots[i].key}|${year}`);
    const valueAt = (i: number) => {
      const v = rows[i][vKey];
      return typeof v === "number" ? v : null;
    };

    let i = 0;
    while (i < slots.length) {
      if (slots[i].kind !== "custom" || owns(i)) {
        i += 1;
        continue;
      }
      // The whole run of consecutive foreign custom slots — two customs filed
      // in the same month are one gap in another year's line, not two.
      let j = i;
      while (j < slots.length && slots[j].kind === "custom" && !owns(j)) j += 1;

      const before = i - 1;
      const after = j;
      const a = before >= 0 ? valueAt(before) : null;
      const b = after < slots.length ? valueAt(after) : null;
      // BOUNDED BY REAL VALUES ON BOTH SIDES. Without this a bridge could span
      // a missing MARCH and quietly draw across the one gap that is real; and
      // a custom slot at either end of the axis has nothing to bridge between.
      if (a != null && b != null) {
        const span = after - before;
        for (let k = i; k < j; k += 1) {
          rows[k][vKey] = a + ((b - a) * (k - before)) / span;
          rows[k][bKey] = true;
          bridges.push({ year, slotKey: slots[k].key });
        }
      }
      i = j;
    }
  }

  return { slots, series, rows, collisions, unplaced, bridges };
}

// ---------------------------------------------------------------------
// The year palette — colour AND stroke, both pure functions of the year
// ---------------------------------------------------------------------

export type YearLineStyle = "solid" | "dashed" | "dotted" | "dashdot" | "area";

export const YEAR_LINE_STYLES: readonly YearLineStyle[] = [
  "solid",
  "dashed",
  "dotted",
  "dashdot",
  "area",
];

/** Human copy for the Style popover — a control names what it does. */
export const YEAR_LINE_STYLE_LABEL: Record<YearLineStyle, string> = {
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
  dashdot: "Dash-dot",
  area: "Area",
};

/**
 * The SVG `stroke-dasharray` for each style. `undefined` = an unbroken stroke.
 *
 * These are the second encoding the palette's light-mode contrast warning
 * obliges, and they are what makes the printed sheet readable in mono: four
 * distinguishable strokes cover four concurrent years without any colour.
 */
export const YEAR_DASH: Record<YearLineStyle, string | undefined> = {
  solid: undefined,
  dashed: "6 4",
  dotted: "1.5 3.5",
  dashdot: "8 3 2 3",
  area: undefined,
};

/**
 * The eight categorical slots, as theme tokens.
 *
 * `var(--bw-year-N)` resolves in an SVG presentation attribute (the page's
 * existing `var(--chart-N)` series prove it), and a token is what lets the
 * dark column be its own SELECTED step rather than an automatic flip of the
 * light one — the two sets were validated separately against their own
 * surfaces.
 */
export const YEAR_COLOR_TOKENS: readonly string[] = [
  "var(--bw-year-1)",
  "var(--bw-year-2)",
  "var(--bw-year-3)",
  "var(--bw-year-4)",
  "var(--bw-year-5)",
  "var(--bw-year-6)",
  "var(--bw-year-7)",
  "var(--bw-year-8)",
];

/** What the swatch row in the Style popover offers, in palette order. */
export const YEAR_SWATCHES: readonly { token: string; name: string }[] = [
  { token: "var(--bw-year-1)", name: "Blue" },
  { token: "var(--bw-year-2)", name: "Orange" },
  { token: "var(--bw-year-3)", name: "Aqua" },
  { token: "var(--bw-year-4)", name: "Yellow" },
  { token: "var(--bw-year-5)", name: "Magenta" },
  { token: "var(--bw-year-6)", name: "Green" },
  { token: "var(--bw-year-7)", name: "Violet" },
  { token: "var(--bw-year-8)", name: "Red" },
];

/**
 * The anchor year of the palette cycle.
 *
 * 2024 is where `rc_out` begins, i.e. the first year every row on the page has
 * something to say, and anchoring there puts the three years a reader actually
 * looks at — 2024 / 2025 / 2026 — on slots 1 / 2 / 3, which are exactly the
 * three the validator clears on the ALL-PAIRS test in both modes. The cycle is
 * arithmetic on the year itself, so it never depends on which years are on
 * screen.
 */
export const YEAR_COLOR_ANCHOR = 2024;

export function yearColorSlot(year: number): number {
  return (((year - YEAR_COLOR_ANCHOR) % 8) + 8) % 8;
}

export function defaultYearColor(year: number): string {
  return YEAR_COLOR_TOKENS[yearColorSlot(year)];
}

/**
 * The default stroke, cycling solid → dashed → dotted → dash-dot with the
 * colour slot. Four styles rather than five: `area` is offered in the picker
 * (Renzo asked for it) and is never a default, because two filled areas over
 * one another hide each other in a way four strokes never do.
 */
export function defaultYearStyle(year: number): YearLineStyle {
  return YEAR_LINE_STYLES[yearColorSlot(year) % 4];
}

export interface YearStyleOverride {
  color?: string;
  style?: YearLineStyle;
}

/** The persisted shape — year (as a string) → whatever was overridden. */
export type YearStyleMap = Readonly<Record<string, YearStyleOverride>>;

export interface ResolvedYearStyle {
  year: number;
  color: string;
  style: YearLineStyle;
  dash: string | undefined;
  /** The reader changed something about this year. Drives the Reset affordance. */
  customised: boolean;
}

export function resolveYearStyle(
  year: number,
  overrides: YearStyleMap | null | undefined,
): ResolvedYearStyle {
  const o = overrides?.[String(year)];
  const color = o?.color ?? defaultYearColor(year);
  const style = o?.style ?? defaultYearStyle(year);
  return {
    year,
    color,
    style,
    dash: YEAR_DASH[style],
    customised: Boolean(o?.color || o?.style),
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Read an UNTRUSTED `localStorage` value into the map.
 *
 * The same discipline as `row-order.ts`: anything the browser hands back is a
 * string somebody could have edited, so every field is checked and anything
 * unrecognised is dropped rather than trusted. A colour must be either one of
 * the palette tokens or a plain `#rrggbb` — never an arbitrary string, which
 * would put an attacker-controlled value straight into a `style` attribute.
 */
export function parseYearStyles(raw: string | null | undefined): YearStyleMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, YearStyleOverride> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d{4}$/.test(key)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as { color?: unknown; style?: unknown };
    const entry: YearStyleOverride = {};
    if (
      typeof v.color === "string" &&
      (HEX.test(v.color) || (YEAR_COLOR_TOKENS as readonly string[]).includes(v.color))
    ) {
      entry.color = v.color;
    }
    if (
      typeof v.style === "string" &&
      (YEAR_LINE_STYLES as readonly string[]).includes(v.style)
    ) {
      entry.style = v.style as YearLineStyle;
    }
    if (entry.color || entry.style) out[key] = entry;
  }
  return out;
}

/** Drop empty entries so an all-default map serialises to `{}`, not noise. */
export function pruneYearStyles(map: YearStyleMap): YearStyleMap {
  const out: Record<string, YearStyleOverride> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && (v.color || v.style)) out[k] = { ...v };
  }
  return out;
}
