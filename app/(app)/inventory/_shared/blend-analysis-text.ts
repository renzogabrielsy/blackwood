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
//
// ── EVERY CAPTION IS A LIST OF FACTS, NOT A SENTENCE (2026-09-22) ───────────
// The owner, on the live pages: *"I don't want descriptions like this, straight to the
// point, not wordy. Apply to all sections, not just price."* So a caption is now
// `<fact> · <fact> · <fact>` and nothing else — `Cut lines ₱38.97 · ₱44.50 · fit 97.6%`,
// not a paragraph explaining what a natural break is. Three consequences, each of which
// `scripts/verify-blend-analysis-ui.ts` asserts:
//
//   • NO EXPLANATION OF THE METHOD. The cut lines and the fit ARE the method; a reader
//     who wants the reasoning has CONTEXT.md, and a reader looking at a table wants the
//     numbers. The banned words are checked by name — `naturally`, `minimise`,
//     `dearest`, `spread` — as is the arrow `→`.
//   • NO ORDERING PROSE. "Dearest band first" / "Oldest band first" described what the
//     rows already show; the first row of a table is not a fact that needs a sentence.
//   • A NOTE THAT IS ABSENT WHEN IT HAS NOTHING TO SAY. The no-reading line is emitted
//     only when the count is non-zero, and the snapshot-gap line only when the two
//     figures actually disagree — the same NULL-≠-0 discipline the payload carries.
//
// ── "MARKET" IS A MEASUREMENT. A TYPED PRICE IS NOT (2026-09-22) ────────────
// `vsMarketHeading` / `priceBasisNoun` are the ONE definition of what that section is
// called, and the word **market must not appear anywhere for a price the operator typed**
// — on the analysis pages, on the lens legend, in the lens's settings or on either
// printout. A figure somebody typed in is a SET PRICE; calling it market would claim a
// measurement nobody made. Both surfaces and the lens read these two functions, so the
// label cannot be spelled two ways.
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
 * The METHOD LINE — the cut lines and the fit, and nothing else.
 *
 * `Cut lines ₱38.97 · ₱44.50 · fit 97.6%` · `Cut line 11.23 · fit 89.6%` · `One group`.
 *
 * The degenerate cases are said honestly rather than dressed up: a blend whose blocks
 * all read the same has ONE group and no cut line, and the payload's `gvf` is NULL
 * there — there is no variance to explain — so the line is the two words `One group`
 * and claims no fit.
 *
 * ⚠️ `cut.value` is the MIDPOINT of the gap and is a LABEL. The membership test is
 * `cut.above`, and neither surface may re-derive a group from the midpoint.
 */
export function naturalMethodNote(args: {
  groupCount: number;
  cuts: readonly BlendNaturalCut[];
  gvf: number | null;
  /** How to print one cut line — pesos for price, a reading for a lab stat. */
  formatCut: (v: number) => string;
}): string {
  const { groupCount, cuts, gvf } = args;
  const fit = gvf === null ? null : `fit ${(gvf * 100).toFixed(1)}%`;
  const lines = cuts.map((c) => args.formatCut(c.value));

  if (groupCount <= 1 || lines.length === 0) {
    return ['One group', fit].filter(Boolean).join(' · ');
  }
  const head = lines.length === 1 ? 'Cut line' : 'Cut lines';
  return [`${head} ${lines.join(' · ')}`, fit].filter(Boolean).join(' · ');
}

/** `September 2026` from a `yyyy-MM-01`. Falls back to the raw string if unparseable. */
export function monthName(month: string | null): string | null {
  return monthLabel(month, false);
}

/** `Sep 2026` — the short form a caption uses, because a caption is a list of facts. */
export function monthAbbr(month: string | null): string | null {
  return monthLabel(month, true);
}

function monthLabel(month: string | null, abbr: boolean): string | null {
  if (!month) return null;
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) return month;
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return month;
  const name = names[idx];
  return `${abbr ? name.slice(0, 3) : name} ${m[1]}`;
}

/**
 * The NOUN for whatever the blocks are being compared against — THE one definition.
 *
 * A figure the operator TYPED is a **set price**, never "market": market is something
 * measured from deliveries, and calling a typed number by its name would claim a
 * measurement nobody made. Every surface that labels this comparison — the analysis
 * pages, their two printouts, the lens legend, the lens's settings and the lens
 * printout — reads this function or `vsMarketHeading` below, so the two words cannot
 * drift apart.
 */
export function priceBasisNoun(typed: boolean): string {
  return typed ? 'set price' : 'market';
}

/** `Against set price` / `Against market` — the section heading, one definition. */
export function vsMarketHeading(typed: boolean): string {
  return typed ? 'Against set price' : 'Against market';
}

/**
 * `Market ₱39.83 (Sep 2026) · ₱40 and up is above` — or, for a typed figure,
 * `Set price ₱45 · ₱45 and up is above`.
 *
 * TWO FORMS BECAUSE THERE ARE TWO RULES, exactly as the price lens states them: a
 * MEASURED market rounds up to the next whole peso in SQL, while a price a human
 * TYPED **is** the cut line — so a typed ₱45 reads back as ₱45 and never as ₱46. The
 * word *market* is absent from the typed form on purpose; see `priceBasisNoun`.
 */
export function vsMarketCaption(v: BlendVsMarket): string {
  if (v.marketBasis === 'given') {
    return `Set price ${fmtPeso(v.marketPhpKg)} · ${fmtWholePeso(v.roundedUpPhp)} and up is above`;
  }
  const month = monthAbbr(v.marketBasisMonth);
  const where = month ? ` (${month})` : '';
  return `Market ${fmtPeso(v.marketPhpKg)}${where} · ${fmtWholePeso(
    v.roundedUpPhp,
  )} and up is above`;
}

/** Why there is no comparison — the payload's own reason, never a ₱0. */
export function vsMarketUnavailableNote(u: BlendVsMarketUnavailable): string {
  const month = monthAbbr(u.marketBasisMonth);
  const where = u.marketBasis === 'as_of_month' && month ? ` for ${month}` : '';
  // A ₱0 market would put every block above it, so nothing is assumed — said as two
  // facts rather than a paragraph.
  return `No market price${where} · set one on the Price lens`;
}

/** `7 blocks` / `1 block`. */
export function blocksWord(n: number): string {
  return `${n.toLocaleString()} block${n === 1 ? '' : 's'}`;
}

/**
 * The muted line for the blocks that have NO reading — `No reading: 2 blocks`.
 *
 * A metric value that is NULL **or ≤ 0** is the not-recorded placeholder, never a
 * measurement: `view_blocking_grid` COALESCEs ash and both BDs to 0, and charcoal with
 * 0.000% ash does not exist. Such a block is in NO group and out of every average —
 * calling it the cleanest block in the blend is the ₱11.01-vs-₱39.99 `avg_cost` bug in
 * a new costume, which is why it is listed at all.
 *
 * It returns the EMPTY STRING when the count is zero, so every caller can emit it
 * unconditionally and a page never carries a line saying nothing is missing.
 */
export function unmeasuredNote(u: BlendAnalysisUnmeasured, label: string): string {
  if (u.blockCount <= 0) return '';
  const parts = [`${label}: ${blocksWord(u.blockCount)}`];
  // A reading with nothing in the pile to weight it with is a second, different gap —
  // one token, not a clause.
  if (u.noWeightCount > 0) parts.push(`${u.noWeightCount} unweighted`);
  return parts.join(' · ');
}

/**
 * The footer line when the honest figure and the blend's own stored figure disagree —
 * `Blend avg 2.13 · excl. no-reading 3.13`.
 *
 * They are equal (gap exactly 0) whenever nothing is unmeasured. When something IS, the
 * SNAPSHOT's figure is the one dragged down by a placeholder zero — so BOTH numbers are
 * printed, labelled by the population each covers, rather than one of them being picked
 * as the winner.
 */
export function snapshotGapNote(args: {
  /** The blend's own stored weighted figure, formatted. */
  snapshot: string;
  /** The figure over the MEASURED blocks, formatted. */
  measured: string;
  /** What was left out: `no-reading` / `unpriced`. */
  excluded: string;
}): string {
  return `Blend avg ${args.snapshot} · excl. ${args.excluded} ${args.measured}`;
}

/**
 * The AGE page's method line — `As of 2026-09-21 · cuts 60 · 120 · 365 d`, plus the
 * oldest pile when the payload names one.
 *
 * The cut days are the BANDS' OWN published lower bounds, read off the payload; nothing
 * here decides where a band starts. The oldest pile rides as one more `·` token because
 * it is a bare fact and the page has no other place to say it.
 */
export function ageMethodNote(args: {
  asOf: string;
  /** The bands' lower bounds above zero, ascending — the cut lines, as published. */
  cutDays: readonly number[];
  oldestDays: number | null;
  oldestBlockLoc: string | null;
}): string {
  const parts = [`As of ${args.asOf}`];
  if (args.cutDays.length > 0) {
    parts.push(`cuts ${args.cutDays.map((d) => d.toLocaleString()).join(' · ')} d`);
  }
  if (args.oldestDays !== null) {
    parts.push(
      `oldest ${fmtDays(args.oldestDays)} d${args.oldestBlockLoc ? ` ${args.oldestBlockLoc}` : ''}`,
    );
  }
  return parts.join(' · ');
}

/** `No delivery dates: 2 blocks` — the age page's own twin of `unmeasuredNote`. */
export function undatedNote(blockCount: number): string {
  if (blockCount <= 0) return '';
  return `No delivery dates: ${blocksWord(blockCount)}`;
}
