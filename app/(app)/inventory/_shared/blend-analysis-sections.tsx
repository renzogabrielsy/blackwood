'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE ANALYSIS PAGES, ON SCREEN — price groups, quality, age.
//
// The owner: *"add more pages that group and arrange blocks according to high priced
// and low priced and average priced … Do another page that talks about mc, ash and bd
// as well. Maybe even age? … Make sure the groups are tables with footers that show
// totals or averages when appropriate."*
//
// Each page is a SECTION below the Selected Blocks table, in the dialog's own scroll,
// with a heading that reads as a page — and the print (`blend-analysis-print.ts`)
// renders the same payload as separate SHEETS. The two surfaces share every word and
// every format through `blend-analysis-text.ts`, so a note that reads one way on
// screen cannot read another on paper.
//
// ── NOTHING HERE COMPUTES A STATISTIC ───────────────────────────────────────
// Every kilogram, share, weighted average, cut line and `gvf` is read verbatim out of
// `fetchBlendAnalysis`. There is no `reduce`, no `+=`, no division by a total and no
// average in this file: a subtotal row is the payload's own group figures and a footer
// row is the payload's own `overall`, which is what makes the price footer visibly
// equal the proposal's raw blend price. `scripts/verify-blend-analysis-ui.ts` asserts
// the absence statically.
//
// ── NULL IS NEVER 0, AND AN UNMEASURED BLOCK IS NEVER IN A GROUP ────────────
// A ₱0 is the L-008 unpriced placeholder and a lab reading of 0 is a missing reading
// (`view_blocking_grid` COALESCEs ash and both BDs to 0 — 11 of the yard's 170
// occupied blocks read exactly 0 on all three). Those blocks arrive in `unmeasured` /
// `undated`, and they are listed in a MUTED "no reading" group with an em dash —
// never in the cheapest, the cleanest or the freshest group.
//
// ── THE GROUPS READ HIGH → LOW, ON EVERY TABLE ──────────────────────────────
// Price, quality, against-market and age all put the larger number first, because the
// owner's question is always "which of these is the dear / wet / old one". The payload
// publishes its groups ASCENDING, so every table reverses for display and nothing
// re-derives a group from a cut line's midpoint (`cut.above` is the membership test;
// `cut.value` is a legend).
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { Coins, FlaskConical, Hourglass, Layers, Loader2 } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { getLabHighlightText, type LabHighlightSpec, type LabMetric } from '@/types/table-settings';

import { rampClass, type LensRampId } from '../blocking/lens/lens-ramp';
import { RefusalBanner } from '../blocking/lens/lens-refusal-banner';
import type {
  BlendAgeBand,
  BlendAnalysis,
  BlendAnalysisBlockRef,
  BlendPriceBlock,
  BlendPriceNaturalGroup,
  BlendQualityGroup,
  BlendQualityMetric,
  BlendVsMarketBand,
} from '../blocking/types';
import { ageBandLabel } from '../blocking/lens/age-lens-settings';
import { priceBandLabel } from '../blocking/lens/price-lens-settings';
import {
  BLEND_ANALYSIS_PAGE_LABELS,
  BLEND_INCLUDE_PAGE_ORDER,
  analysisPages,
  analysisPagesLabel,
  type BlendAnalysisOptions,
  type BlendAnalysisPageId,
} from './blend-analysis-options';
import {
  ageMethodNote,
  blocksWord,
  EMDASH,
  fmtDays,
  fmtKg,
  fmtPesoNum,
  fmtQuality,
  fmtSharePct,
  groupWord,
  naturalMethodNote,
  QUALITY_METRIC_LABELS,
  QUALITY_METRIC_UNITS,
  qualityDecimals,
  snapshotGapNote,
  undatedNote,
  unmeasuredNote,
  vsMarketCaption,
  vsMarketHeading,
  vsMarketUnavailableNote,
  fmtPeso,
} from './blend-analysis-text';

// ═══ The Include-pages control ══════════════════════════════════════════════

export interface BlendAnalysisIncludePopoverProps {
  options: BlendAnalysisOptions;
  onChange: (next: BlendAnalysisOptions) => void;
  /** The grid's EFFECTIVE price flag. False → the Price checkbox is not rendered. */
  canViewPrices: boolean;
  /** How many pages are on right now — said on the trigger so it is never a mystery. */
  pageCount: number;
}

/**
 * "Include pages" — four checkboxes, persisted per user.
 *
 * The PRICE row is absent (not disabled) for a reader who may not see prices: there is
 * nothing for them to turn on, the payload they receive has `price: null`, and a
 * disabled checkbox offering money would be an invitation the server refuses.
 */
export function BlendAnalysisIncludePopover({
  options,
  onChange,
  canViewPrices,
  pageCount,
}: BlendAnalysisIncludePopoverProps) {
  const [open, setOpen] = React.useState(false);
  // FOUR rows since 2026-09-23 — the three analysis pages plus the YARD MAP, which is
  // deliberately NOT price-gated: it carries no ₱, so a price-denied reader still gets it
  // (in the single accent rather than coloured by price group).
  const rows = BLEND_INCLUDE_PAGE_ORDER.filter((id) => id !== 'price' || canViewPrices);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-blend-analysis-trigger
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-border
                     text-[11px] font-semibold text-muted-foreground
                     hover:text-foreground hover:bg-muted transition-all duration-150 cursor-pointer"
          title={`Choose which analysis pages this proposal shows and prints (${analysisPagesLabel(
            pageCount,
          )} on)`}
          aria-label="Analysis pages"
        >
          <Layers className="w-3.5 h-3.5" />
          {/* The WORD goes below `sm`, the icon and the count stay. On a 375px phone the
              header carries five actions beside a title that already truncates, and a
              label nobody can read is worth less than the title's last three letters. */}
          <span className="max-sm:hidden">Analysis</span>
          <span className="font-mono text-[10px] text-foreground">{pageCount}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-72 bg-popover/95 backdrop-blur-lg p-3">
        <div className="space-y-2">
          <div className="text-xs font-semibold text-foreground">Include pages</div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Extra pages under the blocks table, and extra sheets in the printout. The yard map
            is print only. Your choice is remembered.
          </p>
          <ul className="flex flex-col gap-1.5">
            {rows.map((id) => {
              const { label, blurb } = BLEND_ANALYSIS_PAGE_LABELS[id];
              return (
                <li key={id} className="flex items-start gap-2">
                  <Checkbox
                    id={`blend-analysis-${id}`}
                    checked={options[id]}
                    onCheckedChange={(v) => onChange({ ...options, [id]: v === true })}
                    className="mt-0.5"
                  />
                  <label htmlFor={`blend-analysis-${id}`} className="min-w-0 cursor-pointer">
                    <span className="block text-[11px] font-semibold text-foreground">{label}</span>
                    <span className="block text-[10px] leading-snug text-muted-foreground">
                      {blurb}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {!canViewPrices && (
            <p className="text-[10px] leading-snug text-muted-foreground">
              Prices are not shown for your role, so there is no price page.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ═══ Dense table primitives (the Excel Standard, shared by all four tables) ══

interface AnalysisCol {
  label: string;
  /** Explicit pixel width — `table-fixed`, and the SUM is the table's min-width. */
  w: number;
  num?: boolean;
  title?: string;
}

type Cell = React.ReactNode;

interface AnalysisRowModel {
  key: string;
  cells: Cell[];
  /** A muted row: the blocks with no reading. Never tinted, never in a group. */
  muted?: boolean;
}

interface AnalysisGroupModel {
  key: string;
  /** `HIGH` / `AVERAGE` / `Over 1 year` — the group's own word. */
  word: string;
  /** The range actually observed inside it, or the band's bounds. */
  range: string;
  /** For the tint: the group's own index and how many groups there are. */
  index: number;
  groupCount: number;
  ramp: LensRampId;
  /** The group that is NO group — the blocks with no reading. Never tinted, never a
   *  swatch: it is not a band, and painting it the ramp's first colour is exactly the
   *  "cheapest block in the blend" misreading this whole page refuses. */
  muted?: boolean;
  rows: AnalysisRowModel[];
  /** `HIGH subtotal · 12 blocks · 50.7% of kg` */
  subtotalLabel: string;
  /** One cell per column AFTER the two label columns. */
  subtotalCells: Cell[];
  /** Rendered instead of rows when the group is empty (a configured band with nothing in it). */
  emptyNote?: string;
}

const TH =
  'text-[9px] font-semibold text-muted-foreground uppercase tracking-wider px-1.5 py-1 border-b border-border whitespace-nowrap';
const TD = 'text-[10px] px-1.5 py-1 whitespace-nowrap';

/** ₱ pinned left, number pinned right — the accounting layout, in one place. */
function Accounting({ value, decimals = 2 }: { value: number | null; decimals?: number }) {
  if (value === null) return <span className="text-muted-foreground">{EMDASH}</span>;
  return (
    <span className="flex items-baseline justify-between gap-1 font-mono">
      <span className="font-normal text-muted-foreground">&#8369;</span>
      <span>{fmtPesoNum(value, decimals)}</span>
    </span>
  );
}

/**
 * ONE grouped table: a tinted group header, its block rows, its SUBTOTAL row, and one
 * grand FOOTER row at the end.
 *
 * The subtotal and footer rows are ordinary `<tbody>` rows. That is deliberate and it
 * is the printed sheet's rule carried onto the screen so the two cannot diverge:
 * Chrome REPEATS a `<tfoot>` on every printed page, so a total in one reads as a
 * duplicated total (`components/shared/print/print-page-rules.ts` says so outright).
 */
function AnalysisTable({
  cols,
  minWidth,
  groups,
  footerLabel,
  footerCells,
  caption,
  note,
}: {
  cols: AnalysisCol[];
  /**
   * NEVER CRUSH, ALWAYS SCROLL: the STATED sum of the column widths, passed in as a
   * constant beside each table's `cols` rather than folded here — this file adds
   * nothing up, not even pixels.
   */
  minWidth: number;
  groups: AnalysisGroupModel[];
  footerLabel: string;
  footerCells: Cell[];
  caption?: React.ReactNode;
  note?: React.ReactNode;
}) {
  const labelSpan = 2;

  return (
    <div className="space-y-1">
      {caption && <p className="text-[10px] leading-snug text-muted-foreground">{caption}</p>}
      <div className="rounded-md overflow-x-auto bg-muted border border-border">
        <table className="w-full table-fixed border-collapse" style={{ minWidth }}>
          <colgroup>
            {cols.map((c) => (
              <col key={c.label} style={{ width: c.w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c.label}
                  title={c.title}
                  className={cn(TH, c.num ? 'text-right' : 'text-left')}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.key}>
                {/* THE GROUP HEADER. A muted group — the blocks with no reading — takes
                    NO tint and NO swatch: it is not a band, and painting it the ramp's
                    first colour is exactly the "cheapest block in the blend" misreading
                    the whole page refuses. */}
                <tr
                  className={cn(
                    'border-t border-border',
                    g.muted
                      ? 'border-dashed bg-muted/40'
                      : rampClass(g.ramp, g.index, g.groupCount),
                  )}
                >
                  <td className={cn(TD, 'font-semibold')} colSpan={cols.length}>
                    <span className="inline-flex items-center gap-1.5">
                      {!g.muted && (
                        <span
                          aria-hidden
                          className={cn(
                            'h-2.5 w-2.5 shrink-0 rounded-sm border border-border/60',
                            rampClass(g.ramp, g.index, g.groupCount),
                            'lens-band-swatch',
                          )}
                        />
                      )}
                      <span
                        className={cn(
                          'text-[10px] font-bold uppercase tracking-wide',
                          g.muted ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      >
                        {g.word}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">{g.range}</span>
                    </span>
                  </td>
                </tr>
                {g.rows.length === 0 ? (
                  <tr>
                    <td className={cn(TD, 'italic text-muted-foreground')} colSpan={cols.length}>
                      {g.emptyNote ?? 'No blocks in this group.'}
                    </td>
                  </tr>
                ) : (
                  g.rows.map((r) => (
                    <tr
                      key={r.key}
                      className={cn(
                        'border-t border-border/50',
                        r.muted && 'text-muted-foreground',
                      )}
                    >
                      {r.cells.map((cell, i) => (
                        <td
                          key={cols[i].label}
                          className={cn(
                            TD,
                            cols[i].num ? 'text-right font-mono' : 'text-foreground',
                            r.muted && 'opacity-80',
                          )}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
                {/* The group's SUBTOTAL — a tbody row, never a tfoot. */}
                <tr className="border-t border-border bg-muted/60">
                  <td
                    className={cn(TD, 'text-[9px] font-semibold uppercase text-muted-foreground')}
                    colSpan={labelSpan}
                  >
                    {g.subtotalLabel}
                  </td>
                  {g.subtotalCells.map((cell, i) => (
                    <td
                      key={cols[labelSpan + i].label}
                      className={cn(
                        TD,
                        'font-mono font-semibold text-foreground',
                        cols[labelSpan + i].num && 'text-right',
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              </React.Fragment>
            ))}
            {/* The grand FOOTER — also a tbody row, for the same reason. */}
            <tr className="border-t-2 border-foreground/40 bg-muted">
              <td
                className={cn(TD, 'text-[9px] font-bold uppercase text-foreground')}
                colSpan={labelSpan}
              >
                {footerLabel}
              </td>
              {footerCells.map((cell, i) => (
                <td
                  key={cols[labelSpan + i].label}
                  className={cn(
                    TD,
                    'font-mono font-bold text-foreground',
                    cols[labelSpan + i].num && 'text-right',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {note && <p className="text-[10px] leading-snug text-muted-foreground">{note}</p>}
    </div>
  );
}

function PageHeading({
  icon: Icon,
  title,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  sub?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5 border-b border-border pb-1">
      <Icon className="w-3.5 h-3.5 text-primary shrink-0" />
      <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">{title}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

/** The muted row group for blocks the page cannot place. Never a band, never a zero. */
function unmeasuredGroup(
  blocks: readonly BlendAnalysisBlockRef[],
  colCount: number,
  ramp: LensRampId,
  label: string,
): AnalysisGroupModel | null {
  if (blocks.length === 0) return null;
  const tail = Array.from({ length: colCount - 3 }, () => EMDASH as Cell);
  return {
    key: 'unmeasured',
    word: label,
    range: '',
    // NOT A BAND, so NOT TINTED and with NO SWATCH — the header row renders dashed and
    // grey instead. Painting it the ramp's first colour would say "these are the
    // cheapest / cleanest / freshest blocks", which is the exact misreading this whole
    // page exists to refuse.
    muted: true,
    // `index` and `ramp` are never read while `muted` is true; they are here because the
    // model is one shape.
    index: 0,
    groupCount: 1,
    ramp,
    rows: blocks.map((b) => ({
      key: b.blockLoc,
      muted: true,
      cells: [b.blockLoc, b.batchCode, `${fmtKg(b.kg)} kg`, ...tail],
    })),
    subtotalLabel: label,
    subtotalCells: Array.from({ length: colCount - 2 }, () => EMDASH as Cell),
  };
}

// ═══ PAGE 1 — PRICE ════════════════════════════════════════════════════════

const PRICE_COLS: AnalysisCol[] = [
  { label: 'Block', w: 72 },
  { label: 'Batch', w: 132 },
  { label: 'Balance (kg)', w: 92, num: true },
  { label: 'PHP/KG', w: 88, num: true },
  { label: 'Value ₱', w: 108, num: true, title: 'That block’s kilograms at its own ₱/kg' },
];
/** 72 + 132 + 92 + 88 + 108 — stated, not folded. */
const PRICE_MIN_W = 492;

/**
 * ONE ROW's money — `kg × ₱/kg`, the only arithmetic anywhere in the analysis UI.
 *
 * It is a per-ROW product, not an aggregate: every SUBTOTAL and every FOOTER value on
 * this page is the payload's own `valuePhp`, computed in SQL over the same kilograms.
 * The distinction is the whole rule — a row multiplying its own two published numbers
 * cannot disagree with a total it does not contribute to, while a TypeScript SUM of
 * these rows could and would.
 */
function blockValuePhp(kg: number, phpKg: number): number {
  return kg * phpKg;
}

function priceRows(blocks: readonly BlendPriceBlock[]) {
  return blocks.map((b) => ({
    key: b.blockLoc,
    cells: [
      b.blockLoc,
      b.batchCode,
      fmtKg(b.kg),
      <Accounting key="p" value={b.phpKg} />,
      <Accounting key="v" value={blockValuePhp(b.kg, b.phpKg)} decimals={0} />,
    ] as Cell[],
  }));
}

function PriceGroupsTable({ analysis }: { analysis: BlendAnalysis }) {
  const price = analysis.price;
  if (!price) return null;
  const nat = price.natural;
  const groupsDesc = [...nat.groups].sort((a, b) => b.index - a.index);

  const groups: AnalysisGroupModel[] = groupsDesc.map((g: BlendPriceNaturalGroup) => ({
    key: `g${g.index}`,
    word: groupWord(g.label, nat.groupCount),
    range: `${fmtPeso(g.rangeMin)} – ${fmtPeso(g.rangeMax)}`,
    index: g.index,
    groupCount: nat.groupCount,
    ramp: 'cost' as LensRampId,
    rows: priceRows(g.blocks),
    subtotalLabel: `${groupWord(g.label, nat.groupCount)} subtotal · ${blocksWord(
      g.blockCount,
    )} · ${fmtSharePct(g.kgSharePct)} of kg`,
    subtotalCells: [
      `${fmtKg(g.kg)} kg`,
      <Accounting key="p" value={g.kgWeightedPhpKg} />,
      <Accounting key="v" value={g.valuePhp} decimals={0} />,
    ],
  }));

  const unmeasured = unmeasuredGroup(nat.unmeasured.blocks, PRICE_COLS.length, 'cost', 'No price');
  if (unmeasured) groups.push(unmeasured);

  const o = nat.overall;
  const gap = o.equalsSnapshot === false && o.snapshotPhpKg !== null && o.kgWeightedPhpKg !== null;

  return (
    <AnalysisTable
      cols={PRICE_COLS}
      minWidth={PRICE_MIN_W}
      groups={groups}
      footerLabel={`Whole blend · ${blocksWord(o.blockCount)}`}
      footerCells={[
        `${fmtKg(o.kg)} kg`,
        <Accounting key="p" value={o.kgWeightedPhpKg} />,
        <Accounting key="v" value={o.valuePhp} decimals={0} />,
      ]}
      caption={[
        naturalMethodNote({
          groupCount: nat.groupCount,
          cuts: nat.cuts,
          gvf: nat.gvf,
          formatCut: (v) => fmtPeso(v),
        }),
        unmeasuredNote(nat.unmeasured, 'No price'),
      ]
        .filter((t) => t !== '')
        .join(' · ')}
      note={
        gap
          ? snapshotGapNote({
              snapshot: fmtPeso(o.snapshotPhpKg as number),
              measured: fmtPeso(o.kgWeightedPhpKg as number),
              excluded: 'unpriced',
            })
          : undefined
      }
    />
  );
}

function VsMarketTable({
  analysis,
  bandNames,
}: {
  analysis: BlendAnalysis;
  bandNames: Record<string, string>;
}) {
  const price = analysis.price;
  if (!price) return null;
  const vm = price.vsMarket;
  if (!vm) {
    return (
      <p className="text-[10px] leading-snug text-muted-foreground">
        {price.vsMarketUnavailable
          ? vsMarketUnavailableNote(price.vsMarketUnavailable)
          : 'No comparison available'}
      </p>
    );
  }

  const bandsDesc = [...vm.bands].sort((a, b) => b.index - a.index);
  const groups: AnalysisGroupModel[] = bandsDesc.map((b: BlendVsMarketBand) => ({
    key: `b${b.index}`,
    // THE SAME label function the price lens uses, with the reader's own band names —
    // one definition, so a band cannot be called two things on one screen.
    word: priceBandLabel(b, vm.roundedUpPhp, bandNames),
    // NO RANGE BESIDE IT. The price lens's own label already states this band's bounds
    // ("Above market, ₱40 and up"), and printing them twice reads as two different
    // facts about one band. The natural-breaks table above DOES carry a range, because
    // there the label is a WORD (HIGH) and the range is the only place the observed
    // bounds appear.
    range: '',
    index: b.index,
    groupCount: vm.bands.length,
    ramp: 'cost' as LensRampId,
    rows: priceRows(b.blocks),
    subtotalLabel: `Band subtotal · ${blocksWord(b.blockCount)} · ${fmtSharePct(
      b.kgSharePct,
    )} of kg`,
    subtotalCells: [
      `${fmtKg(b.kg)} kg`,
      <Accounting key="p" value={b.kgWeightedPhpKg} />,
      <Accounting key="v" value={b.valuePhp} decimals={0} />,
    ],
    emptyNote: 'No block in this blend is in this band.',
  }));

  const unmeasured = unmeasuredGroup(vm.unmeasured.blocks, PRICE_COLS.length, 'cost', 'No price');
  if (unmeasured) groups.push(unmeasured);

  return (
    <AnalysisTable
      cols={PRICE_COLS}
      minWidth={PRICE_MIN_W}
      groups={groups}
      footerLabel={`Whole blend · ${blocksWord(vm.overall.blockCount)}`}
      footerCells={[
        `${fmtKg(vm.overall.kg)} kg`,
        <Accounting key="p" value={vm.overall.kgWeightedPhpKg} />,
        <Accounting key="v" value={vm.overall.valuePhp} decimals={0} />,
      ]}
      caption={vsMarketCaption(vm)}
    />
  );
}

// ═══ PAGE 2 — QUALITY ══════════════════════════════════════════════════════

/**
 * THREE tables, not four. BD ASTM and BD JIS are one reading of one property taken two
 * ways, so the BD table groups on ASTM and carries JIS as a SECOND VALUE COLUMN —
 * which is also how the delivery log and the blend's own weighted strip show them.
 *
 * Its JIS SUBTOTAL is deliberately an em dash: the payload publishes a kg-weighted JIS
 * per JIS group, and those groups are cut at different places from the ASTM ones, so
 * printing one of them against an ASTM group would be a figure about a different
 * population. The JIS figure that IS honest — the blend's own weighted JIS — is in the
 * footer.
 */
const QUALITY_TABLES: { metric: BlendQualityMetric; companion?: BlendQualityMetric }[] = [
  { metric: 'mc' },
  { metric: 'ash' },
  { metric: 'bd_astm', companion: 'bd_jis' },
];

/** 72 + 132 + 92 + 84 — stated, not folded. */
const QUALITY_MIN_W = 380;
/** …plus the 84px BD JIS companion column. */
const QUALITY_MIN_W_WITH_COMPANION = 464;

function qualityCols(metric: BlendQualityMetric, companion?: BlendQualityMetric): AnalysisCol[] {
  const cols: AnalysisCol[] = [
    { label: 'Block', w: 72 },
    { label: 'Batch', w: 132 },
    { label: 'Balance (kg)', w: 92, num: true },
    { label: QUALITY_METRIC_LABELS[metric], w: 84, num: true, title: QUALITY_METRIC_UNITS[metric] },
  ];
  if (companion) {
    cols.push({
      label: QUALITY_METRIC_LABELS[companion],
      w: 84,
      num: true,
      title: QUALITY_METRIC_UNITS[companion],
    });
  }
  return cols;
}

function QualityTable({
  analysis,
  metric,
  companion,
  labHighlights,
}: {
  analysis: BlendAnalysis;
  metric: BlendQualityMetric;
  companion?: BlendQualityMetric;
  labHighlights: Record<LabMetric, LabHighlightSpec>;
}) {
  const nat = analysis.quality.byMetric[metric];
  const comp = companion ? analysis.quality.byMetric[companion] : null;
  const cols = qualityCols(metric, companion);

  // The companion's per-block reading, by block. A LOOKUP, not a computation.
  const compByBlock = new Map<string, number>();
  if (comp) {
    for (const g of comp.groups) for (const b of g.blocks) compByBlock.set(b.blockLoc, b.value);
  }

  const groupsDesc = [...nat.groups].sort((a, b) => b.index - a.index);
  const groups: AnalysisGroupModel[] = groupsDesc.map((g: BlendQualityGroup) => ({
    key: `g${g.index}`,
    word: groupWord(g.label, nat.groupCount),
    range: `${fmtQuality(metric, g.rangeMin)} – ${fmtQuality(metric, g.rangeMax)}`,
    index: g.index,
    groupCount: nat.groupCount,
    // Quality is not cost: a wet block painted red would read as an expensive one. The
    // AGE ramp is the page's second scale and is reused here for the same reason it
    // exists — see `lens/lens-ramp.ts`.
    ramp: 'age' as LensRampId,
    rows: g.blocks.map((b) => {
      const cells: Cell[] = [
        b.blockLoc,
        b.batchCode,
        fmtKg(b.kg),
        // The SAME lab-highlight thresholds the grid cells use — the reader's own
        // WET / ASHY limits, never a number typed in here.
        <span key="v" className={cn(getLabHighlightText(metric, b.value, labHighlights))}>
          {fmtQuality(metric, b.value)}
        </span>,
      ];
      if (companion) {
        const cv = compByBlock.get(b.blockLoc);
        cells.push(
          cv === undefined ? (
            <span key="c" className="text-muted-foreground">
              {EMDASH}
            </span>
          ) : (
            <span
              key="c"
              className={cn(getLabHighlightText(companion, cv, labHighlights))}
            >
              {fmtQuality(companion, cv)}
            </span>
          ),
        );
      }
      return { key: b.blockLoc, cells };
    }),
    subtotalLabel: `${groupWord(g.label, nat.groupCount)} subtotal · ${blocksWord(
      g.blockCount,
    )} · ${fmtSharePct(g.kgSharePct)} of kg`,
    subtotalCells: companion
      ? [`${fmtKg(g.kg)} kg`, fmtQuality(metric, g.kgWeightedValue), EMDASH]
      : [`${fmtKg(g.kg)} kg`, fmtQuality(metric, g.kgWeightedValue)],
  }));

  const unmeasured = unmeasuredGroup(nat.unmeasured.blocks, cols.length, 'age', 'No reading');
  if (unmeasured) groups.push(unmeasured);

  const o = nat.overall;
  const gap = o.equalsSnapshot === false && o.snapshotValue !== null && o.kgWeightedValue !== null;

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground">
        {QUALITY_METRIC_LABELS[metric]}
        {companion && ` + ${QUALITY_METRIC_LABELS[companion]}`}
        <span className="ml-1.5 font-normal normal-case text-muted-foreground">
          {QUALITY_METRIC_UNITS[metric]}
        </span>
      </div>
      <AnalysisTable
        cols={cols}
        minWidth={companion ? QUALITY_MIN_W_WITH_COMPANION : QUALITY_MIN_W}
        groups={groups}
        footerLabel={`Whole blend · ${blocksWord(o.blockCount)}`}
        footerCells={
          companion && comp
            ? [
                `${fmtKg(o.kg)} kg`,
                fmtQuality(metric, o.kgWeightedValue),
                fmtQuality(companion, comp.overall.kgWeightedValue),
              ]
            : [`${fmtKg(o.kg)} kg`, fmtQuality(metric, o.kgWeightedValue)]
        }
        caption={[
          naturalMethodNote({
            groupCount: nat.groupCount,
            cuts: nat.cuts,
            gvf: nat.gvf,
            formatCut: (v) => v.toFixed(qualityDecimals(metric)),
          }),
          unmeasuredNote(nat.unmeasured, 'No reading'),
        ]
          .filter((t) => t !== '')
          .join(' · ')}
        note={
          gap
            ? snapshotGapNote({
                snapshot: fmtQuality(metric, o.snapshotValue),
                measured: fmtQuality(metric, o.kgWeightedValue),
                excluded: 'no-reading',
              })
            : undefined
        }
      />
    </div>
  );
}

// ═══ PAGE 3 — AGE ══════════════════════════════════════════════════════════

const AGE_COLS: AnalysisCol[] = [
  { label: 'Block', w: 72 },
  { label: 'Batch', w: 132 },
  { label: 'Balance (kg)', w: 92, num: true },
  { label: 'Age (d)', w: 74, num: true, title: 'Days since the pile’s kg-weighted mean delivery date' },
  { label: 'First delivery', w: 96, num: true },
  { label: 'Last delivery', w: 96, num: true },
];

/** 72 + 132 + 92 + 74 + 96 + 96 — stated, not folded. */
const AGE_MIN_W = 562;

function AgeTable({
  analysis,
  bandNames,
}: {
  analysis: BlendAnalysis;
  bandNames: Record<string, string>;
}) {
  const age = analysis.age;
  const bandsDesc = [...age.bands].sort((a, b) => b.index - a.index);

  const groups: AnalysisGroupModel[] = bandsDesc.map((b: BlendAgeBand) => ({
    key: `b${b.index}`,
    // THE SAME label function the age lens uses, with the reader's own band names.
    word: ageBandLabel(b, bandNames),
    range:
      b.upperDays === null
        ? `${b.lowerDays.toLocaleString()} d and over`
        : `${b.lowerDays.toLocaleString()}–${b.upperDays.toLocaleString()} d`,
    index: b.index,
    groupCount: age.bands.length,
    ramp: 'age' as LensRampId,
    rows: b.blocks.map((blk) => ({
      key: blk.blockLoc,
      cells: [
        blk.blockLoc,
        blk.batchCode,
        fmtKg(blk.kg),
        fmtDays(blk.ageDays),
        blk.firstDeliveryDate ?? EMDASH,
        blk.lastDeliveryDate ?? EMDASH,
      ] as Cell[],
    })),
    subtotalLabel: `Band subtotal · ${blocksWord(b.blockCount)} · ${fmtSharePct(
      b.kgSharePct,
    )} of kg`,
    subtotalCells: [`${fmtKg(b.kg)} kg`, fmtDays(b.kgWeightedAgeDays), EMDASH, EMDASH],
    emptyNote: 'No block in this blend is in this band.',
  }));

  const undated = unmeasuredGroup(age.undated.blocks, AGE_COLS.length, 'age', 'No delivery dates');
  if (undated) groups.push(undated);

  const o = age.overall;
  return (
    <AnalysisTable
      cols={AGE_COLS}
      minWidth={AGE_MIN_W}
      groups={groups}
      footerLabel={`Whole blend · ${blocksWord(o.blockCount)}`}
      footerCells={[`${fmtKg(o.kg)} kg`, fmtDays(o.kgWeightedAgeDays), EMDASH, EMDASH]}
      caption={[
        ageMethodNote({
          asOf: age.asOf,
          // The bands' OWN published lower bounds — a read, never a decision made here.
          cutDays: age.bands.map((b) => b.lowerDays).filter((d) => d > 0),
          oldestDays: o.oldestAgeDays,
          oldestBlockLoc: o.oldestBlockLoc,
        }),
        undatedNote(age.undated.blockCount),
      ]
        .filter((t) => t !== '')
        .join(' · ')}
    />
  );
}

// ═══ The section stack ═════════════════════════════════════════════════════

export interface BlendAnalysisSectionsProps {
  analysis: BlendAnalysis | null;
  options: BlendAnalysisOptions;
  /** The grid's EFFECTIVE price flag. */
  canViewPrices: boolean;
  loading: boolean;
  refusal: string | null;
  stalled: boolean;
  onRetry: () => void;
  /** The reader's own PRICE-lens band names, so a band reads the same in both places. */
  priceBandNames: Record<string, string>;
  /** The reader's own AGE-lens band names. */
  ageBandNames: Record<string, string>;
  /** The reader's WET / ASHY lab-highlight thresholds, from `useTableSettings()`. */
  labHighlights: Record<LabMetric, LabHighlightSpec>;
}

/**
 * Is the comparison against a price somebody TYPED, rather than a measured market?
 *
 * Read off the payload's own `marketBasis` — `'given'` is what SQL calls a figure that
 * came in as an argument. Both the available and the unavailable shapes carry it, so a
 * blend whose market could not be measured still gets the right heading. Nothing here
 * decides anything; it is the switch `vsMarketHeading` needs.
 */
function typedPriceBasis(analysis: BlendAnalysis | null): boolean {
  const price = analysis?.price;
  if (!price) return false;
  if (price.vsMarket) return price.vsMarket.marketBasis === 'given';
  return price.vsMarketUnavailable?.marketBasis === 'given';
}

/** A layout-matched placeholder, so nothing jumps when the payload lands. */
function SectionSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-1.5" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-[22px] border-b border-border/40 last:border-b-0" />
      ))}
    </div>
  );
}

export function BlendAnalysisSections({
  analysis,
  options,
  canViewPrices,
  loading,
  refusal,
  stalled,
  onRetry,
  priceBandNames,
  ageBandNames,
  labHighlights,
}: BlendAnalysisSectionsProps) {
  const pages: BlendAnalysisPageId[] = analysisPages(options, canViewPrices);
  if (pages.length === 0) return null;

  return (
    <div className="space-y-4" data-blend-analysis>
      {refusal && <RefusalBanner message={refusal} onRetry={onRetry} />}
      {stalled && !refusal && (
        <RefusalBanner
          message={
            'The analysis pages did not come back. Anything on screen is from an earlier read. ' +
            'Retry, or reload the page; if it keeps happening, copy this and send it on.'
          }
          onRetry={onRetry}
        />
      )}

      {/* Prices hidden for this reader: say so ONCE rather than rendering an empty
          page or quietly dropping a checkbox they ticked. */}
      {analysis?.pricesHidden && options.price && (
        <p className="text-[10px] text-muted-foreground">
          Prices are not shown for your role, so the price pages are left out.
        </p>
      )}

      {pages.map((id) => (
        <section key={id} className="space-y-2">
          {id === 'price' && (
            <>
              <PageHeading icon={Coins} title="Price groups — natural breaks" />
              {analysis?.price ? (
                <PriceGroupsTable analysis={analysis} />
              ) : (
                <SectionSkeleton rows={8} />
              )}
              <div className="pt-1">
                {/* THE ONE definition of this heading. A figure the operator TYPED is a
                    SET PRICE, and the word "market" must not appear anywhere for it. */}
                <PageHeading icon={Coins} title={vsMarketHeading(typedPriceBasis(analysis))} />
              </div>
              {analysis?.price ? (
                <VsMarketTable analysis={analysis} bandNames={priceBandNames} />
              ) : (
                <SectionSkeleton rows={6} />
              )}
            </>
          )}

          {id === 'quality' && (
            <>
              <PageHeading icon={FlaskConical} title="Quality — MC · ASH · BD" />
              {analysis ? (
                <div className="space-y-3">
                  {QUALITY_TABLES.map(({ metric, companion }) => (
                    <QualityTable
                      key={metric}
                      analysis={analysis}
                      metric={metric}
                      companion={companion}
                      labHighlights={labHighlights}
                    />
                  ))}
                </div>
              ) : (
                <SectionSkeleton rows={10} />
              )}
            </>
          )}

          {id === 'age' && (
            <>
              <PageHeading icon={Hourglass} title="Age" />
              {analysis ? <AgeTable analysis={analysis} bandNames={ageBandNames} /> : <SectionSkeleton rows={8} />}
            </>
          )}
        </section>
      ))}

      {loading && (
        <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Working out the analysis pages…
        </p>
      )}
    </div>
  );
}
