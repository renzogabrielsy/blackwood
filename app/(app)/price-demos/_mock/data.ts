/**
 * SHARED MOCK DATA for the Price & Volume Analysis demo pages.
 *
 * This is a charcoal-shaped static dataset used ONLY by the /price-demos design
 * concepts. It is NOT wired to Supabase — the four demos are frontend design
 * explorations (planning stage). All four demos consume THIS data so they can be
 * compared fairly (same numbers, different visualizations).
 *
 * Data shape mirrors what the real feature would aggregate from `deliveries`:
 *   monthly, per-supplier   →  weighted-avg ₱/kg (price)  +  volume (kg) IN.
 *
 * Deliberate "stories" baked in so the demos have something to reveal:
 *   • ORNALES      — the anchor: cheapest big-volume supplier, price drifts up slowly
 *   • BORROMEO     — the concern: price climbing hard all year (₱37.5 → ₱47.1)
 *   • TAG-AT       — premium niche: highest price, small stable volume
 *   • LLANTO       — volatile price, mid volume
 *   • SUAREZ       — flat price, steadily declining volume (a fading supplier)
 *   • MONTEHERMOSO — cheap but intermittent (several months with no deliveries)
 * Plus a season: volume dips mid-year (Jun–Aug rainy season) and recovers in Q4.
 */

export interface MonthKey {
  /** ISO-ish key, e.g. '2026-01' */
  key: string;
  /** Short label, e.g. 'Jan' */
  label: string;
  /** Full label, e.g. 'January' */
  full: string;
}

export const MONTHS: MonthKey[] = [
  { key: '2026-01', label: 'Jan', full: 'January' },
  { key: '2026-02', label: 'Feb', full: 'February' },
  { key: '2026-03', label: 'Mar', full: 'March' },
  { key: '2026-04', label: 'Apr', full: 'April' },
  { key: '2026-05', label: 'May', full: 'May' },
  { key: '2026-06', label: 'Jun', full: 'June' },
  { key: '2026-07', label: 'Jul', full: 'July' },
  { key: '2026-08', label: 'Aug', full: 'August' },
  { key: '2026-09', label: 'Sep', full: 'September' },
  { key: '2026-10', label: 'Oct', full: 'October' },
  { key: '2026-11', label: 'Nov', full: 'November' },
  { key: '2026-12', label: 'Dec', full: 'December' },
];

export interface SupplierMeta {
  name: string;
  /** Tailwind-friendly hex used by recharts series / custom SVG. */
  color: string;
}

export const SUPPLIERS: SupplierMeta[] = [
  { name: 'ORNALES',      color: '#2563eb' }, // blue
  { name: 'BORROMEO',     color: '#dc2626' }, // red
  { name: 'TAG-AT',       color: '#9333ea' }, // purple
  { name: 'LLANTO',       color: '#0d9488' }, // teal
  { name: 'SUAREZ',       color: '#d97706' }, // amber
  { name: 'MONTEHERMOSO', color: '#65a30d' }, // lime
];

/**
 * Raw per-supplier monthly tuples: [avgPricePhpPerKg, volumeKg].
 * A 0/0 entry means "no deliveries from this supplier that month."
 * Index 0..11 aligns with MONTHS.
 */
const RAW: Record<string, [number, number][]> = {
  ORNALES: [
    [38.0, 165000], [38.2, 158000], [38.5, 172000], [38.8, 149000],
    [39.2, 155000], [39.5, 121000], [39.8, 98000], [40.1, 110000],
    [39.9, 138000], [39.6, 161000], [39.4, 175000], [39.7, 168000],
  ],
  BORROMEO: [
    [37.5, 120000], [38.0, 115000], [38.9, 128000], [39.8, 118000],
    [41.0, 124000], [42.2, 96000], [43.5, 82000], [44.8, 90000],
    [45.5, 112000], [46.2, 130000], [46.8, 141000], [47.1, 135000],
  ],
  'TAG-AT': [
    [44.0, 42000], [44.2, 38000], [44.1, 45000], [44.5, 36000],
    [44.3, 40000], [44.8, 28000], [45.0, 22000], [45.2, 25000],
    [44.6, 34000], [44.4, 41000], [44.9, 39000], [44.7, 43000],
  ],
  LLANTO: [
    [40.5, 88000], [41.8, 79000], [39.9, 95000], [42.3, 72000],
    [40.1, 84000], [43.0, 61000], [41.2, 54000], [44.1, 49000],
    [40.8, 77000], [39.7, 90000], [42.5, 83000], [41.0, 86000],
  ],
  SUAREZ: [
    [39.0, 95000], [39.1, 88000], [39.0, 82000], [39.2, 76000],
    [39.1, 70000], [39.3, 58000], [39.2, 49000], [39.4, 44000],
    [39.1, 47000], [39.3, 52000], [39.2, 55000], [39.0, 53000],
  ],
  MONTEHERMOSO: [
    [36.5, 45000], [0, 0], [36.8, 52000], [37.0, 38000],
    [0, 0], [36.2, 29000], [0, 0], [36.9, 31000],
    [37.2, 40000], [0, 0], [37.5, 48000], [37.1, 44000],
  ],
};

export interface Cell {
  supplier: string;
  monthKey: string;
  monthIndex: number;
  /** Weighted-avg ₱/kg for that supplier-month. null = no deliveries. */
  price: number | null;
  /** Volume IN (kg) that supplier-month. */
  volumeKg: number;
}

/** Flattened supplier × month grid (the canonical record list). */
export const CELLS: Cell[] = SUPPLIERS.flatMap((s) =>
  RAW[s.name].map(([price, volumeKg], monthIndex) => ({
    supplier: s.name,
    monthKey: MONTHS[monthIndex].key,
    monthIndex,
    price: price > 0 ? price : null,
    volumeKg,
  })),
);

/** Quick lookup: cell(supplier, monthIndex). */
export function cell(supplier: string, monthIndex: number): Cell | undefined {
  return CELLS.find((c) => c.supplier === supplier && c.monthIndex === monthIndex);
}

export interface MonthlyTotal {
  monthKey: string;
  label: string;
  full: string;
  monthIndex: number;
  /** Total volume IN (kg) across all suppliers. */
  volumeKg: number;
  /** Volume-weighted average ₱/kg across all suppliers that month. */
  avgPrice: number;
  deliveries: number; // synthetic count, ~ volume / 18000 (avg truckload)
}

/** Per-month rollup: total volume + volume-weighted avg price. */
export const MONTHLY_TOTALS: MonthlyTotal[] = MONTHS.map((m, i) => {
  const monthCells = CELLS.filter((c) => c.monthIndex === i && c.volumeKg > 0);
  const volumeKg = monthCells.reduce((acc, c) => acc + c.volumeKg, 0);
  const weighted = monthCells.reduce((acc, c) => acc + (c.price ?? 0) * c.volumeKg, 0);
  return {
    monthKey: m.key,
    label: m.label,
    full: m.full,
    monthIndex: i,
    volumeKg,
    avgPrice: volumeKg > 0 ? weighted / volumeKg : 0,
    deliveries: Math.round(volumeKg / 18000),
  };
});

export interface SupplierSummary {
  name: string;
  color: string;
  /** YTD total volume (kg). */
  totalVolumeKg: number;
  /** Volume-weighted YTD avg ₱/kg. */
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  /** First vs last active month price delta (₱). + = got more expensive. */
  priceDeltaYtd: number;
  /** % change first→last active month. */
  priceChangePct: number;
  /** Per-month price series (null for no-delivery months). */
  priceSeries: (number | null)[];
  /** Per-month volume series (kg). */
  volumeSeries: number[];
  /** Share of total YTD volume (0..1). */
  volumeShare: number;
}

const GRAND_VOLUME = CELLS.reduce((acc, c) => acc + c.volumeKg, 0);

export const SUPPLIER_SUMMARIES: SupplierSummary[] = SUPPLIERS.map((s) => {
  const rows = RAW[s.name];
  const priceSeries = rows.map(([p]) => (p > 0 ? p : null));
  const volumeSeries = rows.map(([, v]) => v);
  const active = rows.filter(([p, v]) => p > 0 && v > 0);
  const totalVolumeKg = volumeSeries.reduce((a, b) => a + b, 0);
  const weighted = rows.reduce((acc, [p, v]) => acc + (p > 0 ? p * v : 0), 0);
  const prices = active.map(([p]) => p);
  const firstPrice = prices[0] ?? 0;
  const lastPrice = prices[prices.length - 1] ?? 0;
  return {
    name: s.name,
    color: s.color,
    totalVolumeKg,
    avgPrice: totalVolumeKg > 0 ? weighted / totalVolumeKg : 0,
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
    priceDeltaYtd: lastPrice - firstPrice,
    priceChangePct: firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0,
    priceSeries,
    volumeSeries,
    volumeShare: GRAND_VOLUME > 0 ? totalVolumeKg / GRAND_VOLUME : 0,
  };
});

/** Headline KPIs for the whole portfolio (YTD). */
export const PORTFOLIO = {
  totalVolumeKg: GRAND_VOLUME,
  /** Volume-weighted blended ₱/kg across the whole year. */
  blendedAvgPrice:
    CELLS.reduce((acc, c) => acc + (c.price ?? 0) * c.volumeKg, 0) / GRAND_VOLUME,
  cheapestSupplier: [...SUPPLIER_SUMMARIES].sort((a, b) => a.avgPrice - b.avgPrice)[0],
  mostExpensiveSupplier: [...SUPPLIER_SUMMARIES].sort((a, b) => b.avgPrice - a.avgPrice)[0],
  biggestVolumeSupplier: [...SUPPLIER_SUMMARIES].sort((a, b) => b.totalVolumeKg - a.totalVolumeKg)[0],
  /** Supplier with the steepest YTD price rise — the one to watch. */
  steepestRiser: [...SUPPLIER_SUMMARIES].sort((a, b) => b.priceChangePct - a.priceChangePct)[0],
  /** Price range across the year (blended). */
  yearLowPrice: Math.min(...MONTHLY_TOTALS.filter((m) => m.volumeKg > 0).map((m) => m.avgPrice)),
  yearHighPrice: Math.max(...MONTHLY_TOTALS.map((m) => m.avgPrice)),
};

/**
 * Monthly DELIVERIES summary — the data behind demo-4's monthly table.
 * Per-month rollup that follows the RC IN (deliveries) column format: summed
 * sacks/weight/₱ + volume-weighted lab metrics. The lab values carry a seasonal
 * story — wetter, higher-moisture, lower-fixed-carbon charcoal in the Jun–Aug
 * rainy months (which also matches the mid-year volume dip).
 */
// [mc, grit, vm, ash, fc, bd_astm, bd_jis] per month (index aligns with MONTHS)
const MONTHLY_LAB: [number, number, number, number, number, number, number][] = [
  [8.1, 0.05, 9.2, 4.0, 78.6, 0.482, 0.496], // Jan
  [8.0, 0.04, 9.0, 3.9, 78.9, 0.485, 0.498], // Feb
  [8.3, 0.06, 9.3, 4.1, 78.2, 0.479, 0.494], // Mar
  [8.5, 0.05, 9.1, 4.2, 78.0, 0.478, 0.492], // Apr
  [8.8, 0.07, 9.4, 4.3, 77.5, 0.475, 0.489], // May
  [9.4, 0.08, 9.6, 4.5, 76.9, 0.470, 0.484], // Jun (rainy)
  [9.7, 0.09, 9.7, 4.6, 76.4, 0.468, 0.481], // Jul (rainy)
  [9.5, 0.08, 9.5, 4.4, 76.8, 0.471, 0.485], // Aug (rainy)
  [8.9, 0.06, 9.3, 4.2, 77.8, 0.476, 0.490], // Sep
  [8.4, 0.05, 9.1, 4.0, 78.4, 0.481, 0.495], // Oct
  [8.2, 0.04, 9.0, 3.9, 78.7, 0.484, 0.497], // Nov
  [8.0, 0.05, 9.1, 3.9, 78.8, 0.485, 0.498], // Dec
];

const AVG_KG_PER_SACK = 33;

export interface MonthlyDeliverySummary {
  monthKey: string;
  label: string;
  full: string;
  monthIndex: number;
  deliveries: number;
  sacks: number;
  weightKg: number;
  mc: number;
  grit: number;
  vm: number;
  ash: number;
  fc: number;
  bdAstm: number;
  bdJis: number;
  /** Volume-weighted ₱/kg for the month (from MONTHLY_TOTALS). */
  phpPerKg: number;
  /** weightKg × phpPerKg. */
  phpTotal: number;
}

export const MONTHLY_DELIVERY_SUMMARY: MonthlyDeliverySummary[] = MONTHS.map((m, i) => {
  const t = MONTHLY_TOTALS[i];
  const [mc, grit, vm, ash, fc, bdAstm, bdJis] = MONTHLY_LAB[i];
  return {
    monthKey: m.key,
    label: m.label,
    full: m.full,
    monthIndex: i,
    deliveries: t.deliveries,
    sacks: Math.round(t.volumeKg / AVG_KG_PER_SACK),
    weightKg: t.volumeKg,
    mc,
    grit,
    vm,
    ash,
    fc,
    bdAstm,
    bdJis,
    phpPerKg: t.avgPrice,
    phpTotal: t.volumeKg * t.avgPrice,
  };
});

/** Footer row for the monthly table: sums for totals, volume-weighted for averages. */
export const MONTHLY_DELIVERY_TOTALS = (() => {
  const rows = MONTHLY_DELIVERY_SUMMARY;
  const weightKg = rows.reduce((a, r) => a + r.weightKg, 0);
  const wavg = (sel: (r: MonthlyDeliverySummary) => number) =>
    weightKg > 0 ? rows.reduce((a, r) => a + sel(r) * r.weightKg, 0) / weightKg : 0;
  return {
    deliveries: rows.reduce((a, r) => a + r.deliveries, 0),
    sacks: rows.reduce((a, r) => a + r.sacks, 0),
    weightKg,
    phpTotal: rows.reduce((a, r) => a + r.phpTotal, 0),
    mc: wavg((r) => r.mc),
    grit: wavg((r) => r.grit),
    vm: wavg((r) => r.vm),
    ash: wavg((r) => r.ash),
    fc: wavg((r) => r.fc),
    bdAstm: wavg((r) => r.bdAstm),
    bdJis: wavg((r) => r.bdJis),
    phpPerKg: wavg((r) => r.phpPerKg),
  };
})();

/* ──────────────────────────────────────────────────────────────────────────
 * MULTI-YEAR data — for demo-4's year picker + multi-year graph comparison.
 * 2026 is the canonical base (matches MONTHLY_DELIVERY_SUMMARY exactly). Earlier
 * years are derived deterministically: charcoal prices inflate ~7–9%/yr, so older
 * years are cheaper, with their own seasonal wobble (a per-year phase seed) so the
 * year-over-year curves differ in shape, not just a flat vertical shift.
 * ────────────────────────────────────────────────────────────────────────── */

export const YEARS = [2023, 2024, 2025, 2026] as const;

/** One distinct hue per year. Within a year the area (volume) + line (price)
 *  share this color; different years differ — that's how the graph reads. */
export const YEAR_COLORS: Record<number, string> = {
  2026: '#0d9488', // teal  (house accent / latest)
  2025: '#d97706', // amber
  2024: '#7c3aed', // violet
  2023: '#2563eb', // blue
};

interface YearShape {
  priceOffset: number;  // ₱/kg added to the 2026 base (earlier years cheaper)
  volumeFactor: number; // multiplier on 2026 base volume
  seed: number;         // seasonal phase shift so each year's curve differs
  mcOffset: number;     // small lab drift
  bdOffset: number;
}
const YEAR_SHAPE: Record<number, YearShape> = {
  2026: { priceOffset: 0, volumeFactor: 1.0, seed: 0, mcOffset: 0, bdOffset: 0 },
  2025: { priceOffset: -3.2, volumeFactor: 0.93, seed: 4, mcOffset: -0.2, bdOffset: 0.004 },
  2024: { priceOffset: -6.0, volumeFactor: 0.86, seed: 2, mcOffset: 0.1, bdOffset: 0.008 },
  2023: { priceOffset: -8.5, volumeFactor: 0.79, seed: 1, mcOffset: 0.3, bdOffset: 0.012 },
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function buildYear(year: number): MonthlyDeliverySummary[] {
  const shape = YEAR_SHAPE[year];
  return MONTHLY_DELIVERY_SUMMARY.map((base, i) => {
    if (year === 2026) return { ...base }; // identity — the canonical year
    const vWobble = 1 + 0.08 * Math.sin((i + shape.seed) * 0.9);
    const pWobble = 0.5 * Math.sin((i + shape.seed) * 0.7);
    const weightKg = Math.max(0, Math.round(base.weightKg * shape.volumeFactor * vWobble));
    const phpPerKg = r2(base.phpPerKg + shape.priceOffset + pWobble);
    return {
      monthKey: `${year}-${String(i + 1).padStart(2, '0')}`,
      label: base.label,
      full: base.full,
      monthIndex: i,
      deliveries: Math.round(weightKg / 18000),
      sacks: Math.round(weightKg / AVG_KG_PER_SACK),
      weightKg,
      mc: r2(base.mc + shape.mcOffset),
      grit: base.grit,
      vm: base.vm,
      ash: r2(base.ash + shape.mcOffset * 0.3),
      fc: r2(base.fc - shape.mcOffset * 0.5),
      bdAstm: r3(base.bdAstm + shape.bdOffset),
      bdJis: r3(base.bdJis + shape.bdOffset),
      phpPerKg,
      phpTotal: weightKg * phpPerKg,
    };
  });
}

/** Per-year monthly deliveries summary (12 rows each). Use MONTHLY_BY_YEAR[year]. */
export const MONTHLY_BY_YEAR: Record<number, MonthlyDeliverySummary[]> = {
  2023: buildYear(2023),
  2024: buildYear(2024),
  2025: buildYear(2025),
  2026: buildYear(2026),
};

function totalsFor(rows: MonthlyDeliverySummary[]) {
  const weightKg = rows.reduce((a, r) => a + r.weightKg, 0);
  const wavg = (sel: (r: MonthlyDeliverySummary) => number) =>
    weightKg > 0 ? rows.reduce((a, r) => a + sel(r) * r.weightKg, 0) / weightKg : 0;
  return {
    deliveries: rows.reduce((a, r) => a + r.deliveries, 0),
    sacks: rows.reduce((a, r) => a + r.sacks, 0),
    weightKg,
    phpTotal: rows.reduce((a, r) => a + r.phpTotal, 0),
    mc: wavg((r) => r.mc),
    grit: wavg((r) => r.grit),
    vm: wavg((r) => r.vm),
    ash: wavg((r) => r.ash),
    fc: wavg((r) => r.fc),
    bdAstm: wavg((r) => r.bdAstm),
    bdJis: wavg((r) => r.bdJis),
    phpPerKg: wavg((r) => r.phpPerKg),
  };
}

/** Per-year footer rollup for the monthly table. Use TOTALS_BY_YEAR[year]. */
export const TOTALS_BY_YEAR: Record<number, ReturnType<typeof totalsFor>> = {
  2023: totalsFor(MONTHLY_BY_YEAR[2023]),
  2024: totalsFor(MONTHLY_BY_YEAR[2024]),
  2025: totalsFor(MONTHLY_BY_YEAR[2025]),
  2026: totalsFor(MONTHLY_BY_YEAR[2026]),
};

/** Formatting helpers shared by the demos. */
export const fmt = {
  php: (n: number | null | undefined, dp = 2) =>
    n == null ? '—' : `₱${n.toLocaleString('en-PH', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`,
  kg: (n: number) => `${Math.round(n).toLocaleString('en-PH')} kg`,
  tonnes: (n: number, dp = 1) => `${(n / 1000).toLocaleString('en-PH', { minimumFractionDigits: dp, maximumFractionDigits: dp })} t`,
  pct: (n: number, dp = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`,
};
