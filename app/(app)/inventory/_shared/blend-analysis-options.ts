// ─────────────────────────────────────────────────────────────────────────────
// WHICH ANALYSIS PAGES A PROPOSAL CARRIES — pure, and deliberately dull.
//
// The owner asked for the extra pages and then asked for them to be optional:
// *"Maybe even age? Maybe make those extras an option."* So a reader ticks the
// pages they want, once, and every proposal they open and print afterwards carries
// exactly those — which makes this a PREFERENCE, not a per-proposal field. It is
// stored in `user_table_settings` under `module = 'blocking_blend_analysis'`,
// through the same shape-agnostic `getUserModuleSettings` / `saveUserModuleSettings`
// pair the two lenses use (`lens/use-lens-settings.ts`), so it needs no migration,
// no table and no new server action.
//
// ── THE STORED VALUE IS UNTRUSTED ────────────────────────────────────────────
// `user_table_settings.settings` is a free-form jsonb bag with no CHECK constraint
// and may have been written by an older build, another browser, or by hand. So
// `parseBlendAnalysisOptions` validates FIELD BY FIELD and falls back PER FIELD —
// never "one bad key, everything to defaults", which would throw away two good
// choices for one typo.
//
// ── THE DEFAULT IS EVERYTHING ON ─────────────────────────────────────────────
// The pages are the feature; a reader who has never opened the popover should see
// them. `serializeBlendAnalysisOptions` therefore omits a `true`, so the stored
// document says only what was turned OFF and "no row" means "everything" — which is
// also why the FOURTH page (the yard map, 2026-09-23) needed no migration and no
// backfill: a document written before it existed simply says nothing about it, and the
// per-field parser reads that as the shipped default.
//
// ── THE YARD MAP IS AN INCLUDE-PAGE, NOT AN ANALYSIS PAGE ────────────────────
// It is ticked in the same popover, stored in the same document and counted on the same
// `+N` button, but it is NOT in `BLEND_ANALYSIS_PAGE_ORDER` and `analysisPages()` never
// returns it, because three things follow from that one fact and all three are correct:
// it renders no on-screen section (it is a printed sheet only), it is not built by
// `buildBlendAnalysisPages`, and `wantsAnalysis()` stays FALSE when it is the only page
// ticked — so a reader who wants nothing but the map pays no analysis round-trip. It also
// carries NO ₱ (it is slots and colours), so unlike the price page it is never gated.
//
// ── PRICE IS NOT A PREFERENCE ALONE ──────────────────────────────────────────
// The price page is also subject to the page's EFFECTIVE price flag
// (`serverCanViewPrices && showPrices`), which is a fact about the READER and can
// never be overridden by a stored option. `analysisPages()` takes that flag and is
// THE one place the two are combined, so the checkbox list, the rendered sections,
// the print and the button's own label can never disagree about how many pages
// there are.
//
// NOTHING HERE COMPUTES A STATISTIC. It counts pages.
// ─────────────────────────────────────────────────────────────────────────────

/** `user_table_settings.module` for the Include-pages choice. Also the localStorage base. */
export const BLEND_ANALYSIS_SETTINGS_MODULE = 'blocking_blend_analysis';

/** The three optional ANALYSIS pages, in render and print order. */
export type BlendAnalysisPageId = 'price' | 'quality' | 'age';

export const BLEND_ANALYSIS_PAGE_ORDER: readonly BlendAnalysisPageId[] = [
  'price',
  'quality',
  'age',
];

/** Every page a reader can tick — the three analysis pages plus the YARD MAP. */
export type BlendIncludePageId = BlendAnalysisPageId | 'yardMap';

/**
 * The CHECKBOX order, and the order the parser and serializer walk.
 *
 * The yard map is LAST here because it is the fourth checkbox, and FIRST in the printed
 * document (immediately after the Selected blocks table) because it belongs beside the
 * block list rather than among the analysis tables. Two orders, each stated where it
 * applies; neither is derived from the other.
 */
export const BLEND_INCLUDE_PAGE_ORDER: readonly BlendIncludePageId[] = [
  'price',
  'quality',
  'age',
  'yardMap',
];

/** What each checkbox says, and what the page is for. */
export const BLEND_ANALYSIS_PAGE_LABELS: Record<
  BlendIncludePageId,
  { label: string; blurb: string }
> = {
  price: {
    label: 'Price groups',
    blurb: 'High / average / low, cut where the prices naturally separate, plus against market.',
  },
  quality: {
    label: 'Quality (MC · Ash · BD)',
    blurb: 'Each reading grouped high to low, with kg-weighted averages.',
  },
  age: {
    label: 'Age',
    blurb: 'How long each pile has been sitting, in the age lens’s own bands.',
  },
  yardMap: {
    label: 'Yard map',
    blurb: 'Where the blend sits — every block location on one landscape sheet.',
  },
};

export interface BlendAnalysisOptions {
  price: boolean;
  quality: boolean;
  age: boolean;
  /** The printed YARD MAP sheet. Not an analysis page — see the header. */
  yardMap: boolean;
}

export const DEFAULT_BLEND_ANALYSIS_OPTIONS: BlendAnalysisOptions = {
  price: true,
  quality: true,
  age: true,
  yardMap: true,
};

/**
 * Validate a stored document, FIELD BY FIELD, falling back per field.
 *
 * Anything that is not a boolean is not an answer, so the shipped default stands for
 * that page alone.
 */
export function parseBlendAnalysisOptions(raw: unknown): BlendAnalysisOptions {
  const out: BlendAnalysisOptions = { ...DEFAULT_BLEND_ANALYSIS_OPTIONS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  for (const id of BLEND_INCLUDE_PAGE_ORDER) {
    if (typeof rec[id] === 'boolean') out[id] = rec[id] as boolean;
  }
  return out;
}

/**
 * The document to store — DEFAULTS OMITTED.
 *
 * `saveUserModuleSettings` REPLACES the row, so leaving a defaulted field out is what
 * makes turning everything back on an actual removal rather than three `true`s that
 * have to be recognised as defaults forever after.
 */
export function serializeBlendAnalysisOptions(
  o: BlendAnalysisOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const id of BLEND_INCLUDE_PAGE_ORDER) {
    if (o[id] !== DEFAULT_BLEND_ANALYSIS_OPTIONS[id]) body[id] = o[id];
  }
  return body;
}

/**
 * THE one combination of the reader's choice with the reader's PERMISSION.
 *
 * `canViewPrices` is the grid's EFFECTIVE flag (server gate AND the page's own Prices
 * toggle). A denied reader never gets the price page, whatever the stored option says
 * — and the payload they receive has `price: null` with `pricesHidden: true`, so there
 * would be nothing to render anyway.
 */
export function analysisPages(
  o: BlendAnalysisOptions,
  canViewPrices: boolean,
): BlendAnalysisPageId[] {
  return BLEND_ANALYSIS_PAGE_ORDER.filter((id) => {
    if (!o[id]) return false;
    if (id === 'price') return canViewPrices;
    return true;
  });
}

/**
 * How many EXTRA SHEETS the printout will carry — THE one definition of the `+N` count.
 *
 * The yard map is added here rather than inside `analysisPages()` so the analysis gate
 * keeps meaning exactly one thing (which ANALYSIS pages a reader may see), and so the
 * price permission cannot accidentally take the map away: it carries no ₱.
 */
export function includedPageCount(
  o: BlendAnalysisOptions,
  canViewPrices: boolean,
): number {
  return analysisPages(o, canViewPrices).length + (o.yardMap ? 1 : 0);
}

/** `3 extra pages` / `1 extra page` / `no extra pages` — for the Print button's title. */
export function analysisPagesLabel(pageCount: number): string {
  if (pageCount <= 0) return 'no extra pages';
  return `${pageCount} extra page${pageCount === 1 ? '' : 's'}`;
}

/**
 * Does any chosen page need a payload at all?
 *
 * With every page unticked the dialog does not read the analysis, which keeps the
 * round-trip off an operator who does not want the pages.
 */
export function wantsAnalysis(o: BlendAnalysisOptions, canViewPrices: boolean): boolean {
  return analysisPages(o, canViewPrices).length > 0;
}
