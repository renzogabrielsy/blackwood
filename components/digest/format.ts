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

/** One grade's projected tonnage parsed from the production_schedule `grades`
 *  JSONB ({ "3X50": 21, "4X8": 5 } → grade → projected tons). */
export interface GradeTon {
  grade: string;
  tons: number;
}

/** Parse the production_schedule `grades` JSONB into { grade, tons } entries,
 *  heaviest first, dropping null / zero / non-finite tonnage. Defensive: returns
 *  [] for null, arrays, strings, or any non-object shape (rest days / legacy
 *  rows), so a rest day renders a clean dash. */
export function parseGradeTons(grades: unknown): GradeTon[] {
  if (grades == null || typeof grades !== "object" || Array.isArray(grades)) {
    return [];
  }
  const out: GradeTon[] = [];
  for (const [grade, raw] of Object.entries(grades as Record<string, unknown>)) {
    const tons = typeof raw === "number" ? raw : Number(raw);
    if (!grade || !Number.isFinite(tons) || tons === 0) continue;
    out.push({ grade, tons });
  }
  return out.sort((a, b) => b.tons - a.tons);
}

/** Compact tons label for grade chips — whole numbers bare, else one decimal. */
export function fmtGradeTons(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Compact plain-text grade breakdown for a `title`/tooltip, e.g.
 *  "3X50 · 21t   4X8 · 5t". Empty string when no grades. */
export function gradeTonsTitle(entries: GradeTon[]): string {
  return entries.map((g) => `${g.grade} · ${fmtGradeTons(g.tons)}t`).join("   ");
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
