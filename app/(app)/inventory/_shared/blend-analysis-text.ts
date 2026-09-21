// ─────────────────────────────────────────────────────────────────────────────
// THE WORDS AND THE FORMATS THE ANALYSIS PAGES USE — pure, and shared by BOTH
// surfaces.
//
// The screen renders React and the printout builds an HTML string in a hidden
// iframe, so they cannot share a component. They must still say the SAME sentence
// about the same payload: a method note that reads one way on screen and another on
// paper is two explanations of one statistic, and the reader has no way to tell which
// is right. Everything either surface needs in words or in digits therefore lives
// here, once.
//
// ── IT FORMATS AND IT LABELS. IT DOES NOT COMPUTE. ──────────────────────────
// Every kilogram, share, weighted average, cut line and `gvf` comes out of SQL
// through `fetchBlendAnalysis` and is rendered verbatim. `Math.round` for display and
// `toFixed` are the whole of the arithmetic below — there is no sum, no division by a
// total and no average anywhere, and `scripts/verify-blend-analysis-ui.ts` asserts
// the absence statically.
//
// ── THE GROUP WORDS ARE THE UI's, THE LABELS ARE THE PAYLOAD's ──────────────
// The contract's vocabulary is the CLOSED `low | mid | high`. On screen the middle
// group is called AVERAGE, because that is the word the owner used ("high priced and
// low priced and average priced"). A two-group blend has no middle, and a one-group
// blend is not "average" — it is one group, and it says so.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  BlendAnalysisUnmeasured,
  BlendNaturalCut,
  BlendNaturalGroupLabel,
  BlendQualityMetric,
  BlendVsMarket,
  BlendVsMarketUnavailable,
} from '../blocking/types';

export const PESO = '₱';
export const EMDASH = '—';

/** `1,275,018` — kilograms, rounded for DISPLAY only. */
export function fmtKg(n: number): string {
  return Math.round(n).toLocaleString();
}

/** `43.5575` → `43.56`. The plain number; the ₱ is placed by the caller (accounting). */
export function fmtPesoNum(n: number, decimals = 2): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** `₱43.56`, for prose rather than a column. */
export function fmtPeso(n: number, decimals = 2): string {
  return `${PESO}${fmtPesoNum(n, decimals)}`;
}

/** `₱40` — a whole-peso cut line. */
export function fmtWholePeso(n: number): string {
  return `${PESO}${Math.round(n).toLocaleString()}`;
}

/** `28.99%`, or an em dash when the server said NULL (nothing measured to share out). */
export function fmtSharePct(v: number | null): string {
  return v === null ? EMDASH : `${v.toFixed(1)}%`;
}

/** `344.8` days at one decimal — the Age lens's own precision. Null is never `0.0`. */
export function fmtDays(v: number | null, decimals = 1): string {
  return v === null
    ? EMDASH
    : v.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
}

/** `345 days` / `1 day` — whole days, for a headline with no room for a decimal. */
export function fmtWholeDays(v: number | null): string {
  if (v === null) return EMDASH;
  const r = Math.round(v);
  return `${r.toLocaleString()} day${r === 1 ? '' : 's'}`;
}

/** BD → 3 decimals, MC and ASH → 2. THE Excel-Standard precision, not a new one. */
export function qualityDecimals(metric: BlendQualityMetric): number {
  return metric === 'bd_astm' || metric === 'bd_jis' ? 3 : 2;
}

export function fmtQuality(metric: BlendQualityMetric, v: number | null): string {
  return v === null ? EMDASH : v.toFixed(qualityDecimals(metric));
}

export const QUALITY_METRIC_LABELS: Record<BlendQualityMetric, string> = {
  mc: 'MC',
  ash: 'ASH',
  bd_astm: 'BD ASTM',
  bd_jis: 'BD JIS',
};

/** The unit a reading is in, said once per table rather than on every row. */
export const QUALITY_METRIC_UNITS: Record<BlendQualityMetric, string> = {
  mc: '% moisture',
  ash: '% ash',
  bd_astm: 'g/cc (ASTM)',
  bd_jis: 'g/cc (JIS)',
};

/**
 * What a natural-breaks group is CALLED on the page.
 *
 * `high` is always the larger number — on BD that is the DENSER charcoal, and whether
 * that reads as better is the reader's judgement, not a word this function should put
 * in their mouth.
 */
export function groupWord(label: BlendNaturalGroupLabel, groupCount: number): string {
  if (groupCount <= 1) return 'ALL ONE GROUP';
  if (label === 'high') return 'HIGH';
  if (label === 'low') return 'LOW';
  return groupCount >= 3 ? 'AVERAGE' : 'MIDDLE';
}

/**
 * The one-line METHOD NOTE, in plain language, built from the payload's own cuts and
 * its `gvf`.
 *
 * *"Grouped where the prices naturally separate: cut lines at ₱38.97 and ₱44.50
 * minimise the spread inside each group. Fit 97.6%."*
 *
 * The degenerate cases are said honestly rather than dressed up: a blend whose blocks
 * all cost the same has ONE group and no cut line, and claiming a fit of 0% for it
 * would be a lie (the payload's `gvf` is NULL there — there is no variance to
 * explain).
 *
 * ⚠️ `cut.value` is the MIDPOINT of the gap and is a LABEL. The membership test is
 * `cut.above`, and neither surface may re-derive a group from the midpoint.
 */
export function naturalMethodNote(args: {
  /** What is being grouped, in the reader's words: `prices`, `MC readings`. */
  subject: string;
  groupCount: number;
  cuts: readonly BlendNaturalCut[];
  gvf: number | null;
  /** How to print one cut line — pesos for price, a reading for a lab stat. */
  formatCut: (v: number) => string;
}): string {
  const { subject, groupCount, cuts, gvf } = args;
  const fit = gvf === null ? null : `Fit ${(gvf * 100).toFixed(1)}%.`;

  if (groupCount <= 1) {
    return [
      `All one group: every measured block reads the same ${subject.replace(/s$/, '')}, so there is nothing to separate.`,
      fit,
    ]
      .filter(Boolean)
      .join(' ');
  }

  const lines = cuts.map((c) => args.formatCut(c.value));
  const cutText =
    lines.length === 0
      ? ''
      : lines.length === 1
        ? `cut line at ${lines[0]}`
        : `cut lines at ${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;

  const groupsWord = groupCount === 2 ? 'two groups' : `${groupCount} groups`;
  return [
    `Grouped where the ${subject} naturally separate into ${groupsWord}: ${cutText} minimise the spread inside each group.`,
    fit,
  ]
    .filter(Boolean)
    .join(' ');
}

/** `September 2026` from a `yyyy-MM-01`. Falls back to the raw string if unparseable. */
export function monthName(month: string | null): string | null {
  if (!month) return null;
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) return month;
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${m[1]}` : month;
}

/**
 * *"Market ₱39.83 (September 2026 deliveries) rounds up to ₱40"* — or, for a price the
 * operator typed, *"Market ₱41 (typed) — ₱41 and up is above market"*.
 *
 * TWO SENTENCES BECAUSE THERE ARE TWO RULES, exactly as the price lens says them: a
 * MEASURED market rounds up to the next whole peso in SQL, while a price a human
 * TYPED **is** the cut line. Saying "rounds up to ₱42" about a typed ₱41 would
 * describe a lens one peso looser than the one they asked for.
 */
export function vsMarketCaption(v: BlendVsMarket): string {
  if (v.marketBasis === 'given') {
    return `Market ${fmtPeso(v.marketPhpKg)} (typed) ${EMDASH} ${fmtWholePeso(
      v.roundedUpPhp,
    )} and up is above market.`;
  }
  const month = monthName(v.marketBasisMonth);
  const where = month ? ` (${month} deliveries)` : '';
  return `Market ${fmtPeso(v.marketPhpKg)}${where} rounds up to ${fmtWholePeso(v.roundedUpPhp)}.`;
}

/** Why there is no market comparison — the payload's own reason, never a ₱0. */
export function vsMarketUnavailableNote(u: BlendVsMarketUnavailable): string {
  const month = monthName(u.marketBasisMonth);
  const where =
    u.marketBasis === 'as_of_month' && month ? ` for ${month}` : '';
  return `${u.message} No market price could be measured${where}, and a market of ${PESO}0 would put every block above market — so nothing is assumed here. Set a market price on the Price lens to compare.`;
}

/** `7 blocks` / `1 block`. */
export function blocksWord(n: number): string {
  return `${n.toLocaleString()} block${n === 1 ? '' : 's'}`;
}

/**
 * The muted line under a table for the blocks that have NO reading.
 *
 * A metric value that is NULL **or ≤ 0** is the not-recorded placeholder, never a
 * measurement: `view_blocking_grid` COALESCEs ash and both BDs to 0, and charcoal with
 * 0.000% ash does not exist. Such a block is in NO group and out of every average —
 * calling it the cleanest block in the blend is the ₱11.01-vs-₱39.99 `avg_cost` bug in
 * a new costume.
 */
export function unmeasuredNote(u: BlendAnalysisUnmeasured, subject: string): string {
  const parts = [`${blocksWord(u.blockCount)}, ${fmtKg(u.kg)} kg, with no ${subject}`];
  if (u.noWeightCount > 0) {
    parts.push(
      `${u.noWeightCount} of them ${u.noWeightCount === 1 ? 'has' : 'have'} a reading but nothing in the pile to weight it with`,
    );
  }
  return `${parts.join(' · ')}. In no group and out of every average and both percentages.`;
}

/**
 * The FOOTER reconciliation sentence, when the honest figure and the blend's own
 * stored figure disagree.
 *
 * They are equal (gap exactly 0) whenever nothing is unmeasured. When something IS,
 * the SNAPSHOT's figure is the one dragged down by a placeholder zero — so the page
 * prints both numbers and says which population each one covers, rather than picking a
 * winner.
 */
export function snapshotGapNote(args: {
  /** The blend's own stored weighted figure, formatted. */
  snapshot: string;
  /** The figure over the MEASURED blocks, formatted. */
  measured: string;
  /** `blocks with no reading` / `unpriced blocks`. */
  excluded: string;
}): string {
  return `The blend's own weighted average is ${args.snapshot}; leaving out the ${args.excluded} gives ${args.measured}. Both are shown because the difference IS those blocks.`;
}
