// =====================================================================
// Digest UI — display-only formatting helpers (client + server safe)
// =====================================================================
// Pure presentational formatters. No aggregation (HARD RULE: that lives
// in SQL). These only turn already-computed numbers into strings.
//
// fmtKg + fmtPhpNumber are the CANONICAL formatters — their single home is
// lib/format-utils.ts. Re-exported here so the digest components keep importing
// them from "./format" unchanged (see DUP-5 note in format-utils.ts for why the
// blank-on-zero grid variants are intentionally NOT unified).
// =====================================================================

import { format, parseISO } from "date-fns";
import { fmtKg, fmtPhpNumber } from "@/lib/format-utils";
export { fmtKg, fmtPhpNumber };

/** kWh with thousands separators, 0 dp. Same rounding as fmtKg but a distinct
 *  UNIT, so it stays a named function here rather than aliasing fmtKg. */
export function fmtKwh(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Signed percentage, e.g. "+12.4%" / "-3.0%". */
export function fmtDeltaPct(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

/** Format a value by its declared unit (kg / kWh / ₱ / ""). */
export function fmtByUnit(value: number, unit: string): string {
  switch (unit) {
    case "kg":
      return fmtKg(value);
    case "kWh":
      return fmtKwh(value);
    case "₱":
      return fmtPhpNumber(value);
    default:
      return value.toLocaleString("en-US");
  }
}

/** A yyyy-MM-dd business date as a short, unambiguous label — "Aug 1".
 *  `parseISO`, never `new Date()`, so a date-only string can't drift a day
 *  across timezones (the house rule, see bag-inventory). */
export function fmtShortDate(date: string): string {
  try {
    return format(parseISO(date), "MMM d");
  } catch {
    return date;
  }
}

/** How old a business date is, in plain words — "today", "yesterday",
 *  "2 days ago". Takes the already-computed calendar-day gap so the caller
 *  keeps ownership of the date math. */
export function fmtDayAge(days: number | undefined): string {
  if (days == null || days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** "1 working day behind" / "3 working days behind" — the lateness of a
 *  lag-by-design stream, counted in PLANNED working days (rest days and the
 *  operational date itself are excluded upstream, in SQL). For a wide slot. */
export function fmtMissedDays(missed: number): string {
  return `${missed} working day${missed === 1 ? "" : "s"} behind`;
}

/** The same fact in a phrase short enough for a KPI card's shared sub-line:
 *  one outstanding planned working day == one report that has not arrived. */
export function fmtReportsDue(missed: number): string {
  return `${missed} report${missed === 1 ? "" : "s"} due`;
}

/** Relative time from an ISO timestamp, e.g. "3 min ago", "2 h ago", "Just now". */
export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} d ago`;
  const mo = Math.round(day / 30);
  return `${mo} mo ago`;
}

/** Compact stringification of an unknown diff value for chip rendering. */
export function diffValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "∅";
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toLocaleString("en-US") : String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 24 ? s.slice(0, 22) + "…" : s;
}
