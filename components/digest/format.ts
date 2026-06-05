// =====================================================================
// Digest UI — display-only formatting helpers (client + server safe)
// =====================================================================
// Pure presentational formatters. No aggregation (HARD RULE: that lives
// in SQL). These only turn already-computed numbers into strings.
// =====================================================================

/** Thousands-separated integer kg, e.g. 12,480. No unit suffix. */
export function fmtKg(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** kWh with thousands separators, 0 dp. */
export function fmtKwh(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** ₱ accounting figure, 2 dp. Returns the number part only (no symbol). */
export function fmtPhpNumber(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
