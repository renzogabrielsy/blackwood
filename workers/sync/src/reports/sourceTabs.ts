/**
 * sourceTabs.ts — THE one way "we opened the workbook and could not read its tabs"
 * becomes an operator-facing note (2026-09-03, L-048).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY AN EMPTY READ OF A NON-EMPTY FILE IS A HIGH FINDING
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-09-03 run `cc8c66f9` opened MC's `260902 PROPOSED DAILY REPORT SEPTEMBER
 * 2026.xlsx`, whose day tabs are named `Aug. 29`, `Sep. 1`, `SEP. 2`. The tab-name regex
 * required a bare space between month and day, so all three were skipped, `extractProposed`
 * returned ZERO rows, classify saw 0/0/0, apply wrote nothing — and the run then LABELED
 * the email processed, ADVANCED the watermark and reported `succeeded` with **no finding at
 * all**. The three skips existed only as strings in `soft_warnings`, which is not on the
 * findings path. `rc_out` stopped at 2026-08-28 while every other stream was at Sept 1-2;
 * the Blocking cross-check duly flagged 79,165 kg across 4 blocks and `stale_stream` said
 * RC Out had missed 2 working days — three symptoms, and nothing naming the cause.
 *
 * The lesson is the one L-039 and L-042 already taught from the other end: a file the sync
 * COULD open and got NOTHING out of is not a quiet day. "Zero rows" is a legitimate answer
 * only from a file with zero day tabs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO RULES, AND THE SECOND ONE IS THE IMPORTANT ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **Loud.** `high` when NOT ONE tab could be read (the whole file is unreadable and
 *    nothing was written from it); `attention` when some parsed and some did not (the run
 *    did real work, but part of the source went unseen). The note NAMES both lists — the
 *    tabs it could not read AND the tabs it could — for the same reason L-039's price-tab
 *    finding names the tab it looked for and the tabs the file has: the two lists side by
 *    side are what let a person see the naming convention that moved.
 * 2. **Unconsumed.** When 0 of N parsed, the email is NOT labeled `Blackwood-Processed`
 *    and the ingestion watermark is NOT advanced — so the next run, after a fix, can read
 *    the very same email again. A run that consumed a source it could not read has thrown
 *    the source away; that is the half of this incident that would have survived the fix.
 *    Mirrors how a write error suppresses labeling in every apply.ts today.
 *
 * NOTHING IS HELD. No durable case, so there is nothing to close by hand — the moment the
 * tabs parse, the finding stops firing on its own. Same posture as `reportNotReceived.ts`.
 *
 * NO ₱ ANYWHERE. The note carries sheet names, counts and a filename; the run-findings
 * channel is not price-gated, and this channel structurally has nothing to leak.
 */

/** One source workbook whose worksheet names could not all be read. Mirrors
 *  `app/(app)/sync/types.ts::SourceTabNote`. */
export interface SourceTabNote {
  /** Always `source_tabs_unreadable` today. A field, not a literal, so a second flavour
   *  of "the file is there but unreadable" can join without a second channel. */
  kind: "source_tabs_unreadable";
  /** The `sync_runs.result.reports` key this workbook feeds, e.g. "rc_out". */
  report_type: string;
  /** Plain-English name of the document ("PROPOSED DAILY REPORT"). */
  source_label: string;
  /** The attachment's filename — the one fact that says WHICH workbook this was. */
  filename: string | null;
  /** Worksheets in the file. */
  tabs_total: number;
  /** Worksheets whose name resolved to a date (the ones actually read). */
  tabs_read: number;
  /** The names it could NOT read. Truncated at 25 — a finding is read, not scrolled. */
  unreadable_tabs: string[];
  /** The names it COULD read. Truncated at 25. Empty is itself the alarm. */
  readable_tabs: string[];
  /** Rows the extractor produced from the whole workbook (0 in the total-failure case). */
  rows_extracted: number;
  /** True when this run deliberately left the email unlabeled + the watermark unmoved. */
  source_left_unconsumed: boolean;
}

/** How many tab names a note carries per side. Beyond this the counts tell the story. */
const MAX_NAMES = 25;

function capped(names: readonly string[]): string[] {
  return names.slice(0, MAX_NAMES).map((n) => String(n));
}

/**
 * The ONE constructor. Returns `null` when there is nothing to report — a workbook with
 * no sheets at all (there is no evidence a tab was missed), or one whose every sheet
 * parsed. Build a note any other way and `tabs_read`/`readable_tabs` can disagree.
 */
export function sourceTabsNote(args: {
  reportType: string;
  sourceLabel: string;
  filename?: string | null;
  /** Sheet names whose name resolved to a date. */
  parsed: readonly string[];
  /** Sheet names that did not. */
  unparsed: readonly string[];
  rowsExtracted: number;
}): SourceTabNote | null {
  const total = args.parsed.length + args.unparsed.length;
  if (total === 0 || args.unparsed.length === 0) return null;
  return {
    kind: "source_tabs_unreadable",
    report_type: args.reportType,
    source_label: args.sourceLabel,
    filename: args.filename ?? null,
    tabs_total: total,
    tabs_read: args.parsed.length,
    unreadable_tabs: capped(args.unparsed),
    readable_tabs: capped(args.parsed),
    rows_extracted: args.rowsExtracted,
    // Rule 2: the source is thrown away only when SOMETHING was read from it.
    source_left_unconsumed: args.parsed.length === 0,
  };
}

/** True when this note means "not one tab was readable" — the case that must not consume
 *  the email. ONE predicate, so the orchestrator and the finding builder agree. */
export function isTotalTabFailure(note: SourceTabNote): boolean {
  return note.tabs_read === 0;
}
