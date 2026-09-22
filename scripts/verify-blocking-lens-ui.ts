/**
 * verify-blocking-lens-ui.ts — the proofs behind the BLOCKING LENS **UI**.
 *
 * Run: npx tsx scripts/verify-blocking-lens-ui.ts
 *
 * ============================================================================
 * WHAT THIS SCRIPT IS FOR, AND WHAT IT IS DELIBERATELY NOT FOR
 * ============================================================================
 * `scripts/verify-blocking-price-lens.ts` and `…-age-lens.ts` prove the two DATA
 * layers against the live database (49 assertions each). This one proves the things
 * a data-layer test cannot see and a type-checker will not catch — the properties
 * that would rot SILENTLY, because nothing crashes when they break and the screen
 * still renders something:
 *
 *   SOURCE ORDER  the seven `.lens-band-*` rules must sit AFTER
 *                 `.blocking-cell-occupied` in `globals.css`. Same specificity, so
 *                 source order decides; moved above it, every band tint silently
 *                 loses to the cell's own background and the lens paints nothing.
 *                 This is the exact trap the supplier spotlights already carry a
 *                 comment about, and it has no runtime symptom short of "the
 *                 feature does not work".
 *   NO MATHS      a lens must never sum a kilogram or derive a share. Every one
 *                 comes out of SQL (`fetchBlockingPriceLens`), and a TypeScript
 *                 re-derivation would let the picture disagree with the bands it
 *                 is describing. A `reduce` added here would type-check perfectly.
 *   THE GATE      the entry point must hang off the grid's EFFECTIVE price flag
 *                 (`serverCanViewPrices && showPrices`), not off the server flag
 *                 alone — otherwise hiding prices leaves a lens offering to
 *                 describe them. (The server refuses the call regardless; this is
 *                 the UI half.)
 *   UNTRUSTED     the stored settings come back from a free-form jsonb bag with no
 *                 CHECK constraint. They are validated FIELD BY FIELD with a
 *                 per-field fallback — proven by actually running the parser over a
 *                 hostile document, not by reading it.
 *   ERRORS        `errorToast()` only, never a raw `toast.error` (the project's
 *                 HARD RULE: an error persists and offers Copy).
 *   THE FRAME     the registry shape exists and refuses an id this reader may not
 *                 be offered, so a shared `?lens=price` link cannot hand a
 *                 Production user a substitute lens — it falls back to one they CAN
 *                 see, quietly.
 *   TWO LENSES    Price and Age share the legend, the ratio bar, the refusal banner
 *                 and the Customize disclosure. What must NOT be shared is the
 *                 COLOUR RAMP (age is not cost — a red old block reads as an
 *                 expensive one) and the price GATE (there is no money in the age
 *                 payload, so Production must keep that lens). Both are asserted
 *                 here, in both directions.
 *
 * ============================================================================
 * NO ₱ IS PRINTED BY THIS SCRIPT
 * ============================================================================
 * It reads source files and calls pure functions. It opens no database
 * connection, holds no key, and the only prices it mentions are the LITERAL band
 * bounds of a synthetic R = 40 used to check label wording.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  addEdgeOffset,
  bandEdgeKey,
  bandRampClass,
  bandRampStop,
  DEFAULT_PRICE_LENS_SETTINGS,
  isDefaultPriceLensSettings,
  normalizeEdgeOffsets,
  parseManualPriceInput,
  parsePriceLensSettings,
  PRICE_LENS_BASIS_LABELS,
  PRICE_LENS_BASIS_ORDER,
  PRICE_LENS_ID,
  PRICE_LENS_RAMP,
  PRICE_LENS_RAMP_STOPS,
  priceBandLabel,
  removeEdgeOffset,
  serializePriceLensSettings,
} from '../app/(app)/inventory/blocking/lens/price-lens-settings';
import {
  addEdgeDay,
  ageBandLabel,
  ageBandRampClass,
  AGE_LENS_ID,
  AGE_LENS_QUICK_CUTS,
  AGE_LENS_RAMP,
  bandDayKey,
  DEFAULT_AGE_LENS_SETTINGS,
  isDefaultAgeLensSettings,
  normalizeEdgeDays,
  parseAgeLensSettings,
  parseEdgeDayInput,
  removeEdgeDay,
  serializeAgeLensSettings,
  yearWord,
} from '../app/(app)/inventory/blocking/lens/age-lens-settings';
import {
  LENS_CATEGORY_NEUTRAL_STOP,
  LENS_CATEGORY_STOPS,
  LENS_PRINT_FILL_RGB,
  LENS_RAMP_CLASS_PREFIX,
  LENS_RAMP_IS_ORDINAL,
  LENS_RAMP_RGB,
  LENS_RAMP_STOPS,
  categoryStop,
  printFillRgbAtStop,
  rampClass,
  rampClassAtStop,
  rampStop,
  resolveBandRampStop,
} from '../app/(app)/inventory/blocking/lens/lens-ramp';
import { WAREHOUSES } from '../app/(app)/inventory/blocking/constants';
import type { BlockData } from '../app/(app)/inventory/blocking/types';
import {
  LENS_YARD_MAP_DARK_INK,
  LENS_YARD_MAP_INK_CROSSOVER,
  LENS_YARD_MAP_MIN_LOC_PT,
  LENS_YARD_MAP_MUTED_BG,
  buildLensYardMap,
  lensYardMapInkOn,
  lensYardMapLines,
  lensYardMapLuminance,
  lensYardMapPaint,
} from '../app/(app)/inventory/blocking/lens/lens-yard-map-model';
import {
  a4LandscapeBox,
  fitCellGrid,
  fitMonoLabelPt,
  PX_PER_PT,
} from '../components/shared/print/print-fit';
import {
  buildLensGroupFigures,
  buildLensSummaryBuckets,
} from '../app/(app)/inventory/blocking/lens/lens-summary-model';
import {
  buildLensMarketPrintModel,
  buildLensSupplierMarketPrintModel,
  printChartDomain,
} from '../app/(app)/inventory/blocking/lens/lens-market-model';
import { LENS_PRINT_CHART_LABEL_PX } from '../app/(app)/inventory/blocking/lens/lens-print-chart';
import type {
  BlockingLensLabStats,
  BlockingMarketContext,
  BlockingSupplierMarket,
  BlockingSupplierMarketEntry,
} from '../app/(app)/inventory/blocking/types';

/**
 * One occupied slot, with every figure at a value the YARD MAP must never read.
 *
 * The map draws a `block_loc` and a fill; if a future edit reached for a kilogram or a
 * price, these zeros would not catch it — the assertion that does is the source scan
 * below. This exists only so `buildLensYardMap` has a real `BlockData` to place.
 */
const BLOCK_STUB: BlockData = {
  batch_code: 'SEPT-26-BLK1',
  batch_id: 'stub',
  status: 'STORED',
  balance: 0,
  total_in: 0,
  php: null,
  bd_astm: 0,
  bd_jis: 0,
  ash: 0,
  mc: 0,
  grit: 0,
  vm: 0,
  fc: 0,
};
import {
  DEFAULT_SUPPLIER_LENS_SETTINGS,
  isDefaultSupplierLensSettings,
  normalizeTopN,
  parseSupplierLensSettings,
  parseTopNInput,
  serializeSupplierLensSettings,
  setTopN,
  supplierBandLabel,
  supplierBandRampClass,
  supplierBandRampStop,
  SUPPLIER_LENS_ID,
  SUPPLIER_LENS_MIXED_CLASS,
  SUPPLIER_LENS_RAMP,
} from '../app/(app)/inventory/blocking/lens/supplier-lens-settings';
import {
  resolveLensCellClass,
  resolveLensCellTitle,
} from '../app/(app)/inventory/blocking/lens/types';

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const LENS_DIR = 'app/(app)/inventory/blocking/lens';
const GLOBALS = 'app/globals.css';
const GRID = 'app/(app)/inventory/blocking/blocking-grid.tsx';
const ROUTE = 'app/(app)/inventory/blocking/blocking-route-view.tsx';
const PANEL = `${LENS_DIR}/price-lens-panel.tsx`;
const AGE_PANEL = `${LENS_DIR}/age-lens-panel.tsx`;
const AGE_SETTINGS = `${LENS_DIR}/age-lens-settings.ts`;
const SUPPLIER_PANEL = `${LENS_DIR}/supplier-lens-panel.tsx`;
const SUPPLIER_SETTINGS = `${LENS_DIR}/supplier-lens-settings.ts`;
const SUMMARY_MODEL = `${LENS_DIR}/lens-summary-model.ts`;
const FRAME = `${LENS_DIR}/lens-panel.tsx`;
const REGISTRY = `${LENS_DIR}/registry.ts`;
const SETTINGS = `${LENS_DIR}/price-lens-settings.ts`;
const STORE = `${LENS_DIR}/use-lens-settings.ts`;
const TYPES = `${LENS_DIR}/types.ts`;
/** The pieces BOTH lenses render through — extracted so neither can fork them. */
const RAMP = `${LENS_DIR}/lens-ramp.ts`;
const SHARED = `${LENS_DIR}/lens-shared.ts`;
const ROWS = `${LENS_DIR}/lens-band-rows.tsx`;
const BAR = `${LENS_DIR}/lens-ratio-bar.tsx`;
const CUSTOMIZE = `${LENS_DIR}/lens-customize.tsx`;
const BANNER = `${LENS_DIR}/lens-refusal-banner.tsx`;
/** Every lens file, for the rules that must hold across ALL of them. */
/** The YARD MAP page (2026-09-22) — its model and its sheet. */
const YARD_MAP_MODEL = `${LENS_DIR}/lens-yard-map-model.ts`;
const YARD_MAP_PRINT = `${LENS_DIR}/lens-yard-map-print.tsx`;
/** PAGE ONE's context blocks (2026-09-22) — the chart primitive, the model, the two sheets. */
const PRINT_CHART = `${LENS_DIR}/lens-print-chart.tsx`;
const MARKET_MODEL = `${LENS_DIR}/lens-market-model.ts`;
const MARKET_PRINT = `${LENS_DIR}/lens-market-print.tsx`;
const SUPPLIER_MARKET_PRINT = `${LENS_DIR}/lens-supplier-market-print.tsx`;
const SUMMARY_PRINT = `${LENS_DIR}/lens-summary-print.tsx`;
/** The PLATFORM fit module both the map and RC Movement solve against. */
const PRINT_FIT = 'components/shared/print/print-fit.ts';
const ALL_LENS_FILES = [
  PANEL, AGE_PANEL, SUPPLIER_PANEL, SETTINGS, AGE_SETTINGS, SUPPLIER_SETTINGS,
  FRAME, TYPES, STORE, REGISTRY,
  RAMP, SHARED, ROWS, BAR, CUSTOMIZE, BANNER,
  // The yard map carries NO kilogram, NO ₱, NO age and NO supplier figure — it draws a
  // loc and a fill — so it belongs under the no-maths rule rather than beside
  // `lens-summary-model.ts`'s one stated exception.
  YARD_MAP_MODEL, YARD_MAP_PRINT,
  // PAGE ONE's context blocks. Every figure on them is a field of the two market payloads,
  // so they belong squarely under the no-maths rule: a `reduce` or a `+=` in any of them
  // would be a market average living in TypeScript, which is the whole thing
  // `view_analytics_rcin_monthly` / `view_analytics_supplier_monthly` exist to own.
  PRINT_CHART, MARKET_MODEL, MARKET_PRINT, SUPPLIER_MARKET_PRINT,
];
const CONTEXT = 'app/(app)/inventory/blocking/CONTEXT.md';

const cache = new Map<string, string>();
function read(rel: string): string {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  const body = readFileSync(resolve(process.cwd(), rel), 'utf8');
  assert.ok(body.length > 0, `${rel} is empty`);
  cache.set(rel, body);
  return body;
}

/** Source with `//` and `/* *​/` comments blanked, so a comment can never satisfy
 *  — or trip — a code assertion. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// ===========================================================================
console.log('\n1. CSS — the band ramp, and the source order that makes it work');
// ===========================================================================

{
  const css = read(GLOBALS);
  const occupied = css.indexOf('.blocking-cell-occupied {');
  check('`.blocking-cell-occupied` is still the cell background rule', () => {
    assert.ok(occupied > 0, 'the occupied-cell rule is gone — the ordering premise moved');
  });

  for (let i = 0; i < PRICE_LENS_RAMP_STOPS; i += 1) {
    check(`\`.lens-band-${i}\` exists, declares a hue, and sits AFTER \`.blocking-cell-occupied\``, () => {
      const at = css.indexOf(`.lens-band-${i} {`);
      assert.ok(at > 0, `.lens-band-${i} is missing from globals.css`);
      assert.ok(
        at > occupied,
        `.lens-band-${i} is declared BEFORE .blocking-cell-occupied — same specificity, so the cell's own background wins and the lens paints nothing`,
      );
      assert.ok(
        /--lens-hue:\s*\d+\s+\d+\s+\d+;/.test(css.slice(at, at + 200)),
        `.lens-band-${i} does not set --lens-hue`,
      );
    });
  }

  check('the seven stops have DISTINCT hues (a ramp, not one colour repeated)', () => {
    const hues = new Set<string>();
    for (let i = 0; i < PRICE_LENS_RAMP_STOPS; i += 1) {
      const at = css.indexOf(`.lens-band-${i} {`);
      const m = /--lens-hue:\s*([\d\s]+);/.exec(css.slice(at, at + 200));
      assert.ok(m, `.lens-band-${i} hue unreadable`);
      hues.add(m![1].trim());
    }
    assert.equal(hues.size, PRICE_LENS_RAMP_STOPS, 'two ramp stops share a hue');
  });

  check('every stop has a DARK-mode rule (both themes, not just one)', () => {
    for (let i = 0; i < PRICE_LENS_RAMP_STOPS; i += 1) {
      assert.ok(
        css.includes(`:is(.dark) .lens-band-${i}`),
        `.lens-band-${i} has no :is(.dark) variant`,
      );
    }
  });

  check('`.lens-band-picked` and `.lens-band-swatch` are declared AFTER the band rules', () => {
    const lastBand = css.indexOf('.lens-band-6,');
    const pickedAt = css.indexOf('.lens-band-picked {');
    const swatchAt = css.indexOf('.lens-band-swatch {');
    assert.ok(pickedAt > 0 && swatchAt > 0, 'the picked/swatch rules are missing');
    assert.ok(pickedAt > lastBand, '.lens-band-picked must beat the tint rule it overrides');
    assert.ok(swatchAt > pickedAt, '.lens-band-swatch must beat both');
  });

  check('a lens band is NEVER animated — box-shadow/background only, no keyframes', () => {
    const from = css.indexOf('.lens-band-0 {');
    const to = css.indexOf('.lens-band-swatch {') + 200;
    const block = css.slice(from, to);
    assert.ok(!/animation\s*:/.test(block), 'a lens band declares an animation — cells are never animated');
    assert.ok(
      !/transition\s*:\s*(?!opacity|box-shadow)/.test(block.replace(/transition:\s*opacity 150ms ease, box-shadow 150ms ease;/g, '')),
      'a lens band transitions something other than opacity/box-shadow',
    );
  });

  // ── The AGE ramp: same ordering rule, same both-themes rule, and one more —
  //    it must NOT reuse the cost ramp's colours. Emerald→rose already means
  //    cheap→dear on this page, so an old block painted red would be read as an
  //    expensive one, which is a fact about a different column.
  for (let i = 0; i < LENS_RAMP_STOPS; i += 1) {
    check(`\`.lens-age-${i}\` exists, declares a hue, and sits AFTER \`.blocking-cell-occupied\``, () => {
      const at = css.indexOf(`.lens-age-${i} {`);
      assert.ok(at > 0, `.lens-age-${i} is missing from globals.css`);
      assert.ok(
        at > occupied,
        `.lens-age-${i} is declared BEFORE .blocking-cell-occupied — same specificity, so the cell's own background wins and the age lens paints nothing`,
      );
      assert.ok(
        /--lens-hue:\s*\d+\s+\d+\s+\d+;/.test(css.slice(at, at + 200)),
        `.lens-age-${i} does not set --lens-hue`,
      );
    });
  }

  check('the AGE ramp has seven DISTINCT hues, and NONE of them is a cost-ramp hue', () => {
    const hue = (sel: string): string => {
      const at = css.indexOf(`${sel} {`);
      const m = /--lens-hue:\s*([\d\s]+);/.exec(css.slice(at, at + 200));
      assert.ok(m, `${sel} hue unreadable`);
      return m![1].trim();
    };
    const ageHues: string[] = [];
    const costHues = new Set<string>();
    for (let i = 0; i < LENS_RAMP_STOPS; i += 1) {
      ageHues.push(hue(`.lens-age-${i}`));
      costHues.add(hue(`.lens-band-${i}`));
    }
    assert.equal(new Set(ageHues).size, LENS_RAMP_STOPS, 'two age stops share a hue');
    for (const h of ageHues) {
      assert.ok(
        !costHues.has(h),
        `the age ramp reuses the cost ramp's hue ${h} — "old" would read as "expensive"`,
      );
    }
  });

  check('every AGE stop has a DARK-mode rule too (both themes, not just one)', () => {
    for (let i = 0; i < LENS_RAMP_STOPS; i += 1) {
      assert.ok(
        css.includes(`:is(.dark) .lens-age-${i}`),
        `.lens-age-${i} has no :is(.dark) variant`,
      );
    }
  });

  check('both ramps share ONE tint rule, so their alpha cannot drift apart', () => {
    // The age classes join the cost ramp's grouped selector list rather than
    // declaring their own background/box-shadow — that is what keeps the measured
    // 22%/30% wash (and therefore the lab-highlight contrast) identical on both.
    const tintAt = css.indexOf('.lens-band-0,\n.lens-band-1,');
    assert.ok(tintAt > 0, 'the grouped tint rule is gone or was re-spelled');
    const rule = css.slice(tintAt, css.indexOf('}', css.indexOf('box-shadow', tintAt)));
    for (let i = 0; i < LENS_RAMP_STOPS; i += 1) {
      assert.ok(
        rule.includes(`.lens-age-${i}`),
        `.lens-age-${i} is not in the shared tint rule — it would have a second, driftable copy`,
      );
    }
    assert.ok(/rgb\(var\(--lens-hue\) \/ 0\.22\)/.test(rule), 'the light-mode tint alpha moved');
  });

  check('`.lens-band-picked` and `.lens-band-swatch` are HUE-AGNOSTIC, so both ramps get them', () => {
    const picked = css.slice(css.indexOf('.lens-band-picked {'), css.indexOf('.lens-band-swatch {'));
    assert.ok(picked.includes('var(--lens-hue)'), 'the picked ring hardcodes a colour');
    assert.ok(!/lens-age|lens-band-\d/.test(picked), 'the picked ring is scoped to one ramp');
  });

  check('the shared `.spotlight-dimmed` is REUSED, not cloned as a lens-specific rule', () => {
    assert.ok(css.includes('.spotlight-dimmed {'), '.spotlight-dimmed is gone');
    assert.ok(!css.includes('.lens-dimmed'), 'a second dimming rule appeared — there is one definition of "out of focus"');
    assert.ok(
      code(TYPES).includes("'spotlight-dimmed'"),
      'the resolver no longer returns the shared dimming class',
    );
  });
}

// ===========================================================================
console.log('\n2. NO STATISTIC IS COMPUTED IN A LENS FILE');
// ===========================================================================

{
  // The panel and the settings module are the two places a share or a kilogram
  // could plausibly be re-derived. The FIXTURE at /dev/table-playground/pricelens
  // does build a payload — deliberately, it stands in for SQL — and is outside
  // this directory, which is why the rule is scoped to the lens files.
  for (const rel of ALL_LENS_FILES) {
    check(`${rel.split('/').pop()} sums nothing: no reduce / += / running total`, () => {
      const body = code(rel);
      assert.ok(!/\.reduce\s*\(/.test(body), `${rel} calls .reduce(` );
      assert.ok(!/\+=/.test(body), `${rel} accumulates with +=`);
    });
  }

  // RESTATED 2026-09-22, with the reason written down. The rule used to be "no lens file
  // sums a kilogram", full stop. The printed lens summary now groups a band's blocks BY
  // WAREHOUSE (the owner's own ask), and the payload publishes no figure for "band 2's
  // kilograms in warehouse C" at ANY grain — so that one subtotal has nothing it could
  // disagree with, and every number beside it is still SQL's. The exception is therefore
  // scoped to ONE file, `lens-summary-model.ts`, which is deliberately absent from
  // `ALL_LENS_FILES`; the fold is proven to tie back to the band's own published kilograms
  // in `scripts/verify-blend-analysis-ui.ts`. What is still absolutely banned, and is
  // asserted here, is a WEIGHTED AVERAGE.
  //
  // ⚠️ COMMENT RESTATED 2026-09-22 (the assertions below did not move). It used to end
  // *"…a WEIGHTED AVERAGE: a subtotal's lab cells stay blank."* The cells are no longer
  // blank — `fn_blocking_price_lens` publishes the seven kg-weighted means per
  // (band × warehouse) since migration `20260922093000`, and the print RENDERS them. That
  // changes nothing here: this module still may not COMPUTE one, which is exactly what the
  // three assertions in the body test (no division by a total, no reading multiplied by a
  // balance, decimals only). §13 proves the render side is a lookup.
  check('the ONE exception is `lens-summary-model.ts`, and it averages NOTHING', () => {
    const model = code(SUMMARY_MODEL);
    assert.ok(
      !ALL_LENS_FILES.includes(SUMMARY_MODEL),
      'the bucketing module joined the no-sum list, so its stated exception is now a lie',
    );
    // Exactly ONE accumulation, and it is a plain sum of balances.
    const sums = [...model.matchAll(/kg = kg \+ d\.balance/g)].length;
    assert.equal(sums, 1, `the bucketing module makes ${sums} sums, not one`);
    assert.ok(!/\.reduce\s*\(/.test(model), 'the bucketing module folds with reduce');
    // NO weighted average, no division by a total, no lab arithmetic at all.
    assert.ok(!/\/\s*(kg|total|weight)/i.test(model), 'the bucketing module divides by a total');
    assert.ok(
      !/mc \* |ash \* |\* block\.balance/.test(model),
      'the bucketing module weights a lab reading by kilograms',
    );
    // The lab readings are READ off the payload and only FORMATTED.
    assert.ok(/toFixed\(2\)/.test(model) && /toFixed\(3\)/.test(model), 'the lab decimals moved');
  });

  check('the panel renders the SERVER\'s shares — it never divides by a total', () => {
    const body = code(PANEL);
    assert.ok(body.includes('kgSharePct'), 'the panel does not read the published kg share');
    assert.ok(body.includes('blockSharePct'), 'the panel does not read the published block share');
    assert.ok(
      !/\/\s*(total|lens\.total|pricedKg|totalKg)/.test(body),
      'the panel divides by a total — a share must come out of SQL',
    );
  });

  // RESTATED 2026-09-21 (it used to ban BOTH `Math.floor` and `Math.ceil` in every
  // lens file). The MEASURED rule `R = floor(market)+1` is still SQL's and `Math.floor`
  // is still banned everywhere — but a price the operator TYPES is the cut line itself,
  // so `manual` sends `Math.ceil(typed)` as the third argument. That single `ceil` is
  // allowed in ONE function in ONE file, and the assertion now pins exactly that.
  check('R is SQL\'s: no Math.floor anywhere, and ONE Math.ceil in ONE place', () => {
    for (const rel of ALL_LENS_FILES) {
      const body = code(rel);
      assert.ok(!/Math\.floor\s*\(/.test(body), `${rel} floors a price itself — R = floor(market)+1 lives in SQL`);
      if (rel === SETTINGS) continue;
      assert.ok(
        !/Math\.ceil\s*\(/.test(body),
        `${rel} rounds a typed price itself — the ONE ceil lives in manualRoundedUpPhp()`,
      );
    }
    const settings = code(SETTINGS);
    assert.strictEqual(
      (settings.match(/Math\.ceil\s*\(/g) ?? []).length,
      1,
      'price-lens-settings.ts must contain EXACTLY one Math.ceil — the typed cut line',
    );
    assert.ok(
      /export function manualRoundedUpPhp\(/.test(settings),
      'the typed cut line has no named home — it must be manualRoundedUpPhp()',
    );
    assert.ok(code(PANEL).includes('roundedUpPhp'), 'the panel does not echo the R the server returned');
  });

  check('the AGE panel renders the SERVER\'s shares and weighted ages — it averages nothing', () => {
    const body = code(AGE_PANEL);
    assert.ok(body.includes('kgSharePct'), 'the age panel does not read the published kg share');
    assert.ok(body.includes('blockSharePct'), 'the age panel does not read the published block share');
    assert.ok(
      body.includes('kgWeightedAgeDays'),
      'the age panel does not read the published weighted age — it must never average ages itself',
    );
    assert.ok(
      !/\/\s*(total|lens\.total|totalKg|blockCount)/.test(body),
      'the age panel divides by a total — a share and a weighted age come out of SQL',
    );
    assert.ok(
      !/Math\.(min|max)\s*\(/.test(body),
      'the age panel picks an extreme itself — `oldestAgeDays`/`oldestBlockLoc` are the payload\'s',
    );
  });

  check('the AGE lens reads the OLDEST block from the payload, never by scanning', () => {
    const body = code(AGE_PANEL);
    assert.ok(body.includes('total.oldestBlockLoc'), 'the oldest block is not the published one');
    assert.ok(body.includes('total.oldestAgeDays'), 'the oldest age is not the published one');
    // RESTATED, NOT WEAKENED (2026-09-21, with the printed lens summary).
    //
    // The original assertion banned `sort(` outright, which was the right shape of
    // guard for a panel whose only reason to sort would have been to SCAN FOR AN
    // EXTREME — and `oldestAgeDays` / `oldestBlockLoc` are the payload's, so a scan
    // would have been a second definition of "the oldest pile".
    //
    // The printed summary legitimately sorts: its per-band block list reads oldest
    // first, which is an ORDER, not a statistic. So the ban moves onto what actually
    // matters — a sorted list may be MAPPED, never INDEXED. `sort(...)[0]` is how a
    // scan for an extreme is spelled, and it is still refused here; the two extremes
    // must still be read from `total`, which the check above this one requires.
    assert.ok(body.includes('total.oldestAgeDays'), 'the oldest age is no longer the published one');
    assert.ok(
      !/\.sort\([\s\S]{0,200}?\)\s*\[\s*0\s*\]/.test(body),
      'the age panel indexes a sorted list — that is scanning for an extreme, and the payload publishes it',
    );
    assert.ok(
      !/Math\.(min|max)\s*\(/.test(body),
      'the age panel picks an extreme itself — the payload publishes `oldestAgeDays`',
    );
  });

  check('no lens or shared file spells a `.lens-band-*`/`.lens-age-*` class itself', () => {
    for (const rel of ALL_LENS_FILES) {
      if (rel === RAMP) continue; // the one place either prefix is declared
      const body = code(rel);
      assert.ok(
        !/['"`]lens-band-\$?\{?\d|['"`]lens-age-/.test(body),
        `${rel} builds a ramp class by hand — it must come from rampClass()`,
      );
    }
    assert.ok(code(RAMP).includes("cost: 'lens-band-'"), 'the cost prefix left lens-ramp.ts');
    assert.ok(code(RAMP).includes("age: 'lens-age-'"), 'the age prefix left lens-ramp.ts');
  });

  check('the band bounds rendered are the payload\'s own `lowerPhp`/`upperPhp`', () => {
    const body = code(SETTINGS);
    assert.ok(body.includes('band.lowerPhp') || body.includes('lowerPhp'), 'the label builder invents its bounds');
    assert.ok(
      !/roundedUpPhp\s*[+-]\s*\w+\s*;/.test(body.replace(/Math\.round\([^)]*\)/g, '')),
      'a bound is reconstructed from R + an offset instead of read from the band',
    );
  });
}

// ===========================================================================
console.log('\n3. THE ENTRY POINT IS GATED ON THE EFFECTIVE PRICE FLAG');
// ===========================================================================

{
  const grid = code(GRID);

  check('the grid still derives ONE effective flag: server gate AND the toggle', () => {
    assert.ok(
      /const canViewPrices\s*=\s*serverCanViewPrices\s*&&\s*showPrices;/.test(grid),
      'the effective price flag is gone or was re-spelled',
    );
  });

  check('lens capabilities are built from that effective flag, not from the server flag', () => {
    assert.ok(
      /const lensCaps\s*=\s*useMemo\(\(\)\s*=>\s*\(\{\s*canViewPrices\s*\}\)/.test(grid),
      'lensCaps is not `{ canViewPrices }` — check it is not reading serverCanViewPrices',
    );
    const capsAt = grid.indexOf('const lensCaps');
    const effAt = grid.indexOf('const canViewPrices = serverCanViewPrices');
    assert.ok(effAt > 0 && capsAt > effAt, 'lensCaps is derived before the effective flag exists');
    assert.ok(
      !/lensCaps[\s\S]{0,120}serverCanViewPrices/.test(grid),
      'lensCaps reads the raw server flag — the Prices toggle would not hide the lens',
    );
  });

  check('the Highlight button renders ONLY when some lens canShow for this reader', () => {
    assert.ok(grid.includes('const lensOptions'), 'lensOptions is gone');
    assert.ok(grid.includes('visibleLenses(lensCaps)'), 'the registry is not consulted for what to offer');
    assert.ok(
      /\{lensOptions\.length > 0 && \(/.test(grid),
      'the Highlight button is not behind `lensOptions.length > 0`',
    );
  });

  check('the Highlight button is NOT gated on the price flag — the AGE lens keeps it for Production', () => {
    // It used to be price-gated in effect, because Price was the only lens and its
    // `canShow` is the price flag. The age lens carries no ₱, so the button must now
    // reach every role — and the gate must still be the REGISTRY, not a role test.
    const at = grid.indexOf('{lensOptions.length > 0 && (');
    assert.ok(at > 0, 'the Highlight button block moved');
    const block = grid.slice(at, at + 1600);
    assert.ok(
      !/canViewPrices|showPrices|serverCanViewPrices/.test(block),
      'the Highlight button reads a price flag directly — Production would lose the age lens',
    );
    assert.ok(
      !/'Production'|role\s*===/.test(block),
      'the Highlight button tests a role — `canShow` is the one place that decision lives',
    );
  });

  check('the AGE lens is offered to EVERY role — `canShow: () => true`, and no price gate anywhere in it', () => {
    const body = code(AGE_PANEL);
    assert.ok(/canShow:\s*\(\)\s*=>\s*true/.test(body), 'AGE_LENS.canShow is not unconditional');
    assert.ok(
      !/canViewPrices/.test(body),
      'the age panel mentions canViewPrices — there is no money in its payload and Production is the role that walks the yard',
    );
    assert.ok(
      !/canViewPrices/.test(code(AGE_SETTINGS)),
      'the age settings module mentions canViewPrices',
    );
  });

  check('the PRICE lens is STILL gated on `caps.canViewPrices`, in both places', () => {
    const body = code(PANEL);
    assert.ok(
      /canShow:\s*\(caps\)\s*=>\s*caps\.canViewPrices/.test(body),
      'PRICE_LENS.canShow no longer reads the price capability',
    );
    assert.ok(
      /if\s*\(!caps\.canViewPrices\)\s*return null;/.test(body),
      'the panel has no render-time belt-and-braces guard',
    );
  });

  check('a lens the reader may not be offered FALLS BACK to one they can see, quietly', () => {
    // Flipping Prices off with the Price lens open, and a shared `?lens=price` opened
    // by Production, are the same situation: the id stops resolving. The panel now
    // switches to the first lens this reader CAN see (Age) instead of closing, and
    // closes only when there is nothing left — and the tint is dropped either way.
    const at = grid.indexOf('if (!lensId || activeLens) return;');
    assert.ok(at > 0, 'nothing handles a lens that stopped resolving (flip Prices off → tints would stay)');
    const body = grid.slice(at, at + 400);
    assert.ok(body.includes('setLensClassifier({ fn: null })'), 'the previous lens\'s tint is not dropped');
    assert.ok(
      /lensOptions\.length > 0 \? lensOptions\[0\]\.id : null/.test(body),
      'it does not fall back to a lens this reader can see',
    );
    assert.ok(!/errorToast|toast\(/.test(body), 'the fallback shouts — it is a fact about the reader');
    const reg = code(REGISTRY);
    assert.ok(
      /return found\.canShow\(caps\)\s*\?\s*found\s*:\s*null;/.test(reg),
      'resolveLens does not refuse a lens this reader may not see',
    );
    assert.ok(
      !/BLOCKING_LENSES\[0\]/.test(reg),
      'resolveLens itself substitutes a lens — that decision belongs to the grid, which also clears the tint',
    );
  });

  check('`prices_hidden` closes the lens QUIETLY — never an error toast', () => {
    const body = code(PANEL);
    const occurrences = body.split("'prices_hidden'").length - 1;
    assert.ok(occurrences >= 2, 'the prices_hidden branch is missing from one of the two reads');
    for (const m of body.matchAll(/reason === 'prices_hidden'\)\s*\{([\s\S]{0,160}?)\}/g)) {
      assert.ok(m[1].includes('closeRef.current()'), 'a prices_hidden branch does not close the lens');
      assert.ok(!m[1].includes('errorToast'), 'a prices_hidden branch raises an error toast');
      assert.ok(!m[1].includes('Refusal'), 'a prices_hidden branch renders a banner');
    }
  });
}

// ===========================================================================
console.log('\n4. MUTUAL EXCLUSIVITY AND THE DEEP LINK');
// ===========================================================================

{
  const grid = code(GRID);

  // RESTATED 2026-09-21. The rule is unchanged — opening a lens still clears the
  // supplier — but it is now applied in ONE `router.replace`, by the ROUTE, because two
  // navigations built from the same stale `searchParams` disagreed about whether `lens`
  // was in the URL and the flip-flop remounted the lens panel mid-fetch. So the
  // assertion moved from "openLens calls the supplier writer" to "openLens issues ONE
  // write, and the route's lens writer drops `supplier` in the same params".
  check('opening a lens resets the status filter and issues ONE navigation', () => {
    const at = grid.indexOf('const openLens');
    assert.ok(at > 0, 'openLens is gone');
    const body = grid.slice(at, at + 900);
    assert.ok(body.includes("setStatusFilter('ALL')"), 'openLens does not reset the status spotlight');
    assert.ok(
      !body.includes('onSupplierFilterChange?.(null)'),
      'openLens writes the supplier param too — that is TWO navigations in one tick, which is the bug',
    );
    assert.ok(body.includes('lensWriterRef.current?.(id)'), 'openLens no longer writes the lens param');
  });

  check('the ROUTE applies the exclusivity: one interaction, one router.replace', () => {
    const route = code(ROUTE);
    const lensAt = route.indexOf('const handleLensChange');
    assert.ok(lensAt > 0, 'handleLensChange is gone');
    const lensBody = route.slice(lensAt, lensAt + 900);
    assert.ok(
      lensBody.includes("params.delete('supplier')"),
      'opening a lens does not clear the supplier in the SAME URLSearchParams',
    );
    assert.strictEqual(
      (lensBody.match(/router\.replace\(/g) ?? []).length,
      1,
      'handleLensChange issues more than one navigation',
    );
    const supAt = route.indexOf('const handleSupplierChange');
    const supBody = route.slice(supAt, supAt + 900);
    assert.ok(
      supBody.includes("params.delete('lens')"),
      'picking a supplier does not clear the lens in the SAME URLSearchParams',
    );
    assert.strictEqual(
      (supBody.match(/router\.replace\(/g) ?? []).length,
      1,
      'handleSupplierChange issues more than one navigation',
    );
  });

  check('a status/lab chip closes the lens', () => {
    const at = grid.indexOf('const handleToggleStatus');
    const body = grid.slice(at, at + 400);
    assert.ok(body.includes('closeLens()'), 'clicking a status chip leaves the lens painting the grid');
  });

  // RESTATED 2026-09-21, same reason as above: the tint is dropped on the click frame,
  // but the URL is written ONCE, by the route. `closeLens()` here would be the second
  // navigation that caused the stall.
  check('choosing a supplier drops the lens tint on the same frame', () => {
    const at = grid.indexOf('const handleSupplierSelect');
    const body = grid.slice(at, at + 700);
    assert.ok(
      body.includes('setLensClassifier({ fn: null })'),
      'picking a supplier leaves the lens painting the grid',
    );
    assert.ok(
      !body.includes('closeLens()'),
      'handleSupplierSelect writes the lens param too — TWO navigations in one tick',
    );
  });

  check('the lens class takes precedence over both spotlights on every cell', () => {
    const hits = grid.match(/lensClass \?\? supplierClass \?\? getSpotlightClass/g) ?? [];
    assert.equal(hits.length, 2, 'the occupied and empty cell branches do not both prefer the lens class');
  });

  check('an UNPRICED block is left un-lensed — never painted as the cheapest band', () => {
    const body = code(PANEL);
    assert.ok(
      /band === undefined \? null :/.test(body),
      'the classifier no longer returns null for a block absent from bandByBlock',
    );
    assert.ok(body.includes('lens.unpriced'), 'the panel never reports the unpriced population');
  });

  check('an UNDATED block is left un-lensed — never painted as the FRESHEST band', () => {
    // The same rule in its third costume: "we don't know how old this is" is not
    // "brand new", exactly as ₱0 was never "free".
    const body = code(AGE_PANEL);
    assert.ok(
      /band === undefined\s*\n?\s*\? null/.test(body),
      'the age classifier no longer returns null for a block absent from bandByBlock',
    );
    assert.ok(body.includes('lens.undated'), 'the age panel never reports the undated population');
    assert.ok(
      body.includes('LensExcludedRow'),
      'the undated population is not on its own row — it must never sit inside a band',
    );
  });

  check('the cell TOOLTIP extends the title the cell already has — no new hover system', () => {
    // 220 cells; adding a real tooltip to each is a different and much more expensive
    // decision. The lens contributes one line to the EXISTING native `title`.
    const t = code(TYPES);
    assert.ok(t.includes('title?: string'), 'a classification can no longer carry a title line');
    assert.ok(t.includes('export function resolveLensCellTitle'), 'the title resolver is gone');
    assert.ok(grid.includes('resolveLensCellTitle(lensClassifier, locKey)'), 'the grid never asks for it');
    assert.ok(
      /const title = \[lensTitle, supplierMix\]\.filter\(Boolean\)\.join\(' · '\) \|\| undefined;/.test(grid),
      'the lens title REPLACES the supplier mix instead of joining it (or the empty case is not undefined)',
    );
    assert.ok(
      !/Tooltip|onMouseEnter/.test(grid.slice(grid.indexOf('function OccupiedCell'), grid.indexOf('function OccupiedCell') + 2000)),
      'a hover mechanism was added to the cell',
    );
    // And a block the lens cannot place says nothing at all.
    assert.equal(resolveLensCellTitle(null, 'A-1A'), null);
    assert.equal(resolveLensCellTitle(() => null, 'A-1A'), null);
    assert.equal(resolveLensCellTitle(() => ({ dimmed: true }), 'A-1A'), null);
    assert.equal(resolveLensCellTitle(() => ({ title: '12.0 days old' }), 'A-1A'), '12.0 days old');
  });

  check('`?lens=` drives the panel, and band selection deliberately does NOT', () => {
    const route = code(ROUTE);
    assert.ok(route.includes("searchParams.get('lens')"), 'the route does not read ?lens=');
    assert.ok(route.includes('lensId={selectedLens}'), 'the route does not pass the lens id down');
    assert.ok(route.includes('onLensChange={handleLensChange}'), 'the route does not pass the writer down');
    assert.ok(!route.includes("get('band')"), 'band selection leaked into the URL');
  });
}

// ===========================================================================
console.log('\n5. THE STORED SETTINGS ARE UNTRUSTED — proven by running the parser');
// ===========================================================================

{
  check('a hostile document is salvaged FIELD BY FIELD, not thrown away whole', () => {
    const parsed = parsePriceLensSettings({
      basis: 'whatever',              // unknown          → default
      trailingDays: 99_999,           // out of range     → default
      manualPrice: -5,                // not positive     → null
      edgeOffsets: ['x', 1.5, 700, -1, -1, 0], // junk dropped, rest kept
      bandNames: { 'not a key': 'x', '*:-1': '  Cheap stock  ', ok: 12 },
      unit: 'tonnes',                 // unknown          → default
    });
    assert.equal(parsed.basis, DEFAULT_PRICE_LENS_SETTINGS.basis);
    assert.equal(parsed.trailingDays, DEFAULT_PRICE_LENS_SETTINGS.trailingDays);
    assert.equal(parsed.manualPrice, null);
    assert.deepEqual(parsed.edgeOffsets, [-1, 0], 'the good edges were not salvaged');
    assert.deepEqual(parsed.bandNames, { '*:-1': 'Cheap stock' }, 'band names were not sanitised');
    assert.equal(parsed.unit, DEFAULT_PRICE_LENS_SETTINGS.unit);
  });

  // RESTATED 2026-09-22, and the change is one word. The shipped default basis moved from
  // `this_month` to `this_quarter` — the owner's *"on first load, default to the current
  // quarter's average"* — so a CORRUPT or ABSENT stored document now lands there. The
  // assertion is pinned to the constant rather than to a literal precisely so a future flip
  // has to be a deliberate edit of the default and not of six scattered strings; the literal
  // below it is what makes the constant itself checkable.
  check('a non-object, an array and null all parse to the shipped defaults', () => {
    for (const junk of [null, undefined, 42, 'nope', ['a'], true]) {
      const p = parsePriceLensSettings(junk);
      assert.deepEqual(p.edgeOffsets, [-1, 0]);
      assert.equal(p.basis, DEFAULT_PRICE_LENS_SETTINGS.basis);
      assert.equal(p.unit, 'kg');
    }
  });

  check('the SHIPPED DEFAULT basis is `this_quarter` (2026-09-22)', () => {
    assert.equal(
      DEFAULT_PRICE_LENS_SETTINGS.basis,
      'this_quarter',
      'a first-time price lens no longer opens on the current quarter to date',
    );
    // It must be a basis the select actually OFFERS, and one the market-bases function
    // returns — otherwise a first-time reader opens on a row that does not exist.
    assert.ok(
      PRICE_LENS_BASIS_ORDER.includes('this_quarter'),
      'the shipped default is not in the select\'s own order',
    );
    assert.equal(PRICE_LENS_BASIS_LABELS.this_quarter, "This quarter's deliveries");
    // ⚠️ A SAVED PREFERENCE IS UNTOUCHED — the flip changes the DEFAULT and the corrupt
    // fallback, nothing else. Proven by round-tripping a stored basis through the parser.
    for (const stored of ['this_month', 'last_month', 'last_3_months', 'trailing_days', 'manual']) {
      assert.equal(
        parsePriceLensSettings({ basis: stored }).basis,
        stored,
        `a stored basis \`${stored}\` was overwritten by the new default`,
      );
    }
    // And a non-default basis is still SERIALIZED, so it survives a save/load round trip.
    assert.equal(
      serializePriceLensSettings({ ...DEFAULT_PRICE_LENS_SETTINGS, basis: 'this_month' }).basis,
      'this_month',
      'a reader who chose this month would stop being stored',
    );
    // The default itself is OMITTED from the stored document, which is what makes "reset"
    // an actual removal rather than a value that lingers.
    assert.ok(
      !('basis' in serializePriceLensSettings(DEFAULT_PRICE_LENS_SETTINGS)),
      'the default basis is written into the stored document',
    );
  });

  check('an edge list that survives validation EMPTY falls back to the default pair', () => {
    const p = parsePriceLensSettings({ edgeOffsets: [1.5, 'x', 9999] });
    assert.deepEqual(p.edgeOffsets, [-1, 0], 'the lens was left with no bands at all');
  });

  check('a stored list over the cap is refused rather than truncated silently', () => {
    const p = parsePriceLensSettings({ edgeOffsets: [-6, -5, -4, -3, -2, -1, 0] }); // 7 > 6
    assert.deepEqual(p.edgeOffsets, [-1, 0], 'a 7-edge document was accepted or silently cut');
  });

  check('a band name is capped and trimmed — an unbounded string cannot reach a row', () => {
    const p = parsePriceLensSettings({ bandNames: { '0:*': ' ' + 'x'.repeat(200) } });
    assert.equal(p.bandNames['0:*'].length, 40);
  });

  check('serialize OMITS defaults, so "reset" is a REMOVAL and not a lingering value', () => {
    assert.deepEqual(serializePriceLensSettings(DEFAULT_PRICE_LENS_SETTINGS), {});
    assert.ok(isDefaultPriceLensSettings(DEFAULT_PRICE_LENS_SETTINGS));
    const body = serializePriceLensSettings({ ...DEFAULT_PRICE_LENS_SETTINGS, unit: 'blocks' });
    assert.deepEqual(body, { unit: 'blocks' });
  });

  check('parse ∘ serialize is a round trip for a customised document', () => {
    const custom = {
      ...DEFAULT_PRICE_LENS_SETTINGS,
      basis: 'trailing_days' as const,
      trailingDays: 90,
      manualPrice: 41.25,
      edgeOffsets: [-10, -1, 0, 5],
      bandNames: { '0:*': 'Dear' },
      unit: 'blocks' as const,
    };
    assert.deepEqual(parsePriceLensSettings(serializePriceLensSettings(custom)), custom);
  });

  // ── The AGE lens's stored document, proven the same way ────────────────────
  check('an AGE document is salvaged FIELD BY FIELD, not thrown away whole', () => {
    const parsed = parseAgeLensSettings({
      edgeDays: ['x', 59.5, 0, -30, 6000, 120, 120, 60], // junk dropped, rest kept + de-duped
      bandNames: { 'not a key': 'x', '0:60': '  Feed these first  ', '-1:*': 'no', ok: 12 },
      unit: 'tonnes', // unknown → default
    });
    assert.deepEqual(parsed.edgeDays, [60, 120], 'the good cut lines were not salvaged');
    assert.deepEqual(
      parsed.bandNames,
      { '0:60': 'Feed these first' },
      'band names were not sanitised (a negative lower bound is impossible for an age band)',
    );
    assert.equal(parsed.unit, DEFAULT_AGE_LENS_SETTINGS.unit);
  });

  check('an AGE non-object, array and null all parse to the shipped 60/120/365 default', () => {
    for (const junk of [null, undefined, 42, 'nope', ['a'], true]) {
      const parsed = parseAgeLensSettings(junk);
      assert.deepEqual(parsed.edgeDays, [60, 120, 365]);
      assert.equal(parsed.unit, 'kg');
      assert.deepEqual(parsed.bandNames, {});
    }
  });

  check('an AGE edge list that survives EMPTY, or over the cap, falls back to the default', () => {
    assert.deepEqual(parseAgeLensSettings({ edgeDays: [0, -5, 9999, 1.5] }).edgeDays, [60, 120, 365]);
    assert.deepEqual(
      parseAgeLensSettings({ edgeDays: [15, 30, 45, 60, 90, 120, 365] }).edgeDays, // 7 > 6
      [60, 120, 365],
      'a 7-cut-line document was accepted or silently cut',
    );
  });

  check('an AGE band name is capped and trimmed', () => {
    const parsed = parseAgeLensSettings({ bandNames: { '365:*': ' ' + 'x'.repeat(200) } });
    assert.equal(parsed.bandNames['365:*'].length, 40);
  });

  check('AGE serialize OMITS defaults, and parse ∘ serialize round-trips', () => {
    assert.deepEqual(serializeAgeLensSettings(DEFAULT_AGE_LENS_SETTINGS), {});
    assert.ok(isDefaultAgeLensSettings(DEFAULT_AGE_LENS_SETTINGS));
    assert.deepEqual(serializeAgeLensSettings({ ...DEFAULT_AGE_LENS_SETTINGS, unit: 'blocks' }), {
      unit: 'blocks',
    });
    const custom = {
      edgeDays: [30, 90, 365, 730],
      bandNames: { '730:*': 'Ancient' },
      unit: 'blocks' as const,
    };
    assert.deepEqual(parseAgeLensSettings(serializeAgeLensSettings(custom)), custom);
  });

  check('the two lenses store under DIFFERENT module keys, so neither save erases the other', () => {
    assert.notEqual(PRICE_LENS_ID, AGE_LENS_ID);
    // `saveUserModuleSettings` REPLACES the row, so a shared key would be destructive.
    assert.ok(
      /blocking_lens_\$\{lensId\}/.test(code(STORE)),
      'the module key is not derived from the lens id',
    );
  });

  check('the settings live in `user_table_settings` under `blocking_lens_<id>` — no new table', () => {
    const body = code(STORE);
    assert.ok(/blocking_lens_\$\{lensId\}/.test(body), 'the module key is not per lens');
    assert.ok(body.includes('getUserModuleSettings') && body.includes('saveUserModuleSettings'),
      'the shape-agnostic pair is not used');
    assert.ok(!/\.from\(/.test(body), 'the hook queries a table directly');
    assert.ok(!/createClient/.test(body), 'the hook builds its own Supabase client');
  });

  check('storage is read in an EFFECT, never a lazy initialiser (hydration)', () => {
    const body = code(STORE);
    assert.ok(
      !/useState[^;]*localStorage/.test(body),
      'localStorage is read during render — that is an SSR/CSR hydration mismatch',
    );
    assert.ok(/useEffect\([\s\S]{0,400}localStorage\.getItem/.test(body), 'the hydrate effect is gone');
  });

  check('every storage touch is INSIDE a try — a blocked store is a working panel', () => {
    const body = code(STORE);
    const touches = [...body.matchAll(/localStorage\.(getItem|setItem|removeItem)/g)];
    assert.ok(touches.length >= 3, 'the storage calls moved');
    // For each touch, the nearest preceding `try {` must be more recent than the
    // nearest preceding `catch` — i.e. we are still inside a guarded block. Crude,
    // but it is exactly the regression worth catching: a bare `localStorage.setItem`
    // added later, outside every guard.
    for (const m of touches) {
      const before = body.slice(0, m.index);
      const lastTry = before.lastIndexOf('try {');
      const lastCatch = before.lastIndexOf('catch');
      assert.ok(
        lastTry > lastCatch,
        `an unguarded ${m[0]} — a private window or a full quota would throw`,
      );
    }
  });
}

// ===========================================================================
console.log('\n6. SETTINGS ARITHMETIC — edges, labels and the colour ramp');
// ===========================================================================

{
  check('edges de-duplicate and sort, and junk is dropped', () => {
    assert.deepEqual(normalizeEdgeOffsets([0, -1, 0, -1, 5]), [-1, 0, 5]);
    assert.deepEqual(normalizeEdgeOffsets([1.5, NaN, Infinity, 99, -99, 3]), [3]);
    assert.deepEqual(normalizeEdgeOffsets('nope'), []);
  });

  check('adding a 7th DISTINCT edge is refused, with a reason', () => {
    const six = [-5, -3, -1, 0, 2, 4];
    const res = addEdgeOffset(six, 7);
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.message.includes('6'), 'the refusal does not name the cap');
  });

  check('a duplicate edge and a non-integer edge are both refused', () => {
    assert.equal(addEdgeOffset([-1, 0], 0).ok, false);
    assert.equal(addEdgeOffset([-1, 0], 1.5).ok, false);
    assert.equal(addEdgeOffset([-1, 0], 51).ok, false);
  });

  check('the LAST edge cannot be removed — one band is the same picture as no lens', () => {
    assert.deepEqual(removeEdgeOffset([-1, 0], -1), { ok: true, edgeOffsets: [0] });
    const res = removeEdgeOffset([0], 0);
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.message.length > 20, 'the refusal has no human sentence');
  });

  check('BOTH default edges are removable (neither -1 nor 0 is privileged)', () => {
    assert.equal(removeEdgeOffset([-1, 0], 0).ok, true);
    assert.equal(removeEdgeOffset([-1, 0], -1).ok, true);
  });

  check('a typed ₱ is validated: positive, finite, at most two decimals', () => {
    assert.deepEqual(parseManualPriceInput('40.25'), { ok: true, value: 40.25 });
    assert.deepEqual(parseManualPriceInput('40'), { ok: true, value: 40 });
    assert.equal(parseManualPriceInput('0').ok, false, 'a ₱0 market would put every block above market');
    assert.equal(parseManualPriceInput('-4').ok, false);
    assert.equal(parseManualPriceInput('40.256').ok, false);
    assert.equal(parseManualPriceInput('').ok, false);
    assert.equal(parseManualPriceInput('forty').ok, false);
  });

  check('the ramp always uses BOTH ENDS, whatever the band count', () => {
    for (let n = 2; n <= PRICE_LENS_RAMP_STOPS; n += 1) {
      assert.equal(bandRampStop(0, n), 0, `${n} bands: the cheapest is not the ramp's cool end`);
      assert.equal(bandRampStop(n - 1, n), PRICE_LENS_RAMP_STOPS - 1, `${n} bands: the dearest is not the hot end`);
    }
    // The default three-band lens must NOT take the ramp's first three stops.
    assert.deepEqual([0, 1, 2].map((i) => bandRampStop(i, 3)), [0, 3, 6]);
    assert.equal(bandRampClass(2, 3), 'lens-band-6');
  });

  check('the ramp is MONOTONE — a dearer band is never a cooler colour', () => {
    for (let n = 2; n <= PRICE_LENS_RAMP_STOPS; n += 1) {
      for (let i = 1; i < n; i += 1) {
        assert.ok(bandRampStop(i, n) > bandRampStop(i - 1, n), `${n} bands: stop ${i} did not advance`);
      }
    }
  });

  check("the three DEFAULT bands read in the owner's own words", () => {
    const R = 40;
    assert.equal(priceBandLabel({ lowerPhp: null, upperPhp: 39 }, R), 'Below market, under ₱39');
    assert.equal(priceBandLabel({ lowerPhp: 39, upperPhp: 40 }, R), 'At market, ₱39.00 to ₱39.99');
    assert.equal(priceBandLabel({ lowerPhp: 40, upperPhp: null }, R), 'Above market, ₱40 and up');
  });

  check('an EXTRA band gets a plain bound label, not a borrowed "market" word', () => {
    const R = 40;
    assert.equal(priceBandLabel({ lowerPhp: 45, upperPhp: null }, R), '₱45 and up');
    assert.equal(priceBandLabel({ lowerPhp: null, upperPhp: 30 }, R), 'Under ₱30');
    assert.equal(priceBandLabel({ lowerPhp: 30, upperPhp: 39 }, R), '₱30.00 to ₱38.99');
  });

  check('a name the reader typed always wins, and follows its OWN interval', () => {
    const R = 40;
    const names = { [bandEdgeKey(null, -1)]: 'Bargains' };
    assert.equal(priceBandLabel({ lowerPhp: null, upperPhp: 39 }, R, names), 'Bargains');
    // Adding a cut line below changes the band's own lower offset, so the name does
    // NOT follow — which is the point of keying on the interval rather than the index.
    assert.equal(priceBandLabel({ lowerPhp: 30, upperPhp: 39 }, R, names), '₱30.00 to ₱38.99');
  });

  check('a blank name falls back to the generated label rather than an empty row', () => {
    assert.equal(
      priceBandLabel({ lowerPhp: 40, upperPhp: null }, 40, { '0:*': '   ' }),
      'Above market, ₱40 and up',
    );
  });
}

// ===========================================================================
console.log('\n6b. AGE SETTINGS ARITHMETIC — cut lines in DAYS, and the labels');
// ===========================================================================

{
  check('age cut lines de-duplicate and sort, and junk is dropped', () => {
    assert.deepEqual(normalizeEdgeDays([365, 60, 120, 60, 365]), [60, 120, 365]);
    assert.deepEqual(normalizeEdgeDays([59.5, NaN, Infinity, 0, -1, 5001, 90]), [90]);
    assert.deepEqual(normalizeEdgeDays('nope'), []);
  });

  check('adding a 7th DISTINCT age cut line is refused, with a reason naming the cap', () => {
    const six = [30, 60, 90, 120, 180, 365];
    const res = addEdgeDay(six, 730);
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.message.includes('6'), 'the refusal does not name the cap');
  });

  check('a duplicate, a zero, a negative, a fractional and an over-5000 cut line are all refused', () => {
    assert.equal(addEdgeDay([60, 120], 60).ok, false);
    assert.equal(addEdgeDay([60, 120], 0).ok, false, 'day 0 is where band 0 already starts');
    assert.equal(addEdgeDay([60, 120], -30).ok, false);
    assert.equal(addEdgeDay([60, 120], 59.5).ok, false);
    assert.equal(addEdgeDay([60, 120], 5001).ok, false);
    assert.equal(addEdgeDay([60, 120], 5000).ok, true, '5,000 days is the documented ceiling, inclusive');
  });

  check('the LAST age cut line cannot be removed — one band is the same picture as no lens', () => {
    assert.deepEqual(removeEdgeDay([60, 120], 60), { ok: true, edgeDays: [120] });
    const res = removeEdgeDay([365], 365);
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.message.length > 20, 'the refusal has no human sentence');
  });

  check('every DEFAULT age cut line is removable (none of 60/120/365 is privileged)', () => {
    for (const d of [60, 120, 365]) {
      assert.equal(removeEdgeDay([60, 120, 365], d).ok, true, `${d} is not removable`);
    }
  });

  check('a typed age cut line is validated: whole, positive, at most four digits', () => {
    assert.deepEqual(parseEdgeDayInput('90'), { ok: true, value: 90 });
    assert.equal(parseEdgeDayInput('').ok, false);
    assert.equal(parseEdgeDayInput('-30').ok, false);
    assert.equal(parseEdgeDayInput('59.5').ok, false);
    assert.equal(parseEdgeDayInput('ninety').ok, false);
    assert.equal(parseEdgeDayInput('50000').ok, false);
  });

  check('the quick-add cuts are the ones people ask for, and all are legal cut lines', () => {
    assert.deepEqual([...AGE_LENS_QUICK_CUTS], [30, 60, 90, 120, 180, 365, 730]);
    for (const d of AGE_LENS_QUICK_CUTS) {
      assert.equal(addEdgeDay([], d).ok, true, `${d} is offered but would be refused`);
    }
  });

  check("the four DEFAULT age bands read in days, and the year bound reads as a year", () => {
    assert.equal(ageBandLabel({ lowerDays: 0, upperDays: 60 }), 'Up to 60 days');
    assert.equal(ageBandLabel({ lowerDays: 60, upperDays: 120 }), '60 to 120 days');
    assert.equal(ageBandLabel({ lowerDays: 120, upperDays: 365 }), '120 to 365 days');
    assert.equal(ageBandLabel({ lowerDays: 365, upperDays: null }), 'Over 1 year');
  });

  check('only an EXACT multiple of 365 reads as years — a near-miss stays in days', () => {
    assert.equal(yearWord(365), '1 year');
    assert.equal(yearWord(730), '2 years');
    assert.equal(yearWord(1095), '3 years');
    assert.equal(yearWord(400), null, 'a 400-day cut line must not be rounded to "1 year"');
    assert.equal(yearWord(1), null);
    assert.equal(ageBandLabel({ lowerDays: 400, upperDays: null }), 'Over 400 days');
    assert.equal(ageBandLabel({ lowerDays: 0, upperDays: 365 }), 'Up to 1 year');
    assert.equal(ageBandLabel({ lowerDays: 365, upperDays: 730 }), '1 year to 2 years');
    assert.equal(
      ageBandLabel({ lowerDays: 120, upperDays: 730 }),
      '120 to 730 days',
      'a mixed span must not print one bound in years and the other in days',
    );
  });

  check('an age band NEVER reads as 0 days, and its lower bound is never null', () => {
    // `lowerDays` is 0 on the first band as a LABEL, and the label says "Up to N"
    // rather than "0 to N" — the reader is not told the yard contains 0-day charcoal.
    assert.ok(
      !/^0\b/.test(ageBandLabel({ lowerDays: 0, upperDays: 60 })),
      'the freshest band reads as "0 to 60 days" — the yard does not contain 0-day charcoal',
    );
    assert.equal(ageBandLabel({ lowerDays: 0, upperDays: 60 }), 'Up to 60 days');
    assert.equal(bandDayKey(0, 60), '0:60');
    assert.equal(bandDayKey(365, null), '365:*', 'the open upper end is not keyed as *');
  });

  check('a name the reader typed wins, and follows its OWN interval', () => {
    const names = { [bandDayKey(365, null)]: 'Ancient' };
    assert.equal(ageBandLabel({ lowerDays: 365, upperDays: null }, names), 'Ancient');
    // Adding a cut line above changes the band's own interval, so the name does NOT
    // follow — which is the point of keying on the interval rather than the index.
    assert.equal(ageBandLabel({ lowerDays: 365, upperDays: 730 }, names), '1 year to 2 years');
    assert.equal(ageBandLabel({ lowerDays: 365, upperDays: null }, { '365:*': '   ' }), 'Over 1 year');
  });
}

// ===========================================================================
console.log('\n7. THE FRAME — registry shape, Escape, and the classifier seam');
// ===========================================================================

{
  check('the registry is a list of definitions with the six required fields', () => {
    const reg = code(REGISTRY);
    assert.ok(/export const BLOCKING_LENSES:\s*readonly BlockingLensDefinition\[\]/.test(reg),
      'BLOCKING_LENSES is gone or lost its type');
    assert.ok(reg.includes('export function visibleLenses'), 'visibleLenses is gone');
    assert.ok(reg.includes('export function resolveLens'), 'resolveLens is gone');
    const t = code(TYPES);
    for (const field of ['id:', 'label:', 'icon:', 'ramp:', 'canShow:', 'Panel:']) {
      assert.ok(t.includes(field), `BlockingLensDefinition lost \`${field}\``);
    }
  });

  // RESTATED 2026-09-22: a THIRD lens joined the registry, so this no longer pins a
  // two-element list. Same three rules: the order is TAB order, Price stays FIRST (it is
  // a price-viewer's default), and every id is its own `?lens=` value.
  check('THREE lenses are registered — Price, Age, Supplier IN THAT ORDER', () => {
    assert.equal(PRICE_LENS_ID, 'price');
    assert.equal(AGE_LENS_ID, 'age');
    assert.equal(SUPPLIER_LENS_ID, 'supplier');
    const reg = code(REGISTRY);
    assert.ok(
      /BLOCKING_LENSES[^=]*=\s*\[\s*PRICE_LENS,\s*AGE_LENS,\s*SUPPLIER_LENS,?\s*\]/.test(reg),
      'the registry is not exactly [PRICE_LENS, AGE_LENS, SUPPLIER_LENS] — Supplier registers AFTER Age',
    );
    assert.ok(reg.includes("from './age-lens-panel'"), 'the age lens is not imported from its own panel file');
    assert.ok(
      reg.includes("from './supplier-lens-panel'"),
      'the supplier lens is not imported from its own panel file',
    );
  });

  check('⚠️ the SUPPLIER lens reads `canShow: () => true`, like Age and unlike Price', () => {
    // Bands are SUPPLIERS, so the LENS itself is offered to every role including Production
    // — the one that actually walks the yard and knows whose truck came in. Since
    // 2026-09-22 the payload carries exactly two ₱ keys, and the panel reads the effective
    // flag for EXACTLY ONE decision: whether the printed band table's last column is ₱/kg
    // or `Mixed`. That is asserted, narrowly, in section 11a below — here the rule is that
    // nothing about OFFERING the lens depends on it.
    const body = code(SUPPLIER_PANEL);
    assert.ok(
      /canShow: \(\) => true,/.test(body),
      'the supplier lens grew a capability gate — its payload is peso-free apart from two nulled keys',
    );
    assert.ok(
      !/canViewPrices/.test(code(SUPPLIER_SETTINGS)),
      'the supplier settings module mentions canViewPrices',
    );
    // And the PRICE lens still gates, so the asymmetry is deliberate in both directions.
    assert.ok(/canShow: \(caps\) => caps\.canViewPrices,/.test(code(PANEL)), 'the price gate is gone');
  });

  check('each lens declares its OWN ramp, and all three differ', () => {
    assert.equal(PRICE_LENS_RAMP, 'cost');
    assert.equal(AGE_LENS_RAMP, 'age');
    assert.equal(SUPPLIER_LENS_RAMP, 'category');
    assert.equal(new Set([PRICE_LENS_RAMP, AGE_LENS_RAMP, SUPPLIER_LENS_RAMP]).size, 3,
      'two lenses paint on the same scale');
    assert.ok(/ramp:\s*PRICE_LENS_RAMP/.test(code(PANEL)), 'PRICE_LENS does not declare its ramp');
    assert.ok(/ramp:\s*AGE_LENS_RAMP/.test(code(AGE_PANEL)), 'AGE_LENS does not declare its ramp');
    assert.ok(/ramp:\s*SUPPLIER_LENS_RAMP/.test(code(SUPPLIER_PANEL)), 'SUPPLIER_LENS does not declare its ramp');
    // The frame and the grid must know nothing about any scale.
    assert.ok(!/lens-band|lens-age|lens-cat/.test(code(FRAME)), 'the frame hardcodes a ramp class');
    assert.ok(!/lens-band-|lens-age-|lens-cat-/.test(code(GRID)), 'the grid hardcodes a ramp class');
  });

  check('a ramp class is a STOP on its own scale — both ramps use both ends', () => {
    assert.equal(rampClass('cost', 0, 4), 'lens-band-0');
    assert.equal(rampClass('cost', 3, 4), 'lens-band-6');
    assert.equal(rampClass('age', 0, 4), 'lens-age-0');
    assert.equal(rampClass('age', 3, 4), 'lens-age-6');
    // The 4-band age default must not take the first four stops.
    assert.deepEqual([0, 1, 2, 3].map((i) => ageBandRampClass(i, 4)), [
      'lens-age-0', 'lens-age-2', 'lens-age-4', 'lens-age-6',
    ]);
    assert.equal(bandRampClass(2, 3), rampClass('cost', 2, 3));
    assert.equal(LENS_RAMP_CLASS_PREFIX.cost, 'lens-band-');
    assert.equal(LENS_RAMP_CLASS_PREFIX.age, 'lens-age-');
  });

  check('the SHARED pieces are shared — both panels render the same rows, bar, banner and disclosure', () => {
    for (const [name, needle] of [
      ['the legend rows', 'LensBandRows'],
      ['the ratio bar', 'LensRatioBar'],
      ['the kg|blocks switch', 'LensUnitSwitch'],
      ['the in-no-band row', 'LensExcludedRow'],
      ['the refusal banner', 'RefusalBanner'],
      ['the Customize disclosure', 'LensCustomize'],
    ] as const) {
      assert.ok(code(PANEL).includes(needle), `the price lens no longer uses ${name}`);
      assert.ok(code(AGE_PANEL).includes(needle), `the age lens no longer uses ${name}`);
    }
    // ...and neither panel keeps a private copy of one.
    for (const rel of [PANEL, AGE_PANEL]) {
      const body = code(rel);
      assert.ok(!/function RefusalBanner/.test(body), `${rel} re-declares the refusal banner`);
      assert.ok(!/<CollapsibleTrigger/.test(body), `${rel} re-builds the Customize disclosure`);
      assert.ok(!/role="img"/.test(body), `${rel} re-builds the ratio bar`);
      assert.ok(!/role="group"/.test(body), `${rel} re-builds the unit switch`);
    }
    // The debounce is ONE constant, in the shared module.
    assert.ok(/export const LENS_DEBOUNCE_MS = 250;/.test(code(SHARED)), 'the shared debounce is not 250ms');
    for (const rel of [PANEL, AGE_PANEL]) {
      assert.ok(
        /LENS_DEBOUNCE_MS[\s\S]{0,200}from '\.\/lens-shared'/.test(code(rel)) ||
          code(rel).includes("} from './lens-shared'"),
        `${rel} does not import the shared debounce`,
      );
      assert.ok(
        !/const LENS_DEBOUNCE_MS =/.test(code(rel)),
        `${rel} declares its own debounce — two lenses would drift`,
      );
    }
  });

  check('a lens definition carries a hook-free COMPONENT, so switching mounts/unmounts', () => {
    const t = code(TYPES);
    assert.ok(t.includes('Panel: ComponentType<BlockingLensPanelProps>'), 'Panel is not a component type');
    assert.ok(!/useController|useLens\b/.test(t), 'a hook on the definition would break the rules of hooks on a lens switch');
    assert.ok(code(FRAME).includes('key={active.id}'), 'the frame does not key the body by lens id');
  });

  // RESTATED 2026-09-21: the strip became the legend BAR's lens switch, and the
  // one-lens case now falls through to a plain label instead of rendering nothing, so
  // the gate is a ternary rather than an `&&`. Same rule: never a lone or dead tab.
  check('no dead lens switch: it renders only once there is more than one lens', () => {
    assert.ok(/\{lenses\.length > 1 \? \(/.test(code(FRAME)), 'the lens switch is not gated on a real choice');
    assert.ok(!/disabled.*Supplier|Age.*disabled/.test(code(FRAME)), 'a disabled placeholder tab appeared');
    assert.ok(code(FRAME).includes('role="tablist"'), 'the switch is not a real tablist');
  });

  check('Escape steps back one rung and yields to a dismissable layer', () => {
    const body = code(FRAME);
    assert.ok(body.includes('escapeSuppressed'), 'the Escape suppression prop is gone');
    assert.ok(/if \(escapeSuppressed\) return;/.test(body), 'Escape no longer defers to the detail drawer');
    assert.ok(body.includes('data-radix-popper-content-wrapper'), 'Escape no longer yields to a popover/select');
    assert.ok(code(GRID).includes('escapeSuppressed={!!selectedLocKey}'), 'the grid does not suppress while the drawer is open');
  });

  check('the classifier resolver returns null for "leave it un-lensed"', () => {
    assert.equal(resolveLensCellClass(null, 'A-1A'), null);
    assert.equal(resolveLensCellClass(() => null, 'A-1A'), null);
    assert.equal(resolveLensCellClass(() => ({ dimmed: true }), 'A-1A'), 'spotlight-dimmed');
    assert.equal(resolveLensCellClass(() => ({ className: 'lens-band-3' }), 'A-1A'), 'lens-band-3');
    // dimmed WINS: a glow ring on a 30%-opacity cell reads as neither.
    assert.equal(
      resolveLensCellClass(() => ({ className: 'lens-band-3', dimmed: true }), 'A-1A'),
      'spotlight-dimmed',
    );
  });

  check('the grid clears the classifier when the panel goes, so no tint outlives it', () => {
    const grid = code(GRID);
    assert.ok(/const closeLens = useCallback\([\s\S]{0,200}setLensClassifier\(\{ fn: null \}\)/.test(grid),
      'closeLens does not drop the classifier');
    assert.ok(code(PANEL).includes('publishRef.current(null)'), 'the panel does not un-lens on unmount');
  });
}

// ===========================================================================
console.log('\n8. ERRORS AND DOCS');
// ===========================================================================

{
  check('errors go through `errorToast()` — never a raw sonner toast.error, in any lens file', () => {
    for (const rel of ALL_LENS_FILES) {
      const body = code(rel);
      assert.ok(!/toast\.error\s*\(/.test(body), `${rel} calls sonner's toast.error directly`);
    }
    assert.ok(code(PANEL).includes('errorToast('), 'the price panel never reaches for errorToast');
    assert.ok(code(AGE_PANEL).includes('errorToast('), 'the age panel never reaches for errorToast');
  });

  check('an inline refusal carries a Copy button (the error rule, as a banner), for BOTH lenses', () => {
    // Extracted to `lens-refusal-banner.tsx` — one implementation, so neither lens can
    // quietly lose its Copy button.
    const banner = code(BANNER);
    assert.ok(banner.includes('export function RefusalBanner'), 'the inline refusal banner is gone');
    assert.ok(banner.includes('navigator.clipboard.writeText'), 'the banner cannot be copied');
    // No timer and no `duration:` option — only a CSS `duration-150` transition class,
    // which is what the negative lookahead below allows.
    assert.ok(!/setTimeout/.test(banner), 'the banner sets a timer — an error must persist');
    assert.ok(!/duration\s*:/.test(banner), 'the banner carries a dismiss duration');
    for (const rel of [PANEL, AGE_PANEL]) {
      assert.ok(code(rel).includes('<RefusalBanner'), `${rel} does not render the refusal banner`);
      assert.ok(code(rel).includes('onRetry'), `${rel} offers no retry on a refusal`);
    }
  });

  // RESTATED 2026-09-21 — THIS IS THE STALL FIX, and the restatement is the fix.
  // It used to require a MONOTONIC COUNTER (`tokenRef.current !== token`). That guard
  // dropped a reply whose token had merely moved, even when the reply was for exactly
  // the request still wanted, which made a stall unrecoverable. The guard is now the
  // request's SIGNATURE, and the property asserted is the STRONGER one: a reply for
  // what is currently wanted is ALWAYS applied. A stale reply is still discarded.
  check('a reply for the LATEST request is always applied; a stale one is dropped', () => {
    for (const rel of [PANEL, AGE_PANEL]) {
      const body = code(rel);
      assert.ok(body.includes('wantRef'), `${rel}: the race guard is gone`);
      assert.ok(
        /if \(wantRef\.current !== signature\) return;/.test(body),
        `${rel}: the guard is not the request's own signature`,
      );
      assert.ok(
        !/tokenRef/.test(body),
        `${rel}: the monotonic counter is back — it discards replies that are still wanted`,
      );
      assert.ok(body.includes('LENS_DEBOUNCE_MS'), `${rel}: the debounce is gone`);
      assert.ok(body.includes('setTimeout('), `${rel}: subsequent fetches are no longer debounced`);
    }
  });

  check('THE FIRST request is NOT debounced — no timer for a remount to destroy', () => {
    // The 2026-09-21 bug. Every request lived inside a 250 ms `setTimeout` whose
    // cleanup runs on unmount, so a panel remounted within a quarter of a second (it is
    // mounted from a URL param mirrored through `useOptimistic`) never issued one at
    // all: an eternal "Sorting the yard into bands…" with no error and no Retry.
    for (const rel of [PANEL, AGE_PANEL]) {
      const body = code(rel);
      assert.ok(body.includes('firstDoneRef'), `${rel}: nothing distinguishes the first request`);
      assert.ok(
        /if \(!firstDoneRef\.current\) \{[\s\S]{0,200}run\(\);/.test(body),
        `${rel}: the first request is still created inside a timer`,
      );
    }
  });

  check('a STALL is visible and retryable — never an eternal spinner', () => {
    assert.ok(
      code(SHARED).includes('export const LENS_STALL_MS'),
      'there is no shared stall budget',
    );
    for (const rel of [PANEL, AGE_PANEL]) {
      const body = code(rel);
      assert.ok(body.includes('LENS_STALL_MS'), `${rel}: no watchdog`);
      assert.ok(body.includes('setLensStalled'), `${rel}: the stall is not recorded`);
      assert.ok(
        /lensStalled && !lensRefusal/.test(body),
        `${rel}: a stall does not surface as the shared copyable banner`,
      );
    }
    // And the spinner line must YIELD to the banner rather than sit beside it forever.
    assert.ok(
      code(PANEL).includes('{!lens && !lensStalled && marketPhpKg !== null &&'),
      'the price lens still shows "Sorting the yard into bands…" after it has given up',
    );
  });

  check('the TYPED cut line reaches the server, and only for the manual basis', () => {
    const body = code(PANEL);
    assert.ok(
      /manualRoundedUpPhp\(settings\.manualPrice\)/.test(body),
      'the manual basis does not ceil the typed price',
    );
    assert.ok(
      /settings\.basis === 'manual' \? manualRoundedUpPhp/.test(body),
      'a MEASURED basis would send an override — R must stay SQL\'s there',
    );
    assert.ok(
      /roundedUpPhp: number \| null/.test(body),
      'the adapter port does not carry the typed cut line',
    );
    assert.ok(
      /fetchBlockingPriceLens\(price, \[\.\.\.edges\], roundedUpPhp\)/.test(body),
      'the live adapter does not pass the override through',
    );
    // The LABEL must say the right thing too: "₱41 and up is above" for a typed price,
    // "rounds up to ₱40" for a measured one. One sentence for each rule.
    assert.ok(body.includes('and up is above'), 'the typed-price line still says "rounds up to"');
    assert.ok(body.includes('rounds up to'), 'the measured-price line is gone');
  });

  check('a refusal keeps the previous tint — the grid never flashes back to plain', () => {
    for (const rel of [PANEL, AGE_PANEL]) {
      const body = code(rel);
      const at = body.indexOf('setLensRefusal(res.message)');
      assert.ok(at > 0, `${rel}: the refusal is not recorded`);
      const around = body.slice(Math.max(0, at - 400), at + 200);
      assert.ok(
        !around.includes('setLens(null)'),
        `${rel}: a refusal blanks the lens the reader is looking at`,
      );
    }
  });

  check('CONTEXT.md documents the lens UI and how to register a second one', () => {
    const doc = read(CONTEXT);
    for (const phrase of [
      'Price lens — UI',
      'Age lens — UI',
      'lens/registry.ts',
      'lens/types.ts',
      'lens/lens-panel.tsx',
      'lens/price-lens-panel.tsx',
      'lens/price-lens-settings.ts',
      'lens/age-lens-panel.tsx',
      'lens/age-lens-settings.ts',
      'lens/lens-ramp.ts',
      'lens/lens-band-rows.tsx',
      'lens/lens-ratio-bar.tsx',
      'lens/lens-customize.tsx',
      'lens/lens-refusal-banner.tsx',
      'lens/lens-shared.ts',
      'lens/use-lens-settings.ts',
      '`?lens=',
      'blocking_lens_',
      '.lens-band-',
      '.lens-age-',
      'REGISTERING A LENS',
    ]) {
      assert.ok(doc.includes(phrase), `CONTEXT.md does not mention "${phrase}"`);
    }
  });
}

// ===========================================================================
console.log('\n7. THE CONTROL STRIP — FOUR FIXED SECTIONS (2026-09-21, job B)');
// ===========================================================================
//
// The owner's verdict on the live header: the controls *"just move around and
// overflow/wrap into weird locations"* when a mode is switched on. It was one
// `flex-wrap justify-between` row, so anything that grew or shrank by a pixel re-flowed
// every cluster after it. These assertions pin the replacement: a CSS grid with four
// explicit tracks, sections that can only wrap INSIDE themselves, reserved widths for
// everything a toggle changes, and a scrolling wrapper instead of a crush.
//
// ── SECOND PASS (2026-09-21): A `flex-wrap` ROW'S MAX-CONTENT IS ITS ONE-LINE WIDTH ──
// The first pass made all four tracks `minmax(<min>, max-content)` and left section 1 a
// single `flex-wrap` row holding the search AND the seven warehouse chips. Measured in a
// browser, that section's max-content was 620px although it always RENDERS as
// search-over-chips in 444 — so the four tracks asked for 2,174px against 1,766px of
// real room at a 1800px viewport, the grid shrank EVERY track toward its minimum, and
// the two sections that cannot wrap tidily wrapped 4 + 1 (totals) and 3 + 1 (modes)
// while 214px of slack sat stranded inside section 1. Five assertions below were
// RESTATED for that, each noted at its own `check`.

{
  const css = read(GLOBALS);
  const grid = code(GRID);

  // RESTATED (was: "four tracks, minimums [232, 236, 180, 200]"). Two tracks are now
  // sized `max-content` outright rather than `minmax(<min>, max-content)`, because the
  // totals are a nowrap line and the modes a fixed-column grid: neither CAN shrink, so
  // a stated minimum for them would be a number that never applies. The two ELASTIC
  // sections keep their minimums, unchanged, and they are still where the give is.
  check('the strip is a CSS GRID: two elastic tracks, two rigid, three dividers, in order', () => {
    const at = css.indexOf('.blocking-controls-strip {');
    assert.ok(at > 0, '.blocking-controls-strip is gone — the strip is a flex row again');
    const rule = css.slice(at, css.indexOf('}', at));
    assert.ok(/display:\s*grid/.test(rule), 'the strip is not a grid — a flex row can reorder under pressure');
    const cols = /grid-template-columns:([^;]+);/.exec(rule)?.[1] ?? '';
    const tracks = cols.match(/minmax\((\d+)px, max-content\)/g) ?? [];
    assert.strictEqual(tracks.length, 2, 'the two ELASTIC tracks (filters, status) are not both minmax()');
    assert.deepStrictEqual(
      tracks.map((t) => Number(/(\d+)/.exec(t)![1])),
      [232, 236],
      'an elastic minimum moved — S1 232 (the search) · S2 236 (two rows of pills)',
    );
    // The two rigid tracks are bare `max-content` — NOT `minmax(0, …)`, which would let
    // them crush, and not `1fr`, which would hand them the slack section 1 used to hoard.
    const rigid = cols.match(/(^|\s)max-content(\s|$)/g) ?? [];
    assert.strictEqual(rigid.length, 2, 'the totals and modes tracks are not both bare `max-content`');
    assert.ok(!/\bfr\b/.test(cols), 'a `fr` track is back — it would strand the slack inside one section again');
    assert.strictEqual(
      (cols.match(/\b1px\b/g) ?? []).length,
      3,
      'the three 1px divider tracks are gone — sections would touch',
    );
  });

  // NEW. Spare width belongs BETWEEN the sections. A `1fr` track or a `justify-content`
  // of `start` puts it inside one of them, which is the bug this pass fixed.
  check('SPARE WIDTH GOES BETWEEN THE SECTIONS, never inside one', () => {
    const at = css.indexOf('.blocking-controls-strip {');
    const rule = css.slice(at, css.indexOf('}', at));
    assert.ok(
      /justify-content:\s*space-between/.test(rule),
      'the strip does not distribute its slack between the sections',
    );
  });

  // NEW — the lesson of this pass, pinned. Section 1 always renders as two rows, so it
  // must be BUILT as two rows: a `flex-wrap` row's max-content is everything on ONE
  // line, and asking for 620px when 384 is used starves every neighbour.
  check('SECTION 1 IS A TWO-ROW BLOCK, not a wrapping row that asks for one line', () => {
    const at = css.indexOf('.blocking-strip-filters {');
    assert.ok(at > 0, '.blocking-strip-filters is gone — section 1 is a single flex row again');
    const rule = css.slice(at, css.indexOf('}', at));
    assert.ok(/display:\s*grid/.test(rule), 'section 1 is not a grid — it would lay the search beside the chips');
    assert.ok(
      /grid-template-columns:\s*minmax\(0, 1fr\)/.test(rule),
      'section 1 is not a SINGLE column — two columns would put the search back on the chips line',
    );
    const at2 = grid.indexOf('data-blocking-strip-section="filters"');
    assert.ok(at2 > 0, 'section 1 is missing');
    assert.ok(
      grid.slice(at2, at2 + 300).includes('blocking-strip-filters'),
      'section 1 does not use the two-row block class',
    );
  });

  check('NEVER CRUSH, ALWAYS SCROLL: the strip sits in an overflow-x-auto wrapper', () => {
    const at = grid.indexOf('blocking-controls-strip');
    assert.ok(at > 0, 'the grid does not render the strip');
    const before = grid.slice(Math.max(0, at - 400), at);
    assert.ok(
      before.includes('overflow-x-auto'),
      'the strip has no scrolling wrapper — a narrow viewport would crush a section',
    );
  });

  // RESTATED (was: every section is a `flex-wrap` box). Two of the four deliberately
  // are NOT any more — section 1 is a two-row grid and section 4 a fixed-column grid,
  // because "wrap freely" is exactly what produced the ragged 3 + 1 and the 620px
  // phantom. What every section still owes is `min-w-0` (so its track governs it) and
  // its place in the owner's order; what each owes BEYOND that is now per section.
  check('the four sections exist, in the owner\'s order, each contained by its own track', () => {
    const order = ['filters', 'status', 'totals', 'modes'];
    let cursor = 0;
    for (const name of order) {
      const at = grid.indexOf(`data-blocking-strip-section="${name}"`, cursor);
      assert.ok(at > cursor, `section "${name}" is missing or out of order`);
      const body = grid.slice(at, at + 400);
      assert.ok(body.includes('min-w-0'), `section "${name}" cannot give — its track would overflow`);
      cursor = at;
    }
    // The two ELASTIC sections are the give in the system, so they must still wrap
    // inside their own tracks.
    for (const name of ['filters', 'status']) {
      const at = grid.indexOf(`data-blocking-strip-section="${name}"`);
      assert.ok(
        grid.slice(at, at + 700).includes('flex-wrap'),
        `elastic section "${name}" can no longer wrap inside itself`,
      );
    }
  });

  // NEW. `Wtd Avg PHP/KG` was wrapping onto a line of its own under the other four —
  // which reads as a lesser, separate figure. The track cannot shrink and the row
  // cannot wrap, so the give is sections 1 and 2 and then the wrapper's own scroller.
  check('THE TOTALS ARE ONE LINE at sm and up — never 4 + 1', () => {
    const at = grid.indexOf('data-blocking-strip-section="totals"');
    assert.ok(at > 0, 'the totals section is missing');
    const body = grid.slice(at, at + 400);
    assert.ok(
      body.includes('sm:flex-nowrap'),
      'the totals may wrap at sm and up again — the fifth stat drops to a second line',
    );
    // Below `sm` the strip stacks into one column and a 468px line has nowhere to go,
    // so wrapping there is correct and must stay possible.
    assert.ok(body.includes('flex-wrap'), 'the totals cannot wrap below sm, where they must');
  });

  // NEW. Four buttons of four different widths in a wrapping row pack themselves
  // 3 + 1, which is what the owner photographed. A grid of `max-content` columns
  // cannot: it is four across, or a clean 2 × 2.
  check('THE MODES ARE A 4-OR-2 COLUMN GRID — never a ragged 3 + 1', () => {
    const at = css.indexOf('.blocking-strip-modes {');
    assert.ok(at > 0, '.blocking-strip-modes is gone — the modes are a wrapping flex row again');
    const rule = css.slice(at, css.indexOf('}', at));
    assert.ok(/display:\s*grid/.test(rule), 'the modes are not a grid');
    assert.ok(
      /grid-template-columns:\s*repeat\(2, max-content\)/.test(rule),
      'the modes do not default to TWO columns — 2 × 2 is the tight answer, and 2 + 1 for three buttons',
    );
    assert.ok(
      /justify-items:\s*start/.test(rule),
      'the buttons would stretch to their column width instead of keeping their own',
    );
    // The one-row rule is a CONTAINER query on the strip's own scroller, so "is there
    // room" is answered by the strip's width and not by the viewport's.
    assert.ok(
      /container-type:\s*inline-size/.test(css) && /container-name:\s*blockingstrip/.test(css),
      'the strip is not a query container — the mode grid would have to guess from the viewport',
    );
    const wide = [...css.matchAll(/@container blockingstrip \(min-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    assert.strictEqual(wide.length, 2, 'there are not exactly two one-row thresholds (three buttons, and four)');
    assert.ok(wide[0] < wide[1], 'three buttons must straighten out at a NARROWER width than four');
    for (const [n, count] of [[3, '3'], [4, '4']] as const) {
      const reached = [...css.matchAll(new RegExp(`\\[data-mode-count='${count}'\\]`, 'g'))].some((m) =>
        new RegExp(`^[\\s\\S]{0,140}repeat\\(${n}, max-content\\)`).test(css.slice(m.index!)),
      );
      assert.ok(reached, `${n} buttons never reach one row of ${n}`);
    }
    // A row of ONE must not set a `max-content` column's width: with three buttons in
    // two columns the widest lands in column 1 and stretches it, measured 32px of hole
    // between the two above it. The third spans the row instead.
    assert.ok(
      /\[data-mode-count='3'\] > \*:last-child \{\s*grid-column: 1 \/ -1/.test(css),
      "the tight 2 + 1 case lets its third button stretch column 1",
    );
    assert.ok(
      /@container blockingstrip[\s\S]{0,400}\[data-mode-count='3'\] > \*:last-child \{\s*grid-column: auto/.test(css),
      'the row-span is not undone once the three buttons are on ONE row',
    );
    const at2 = grid.indexOf('data-blocking-strip-section="modes"');
    const body = grid.slice(at2, at2 + 400);
    assert.ok(body.includes('blocking-strip-modes'), 'the modes section does not use the grid class');
    assert.ok(
      /data-mode-count=\{serverCanViewPrices \? 4 : 3\}/.test(body),
      'the count is not published — the CSS cannot count children, so it could not tell 3 from 4',
    );
  });

  check('below sm the four sections STACK in the same order, one per row', () => {
    const at = css.indexOf('@media (max-width: 639px)');
    const block = css.slice(at, at + 400);
    assert.ok(
      block.includes('.blocking-controls-strip'),
      'the phone rule is gone — a 900px strip inside a 375px screen is all scroll and no overview',
    );
    assert.ok(/grid-template-columns:\s*minmax\(0, 1fr\)/.test(block), 'the phone strip is not a single column');
    assert.ok(block.includes('blocking-strip-divider'), 'the vertical dividers survive as rows');
  });

  check('A MODE TOGGLE CHANGES A COLOUR, NEVER A WIDTH: every pill is fixed-width', () => {
    assert.ok(
      !/min-w-\[16px\] h-4 px-1 rounded-full/.test(grid),
      'an ON/OFF pill still sizes to its content — turning a mode on would move the section beside it',
    );
    assert.strictEqual(
      (grid.match(/w-\[26px\] h-4 px-1 rounded-full/g) ?? []).length,
      4,
      'the four mode pills (Prices · Highlight · Proposals · Blend) do not all reserve their width',
    );
    assert.ok(grid.includes('tabular-nums'), 'the counts are not tabular — a digit change would re-flow');
  });

  check('THE PRICES TOGGLE CANNOT RESIZE THE TOTALS: both ₱ slots are RESERVED', () => {
    // The two price totals are rendered for anyone who MAY see prices and merely made
    // invisible when the toggle is off, so section 3's own width does not change and
    // the modes beside it do not slide. A reader who may never see prices has no slot
    // to reserve — there is no toggle for them to move it with.
    assert.ok(
      /\{serverCanViewPrices && \(\s*<>\s*<StatDivider reserved=/.test(grid),
      'the price totals are conditional on the CLIENT toggle again — that resizes the section',
    );
    assert.ok(grid.includes('reserved?: boolean'), 'GlobalStat cannot reserve a slot');
    assert.ok(
      /reserved && 'invisible'/.test(grid),
      'a reserved slot is hidden with `hidden`, not `invisible` — it must still be laid out',
    );
    assert.ok(grid.includes('minWidthClass'), 'the totals do not reserve their own widths');
  });

  // NEW. `Peso` is a `justify-between` accounting layout — right inside a box sized for
  // the number, wrong when the box is as wide as the LABEL above it. `Wtd Avg PHP/KG` is
  // 84px of words over a 40px figure, so the glyph hung ~40px off to the left of its own
  // number, which is the thing the owner singled out. Both ₱ cells now state their
  // value box's width; the three non-₱ figures state none and shrink to content.
  check('THE ₱ FIGURES SIT IN A BOX OF THEIR OWN WIDTH, not stretched across the label', () => {
    assert.ok(grid.includes('valueWidthClass'), 'GlobalStat cannot bound its value box');
    assert.ok(
      /items-end/.test(grid),
      'the totals no longer share one right edge — a `flex` value would fill the whole cell again',
    );
    const totalsAt = grid.indexOf('data-blocking-strip-section="totals"');
    const body = grid.slice(totalsAt, grid.indexOf('</section>', totalsAt));
    const stated = body.match(/valueWidthClass="w-\[\d+px\]"/g) ?? [];
    assert.strictEqual(stated.length, 2, 'exactly the two ₱ figures must state a value width');
    // Every `<Peso>` in the totals must be inside a stat that stated one.
    const pesos = (body.match(/<Peso>/g) ?? []).length;
    assert.strictEqual(pesos, stated.length, 'a ₱ figure has no stated box — its glyph would hang off to the left');
  });
}

// ===========================================================================
console.log('\n8. THE LEGEND BAR REPLACED THE DOCKED SIDEBAR (job C)');
// ===========================================================================

{
  const frame = code(FRAME);
  const grid = code(GRID);

  check('NO DOCKED SIDEBAR REMAINS — the frame is a bar, not a 300px column', () => {
    assert.ok(!/lg:w-\[300px\]/.test(frame), 'the 300px docked column is back');
    assert.ok(!/lg:sticky lg:top-/.test(frame), 'the frame is a sticky column again');
    assert.ok(!/max-lg:fixed/.test(frame), 'the frame is a bottom sheet again');
    assert.ok(frame.includes('data-blocking-lens-bar'), 'the bar is not marked as one');
  });

  check('THE GRID IS FULL WIDTH AGAIN — no flex row, no min-w-0 column', () => {
    assert.ok(
      !/flex items-start gap-3/.test(grid),
      'the grid still shares a flex row with the panel — the lens is eating its width',
    );
    assert.ok(
      !/flex min-w-0 flex-1 flex-col gap-3/.test(grid),
      'the grid column is still a shrinking flex item beside a panel',
    );
    // And the bar is the STRIP's second row: it must appear before the warehouse
    // sections, inside the one sticky wrapper, so the two cannot overlap at top:0.
    const sticky = grid.indexOf("className=\"sticky top-0 z-30 flex flex-col gap-2\"");
    const bar = grid.indexOf('<BlockingLensPanel');
    const sections = grid.indexOf('{visibleWarehouses.map(');
    assert.ok(sticky > 0, 'the strip + bar are not one sticky unit');
    assert.ok(sticky < bar && bar < sections, 'the lens bar is not the strip\'s second row');
  });

  check('THE BAR IS ONE LINE: it never wraps, and the chips scroll instead', () => {
    assert.ok(/flex-nowrap/.test(frame), 'the bar can wrap — a second line pushes the grid down');
    assert.ok(/h-9/.test(frame), 'the bar has no fixed height');
    const rows = code(ROWS);
    const at = rows.indexOf('export function LensBandChips');
    assert.ok(at > 0, 'the compact band chips are gone');
    const body = rows.slice(at, at + 900);
    assert.ok(body.includes('overflow-x-auto'), 'the chips wrap instead of scrolling');
    assert.ok(!body.includes('flex-wrap'), 'the chip row wraps — it must scroll');
  });

  check('the chips are a VARIANT of the rows, not a fork', () => {
    const rows = code(ROWS);
    // Same props type, same isolate semantics, same swatch source.
    assert.ok(
      /interface LensBandChipsProps extends LensBandRowsProps/.test(rows),
      'the chips declare their own row shape — two legends would drift',
    );
    assert.ok(/aria-pressed=\{isPicked\}/.test(rows), 'a chip is not a real toggle');
    assert.ok(
      (rows.match(/rampClass\(ramp, i, rows\.length\)/g) ?? []).length === 2,
      'the chips do not derive their swatch from the SAME rampClass call the rows use',
    );
    assert.ok(rows.includes('export function LensExcludedChip'), 'the "in no band" chip is gone');
  });

  check('THE SETTINGS POPOVER holds what the sidebar held, and floats only while open', () => {
    const pop = code(`${LENS_DIR}/lens-settings-popover.tsx`);
    assert.ok(pop.includes('export function LensSettingsPopover'), 'the settings popover is gone');
    // The canonical popover glass, and an internal scroll cap so 7 bands cannot run
    // off a short viewport.
    assert.ok(pop.includes('bg-popover/95 backdrop-blur-lg'), 'the popover is not the canonical glass');
    assert.ok(/max-h-\[min\(70dvh,560px\)\] overflow-y-auto/.test(pop), 'the popover has no internal scroll cap');
    assert.ok(pop.includes('data-blocking-lens-settings'), 'the gear is not addressable');
    for (const rel of [PANEL, AGE_PANEL]) {
      const body = code(rel);
      assert.ok(body.includes('<LensSettingsPopover'), `${rel} does not open a settings popover`);
      // The DETAIL still lives in the popover — the shared pieces, not new ones.
      assert.ok(body.includes('<LensBandRows'), `${rel} lost the detailed band rows`);
      assert.ok(body.includes('<LensCustomize'), `${rel} lost the Customize disclosure`);
      assert.ok(body.includes('<RefusalBanner'), `${rel} lost the inline refusal banner`);
      // ...and the BAR carries the compact pieces.
      assert.ok(body.includes('<LensBandChips'), `${rel} has no band chips in the bar`);
      assert.ok(body.includes('<LensRatioBar'), `${rel} has no ratio bar`);
      assert.ok(body.includes('<LensUnitSwitch'), `${rel} has no kg|blocks switch`);
    }
  });

  check('the bar is NEVER EMPTY while a read is in flight', () => {
    for (const rel of [PANEL, AGE_PANEL]) {
      const body = code(rel);
      assert.ok(
        body.includes('shrink-0 text-[10px] text-muted-foreground">…</span>'),
        `${rel}: the bar renders nothing at all until the payload lands`,
      );
    }
  });
}

// ===========================================================================
console.log('\n9. THE BLEND TABLE — SUPPLIER DOMINANCE + THE TWO AGES (job D)');
// ===========================================================================

{
  const DIALOG = 'app/(app)/inventory/_shared/blend-proposal-dialog.tsx';
  const PDF = 'app/(app)/inventory/_shared/blend-proposal-pdf.ts';
  const dialog = code(DIALOG);
  const pdf = code(PDF);
  const grid = code(GRID);

  check('`isSingleSupplier` IS the green/orange rule — `suppliers.length` never is', () => {
    assert.ok(dialog.includes('facts.isSingleSupplier'), 'the pill does not read the flag');
    for (const [rel, body] of [[DIALOG, dialog], [PDF, pdf]] as const) {
      assert.ok(
        !/suppliers\.length/.test(body),
        `${rel} derives the supplier colour from the array's length — that is how this table and the Blocking supplier search end up disagreeing about a block`,
      );
    }
    // The emerald / orange families the page already uses for ALL / SOME.
    assert.ok(dialog.includes('border-emerald-500/40'), 'the ALL pill is not the emerald family');
    assert.ok(dialog.includes('border-orange-500/40'), 'the SOME pill is not the orange family');
  });

  check('NULL IS A THIRD ANSWER: no colour, an em dash, never green and never 0 days', () => {
    assert.ok(
      /facts\.isSingleSupplier === null \|\| facts\.dominantSupplierDisplay === null/.test(dialog),
      'a block with nothing delivered as of the date is not treated as its own case',
    );
    assert.ok(
      /v === null \|\| v === undefined \? EMDASH/.test(dialog),
      'a missing age reads as 0 rather than blank',
    );
    assert.ok(/v === null \|\| v === undefined \? '-'/.test(pdf), 'the PDF prints 0 d for an unknown age');
  });

  check('KEYED BY batch_id, NEVER by block_loc — a block address is reused', () => {
    for (const [rel, body] of [[DIALOG, dialog], [PDF, pdf]] as const) {
      assert.ok(
        /b\.batch_id \?\? (blockFacts\.)?batchIdByLoc\?\.\[b\.block_loc\]/.test(body),
        `${rel} resolves the facts by something other than the batch id`,
      );
    }
    assert.ok(grid.includes('batchIdByLoc={batchIdByLoc}'), 'the grid does not supply the live occupants');
    assert.ok(
      /out\[loc\] = block\.batch_id \?\? null/.test(grid),
      'the grid builds its id map from something other than the grid payload',
    );
  });

  check('A SAVED VERSION ASKS ABOUT ITS OWN DAY; the live modal passes nothing', () => {
    assert.ok(
      /const factsAsOf = manilaDate\(savedVersionCreatedAt\)/.test(dialog),
      'the as-of date is not the version\'s own creation day',
    );
    assert.ok(
      /saved\s*\?\s*saved\.versions\.find\(\(v\) => v\.versionNo === saved\.proposal\.version_no\)\?\.createdAt/.test(
        dialog,
      ),
      'the date does not come from the version rail the read model always populates',
    );
    assert.ok(
      /Asia\/Manila/.test(dialog),
      'the date is not resolved in Asia/Manila — a UTC date is the wrong day for eight hours',
    );
    assert.ok(
      /asOf: saved \? factsAsOfUsed : null/.test(dialog),
      'the live print/PDF claims an as-of day it does not have',
    );
    assert.ok(dialog.includes('Supplier and age as of'), 'the table never says which day it is describing');
  });

  check('the read is race-safe and happens once per open / version switch', () => {
    assert.ok(dialog.includes('factsWantRef'), 'the facts read has no race guard');
    assert.ok(
      /if \(factsWantRef\.current !== signature\) return;/.test(dialog),
      'a stale facts reply can overwrite a fresh one',
    );
    assert.ok(/\}, \[open, idsKey, factsAsOf\]\);/.test(dialog), 'the facts read re-fires on unrelated renders');
  });

  check('NEVER CRUSH, ALWAYS SCROLL: the min-width is the sum of the columns', () => {
    assert.ok(dialog.includes('min-w-[872px]'), 'the table min-width did not grow with the three new columns');
    assert.ok(dialog.includes('rounded-md overflow-x-auto'), 'the table lost its scrolling wrapper');
    // Reserved widths, so the table does not jump as the figures fill in.
    assert.ok(/whitespace-nowrap w-\[120px\]/.test(dialog), 'the Supplier column reserves no width');
    assert.ok(/whitespace-nowrap w-\[54px\]/.test(dialog), 'the Opened column reserves no width');
    assert.ok(/whitespace-nowrap w-\[58px\]/.test(dialog), 'the Last-piled column reserves no width');
    assert.ok(/colSpan=\{5\}/.test(dialog), 'the footer still spans 2 columns — Total now sits under five');
  });

  check('all three surfaces carry the columns: screen, print and PDF', () => {
    for (const label of ['Supplier', 'Opened', 'Last piled']) {
      assert.ok(dialog.includes(label), `the screen table lost the ${label} column`);
      assert.ok(pdf.includes(label), `the PDF lost the ${label} column`);
    }
    // The print builder's own header row and its 5-wide total.
    assert.ok(
      dialog.includes('<th>Block</th><th>Batch</th><th>Supplier</th>'),
      'the printed table lost the Supplier column',
    );
    assert.ok(dialog.includes('<td colspan="5">Total</td>'), 'the printed footer still spans 2');
  });

  check('THE PRINT KEEPS THE COLOURS, and it is LANDSCAPE', () => {
    assert.ok(/@page \{ size: A4 landscape/.test(dialog), 'the proposal print is not landscape');
    assert.ok(dialog.includes('.sup-all'), 'the printed pill has no ALL colour');
    assert.ok(dialog.includes('.sup-some'), 'the printed pill has no SOME colour');
    assert.ok(
      read('app/(app)/inventory/_shared/print-utils.ts').includes('print-color-adjust: exact'),
      'the shared print CSS no longer forces exact colour — the pills would print grey',
    );
    // Padding is squeezed BEFORE the font, and the font floor is 7pt.
    assert.ok(/th, td \{ padding: 2px 3px; \}/.test(dialog), 'the print does not tighten cell padding');
    const sizes = [...dialog.matchAll(/font-size: ([\d.]+)pt/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length > 0, 'the print declares no point sizes');
    assert.ok(Math.min(...sizes) >= 7, `a printed font fell below the 7pt floor (${Math.min(...sizes)}pt)`);
  });

  check('the three columns are NOT price-gated, and the ₱ column still is', () => {
    // They carry no money — `fetchBlendBlockFacts` has no price gate by design — so a
    // Production reader (and a hidden-prices print) keeps them and loses only ₱/KG.
    assert.ok(
      !/showPrices[\s\S]{0,80}SupplierPill/.test(dialog),
      'the supplier pill is gated on prices — it carries none',
    );
    assert.ok(/if \(showPrices\) head\.push\('PHP\/KG'\)/.test(pdf), 'the PDF ₱ column lost its gate');
    assert.ok(
      dialog.includes("showPrices\n        ? `<td class=\"num\">${b.php_kg !== null ? peso(b.php_kg) : EMDASH}</td>`"),
      'the printed ₱ cell lost its gate',
    );
  });
}


// ===========================================================================
console.log('\n10. THE PRINTED LENS SUMMARY (2026-09-21, REDESIGNED 2026-09-22)');
// ===========================================================================
//
// The owner: *"In the lens section, would be nice to also print some kind of summary
// based on the filter we set."* The sheet itself is proven in
// `scripts/verify-blend-analysis-ui.ts` (the platform kit, the light surfaces, the
// warehouse grouping, the blank subtotal lab cells, the isolation line, the labelled
// footer). What belongs HERE is the part that is about the three LENSES rather than about
// the sheet: that each one builds its own model, that none of them computes a statistic to
// do it, and that the price gate sits on the price lens's button and nowhere near the
// other two.
{
  const PRINT = `${LENS_DIR}/lens-summary-print.tsx`;
  const PRINT_PANELS = [PANEL, AGE_PANEL, SUPPLIER_PANEL];

  check('each lens builds its OWN model — the sheet knows nothing about any of them', () => {
    for (const panel of PRINT_PANELS) {
      const body = code(panel);
      assert.ok(/printModel: LensSummaryPrintModel \| null/.test(body), `${panel} builds no print model`);
      assert.ok(/<LensSummaryPrintControl/.test(body), `${panel} has no Print button`);
    }
    const sheet = code(PRINT);
    // The sheet takes STRINGS. A formatter reached for here would be a second way to
    // print a kilogram.
    assert.ok(!/formatLens/.test(sheet), 'the sheet formats a figure itself');
    assert.ok(!/toFixed\(/.test(sheet) && !/toLocaleString\(/.test(sheet), 'the sheet formats a number itself');
  });

  check('the print models COMPUTE NOTHING — they bucket a published map and format', () => {
    for (const panel of PRINT_PANELS) {
      const body = code(panel);
      // A bucketing of `bandByBlock` is a LOOKUP; a sum of its kilograms would not be.
      assert.ok(/lens\.bandByBlock\[loc\]/.test(body), `${panel} does not read the published band map`);
      assert.ok(!/\breduce\s*\(/.test(body), `${panel} folds its print rows`);
      assert.ok(!/[^+]\+=[^=]/.test(body), `${panel} accumulates a print total`);
    }
    // And the figures on the sheet are the payload's own.
    assert.ok(/b\.kgWeightedPhpKg === null \? EMDASH/.test(code(PANEL)), 'the price band figure is derived');
    assert.ok(/formatLensDays\(b\.kgWeightedAgeDays\)/.test(code(AGE_PANEL)), 'the age band figure is derived');
    // RESTATED 2026-09-22: the supplier band figure MOVED from `dominantKg` to
    // `kgWeightedPhpKg` — still the payload's own number, read verbatim. See section 11a.
    assert.ok(
      /b\.kgWeightedPhpKg === null/.test(code(SUPPLIER_PANEL)),
      'the supplier band figure is no longer the published weighted ₱/kg',
    );
  });

  check('a block the lens cannot place is listed SEPARATELY, never inside a band', () => {
    // ONE bucketing owns the rule now, so it is asserted once, where it lives.
    const model = code(SUMMARY_MODEL);
    assert.ok(/if \(band === undefined\) \{/.test(model), 'the bucketing does not test for the ABSENCE of a band');
    assert.ok(/excludedRows\.push\(/.test(model), 'the bucketing folds unplaced blocks into a band');
    assert.ok(/continue;/.test(model), 'an unplaced block falls through into a warehouse group');
    for (const panel of PRINT_PANELS) {
      assert.ok(
        /rows: excludedRows,/.test(code(panel)),
        `${panel} does not list the blocks it cannot place on its own row`,
      );
    }
  });

  check('the PRICE print is behind the price flag; the other two are not, and must not be', () => {
    const price = code(PANEL).replace(/\s+/g, ' ');
    assert.ok(
      /caps\.canViewPrices && \( <LensSummaryPrintControl/.test(price),
      'the price lens print button is not behind the effective price flag',
    );
    for (const [panel, label] of [[AGE_PANEL, 'age'], [SUPPLIER_PANEL, 'supplier']] as const) {
      const body = code(panel);
      assert.ok(
        new RegExp(`<LensSummaryPrintControl model=\\{printModel\\} lensLabel="${label}"`).test(body),
        `${panel} lost its unconditional Print button`,
      );
    }
    // The AGE payload has no money in it at all, so its panel must never learn the word.
    assert.ok(
      !/canViewPrices/.test(code(AGE_PANEL)),
      `${AGE_PANEL} grew a price flag — there is no money in its payload and Production must keep it`,
    );
    // The SUPPLIER payload carries two ₱ keys (2026-09-22), so its panel DOES read the
    // effective flag — but only to choose a COLUMN, never to withhold the button. Asserted
    // by shape: the control is mounted with no conditional before it.
    assert.ok(
      !/canViewPrices && \(\s*<LensSummaryPrintControl/.test(code(SUPPLIER_PANEL).replace(/\s+/g, ' ')),
      'the supplier Print button was put behind the price flag — the rest of its sheet is peso-free',
    );
    assert.ok(!/canViewPrices/.test(code(PRINT)), 'the shared sheet grew a price concern');
    assert.ok(!/canViewPrices/.test(code(SUMMARY_MODEL)), 'the shared bucketing grew a price concern');
  });

  check('the ratio bar can be re-skinned for paper WITHOUT a second implementation', () => {
    const bar = code(`${LENS_DIR}/lens-ratio-bar.tsx`);
    assert.ok(/trackClassName\?: string;/.test(bar), 'the bar cannot be re-skinned');
    assert.ok(
      /trackClassName \?\? 'border-border bg-muted'/.test(bar),
      'the default track changed — every on-screen bar would move with it',
    );
    // The segments must NOT be re-skinnable: their fill is the ramp, and the ramp is the
    // one thing the sheet and the grid must agree on exactly. A NOMINAL lens may name its
    // STOP (2026-09-22) — that is still the ramp deciding the colour, not the caller.
    assert.ok(/rampClassAtStop\(ramp, seg\.rampStop\)/.test(bar), 'a nominal lens cannot name its stop');
    assert.ok(!/segmentClassName/.test(bar), 'a segment colour became a caller concern');
  });
}

// ===========================================================================
console.log('\n11. THE SUPPLIER LENS (2026-09-22)');
// ===========================================================================
//
// The third lens. What a data-layer test cannot see and a type-checker will not catch:
// that the two KILOGRAM ATTRIBUTIONS stay apart on screen, that the NOMINAL ramp is
// identity-mapped, that the MIXED marker is not the blend-selection marking, and that the
// ALL/SOME rule is a carried column rather than a length.
{
  check('the SUPPLIER panel renders the SERVER\'s figures — no sum, no share, no average', () => {
    const body = code(SUPPLIER_PANEL);
    assert.ok(body.includes('kgSharePct'), 'the panel does not read the published kg share');
    assert.ok(body.includes('blockSharePct'), 'the panel does not read the published block share');
    assert.ok(body.includes('apportionedKg'), 'the panel does not read the published apportioned kg');
    assert.ok(body.includes('dominantBlockCount'), 'the panel does not read the published dominant count');
    assert.ok(!/\.reduce\s*\(/.test(body), 'the supplier panel folds a figure');
    assert.ok(!/\+=/.test(body), 'the supplier panel accumulates');
    assert.ok(
      !/\/\s*(lens\.total|total\.kg|attributedKg)/.test(body),
      'the supplier panel divides by a total — a share must come out of SQL',
    );
    // ⚠️ AND IT MUST NOT COMPARE THE APPORTIONED FOLD WITH `===`: the contract records a
    // −1.9e-9 kg residue once the payload has been through JSON and JS doubles.
    assert.ok(
      !/apportionedKg ===/.test(body) && !/=== lens\.total\.kg/.test(body),
      'the panel equality-tests the apportioned fold, which is not bit-exact',
    );
  });

  check('⚠️ THE TINT IS DOMINANCE AND THE RATIO BAR IS APPORTIONED — never mixed up', () => {
    const body = code(SUPPLIER_PANEL);
    // The TINT: the classifier reads the block's own band, which is its DOMINANT
    // supplier's — `bandByBlock` / `bandIndex`, and nothing apportioned.
    const classifier = body.slice(body.indexOf('const classifier'), body.indexOf('React.useEffect(() => {\n    onClassifierChange'));
    assert.ok(/byBlock\[locKey\]/.test(classifier), 'the tint does not read the published band map');
    assert.ok(
      !/apportioned/i.test(classifier),
      'the grid TINT reads an apportioned figure — a cell can only be one colour, and that colour is dominance',
    );
    // The RATIO BAR: `share()` on the kg unit is `kgSharePct`, which the contract defines
    // ON APPORTIONED kilograms.
    assert.ok(
      /settings\.unit === 'kg' \? band\.kgSharePct : band\.blockSharePct/.test(body),
      'the share is not the apportioned kg share / dominant block share pair',
    );
    assert.ok(
      /segments=\{lens\.bands\.map\(\(b\) => \(\{[\s\S]{0,120}sharePct: share\(b\)/.test(body),
      'the ratio bar does not take the published share',
    );
    // A COUNT is always dominance.
    assert.ok(
      /blocks: formatLensBlocks\(b\.dominantBlockCount\)/.test(body),
      'a printed block count is not the dominant count',
    );
    // And the panel SAYS which is which, once, rather than leaving a reader to assume.
    assert.ok(
      /DOMINANCE/.test(read(SUPPLIER_PANEL)) && /APPORTIONED/.test(read(SUPPLIER_PANEL)),
      'the panel never tells the reader which figure is which',
    );
  });

  check('⚠️ a TYPED price is never called "market" — legend, popover and sheet', () => {
    const body = code(PANEL);
    // ONE noun, derived once from the basis and read by every string that names it.
    assert.ok(
      /const basisNoun = priceBasisNoun\(settings\.basis === 'manual'\);/.test(body),
      'the price lens does not derive the basis noun from the shared definition',
    );
    // THE BAR HEADLINE.
    assert.ok(
      /\$\{typed \? 'Set price' : 'Market'\} \$\{peso\(marketPhpKg, 2\)\}/.test(body),
      'the legend headline still says "market" about a typed figure',
    );
    assert.ok(
      !/' \(typed\)'/.test(body),
      'a label still annotates a typed price with "(typed)" instead of NAMING it a set price',
    );
    // THE SETTINGS POPOVER's own label.
    assert.ok(
      /settings\.basis === 'manual' \? 'Set price' : 'Market is'/.test(body),
      'the popover label still says "Market is" over a typed figure',
    );
    assert.ok(
      /aria-label="Set price per kilogram"/.test(body),
      'the typed-price input is still labelled a market price for a screen reader',
    );
    // THE CUSTOMIZE DISCLOSURE — its cut lines are measured FROM the basis.
    assert.ok(/from \$\{basisNoun\}/.test(body), 'a cut-line message still hardcodes "market"');
    assert.ok(/rounded \{basisNoun\}/.test(body), 'the disclosure intro still hardcodes "market"');
    // THE PRINTED SHEET.
    assert.ok(
      /`Set price \$\{peso\(marketPhpKg, 2\)\}`/.test(body),
      'the printed settings line still says "market" about a typed figure',
    );
    assert.ok(
      /and up is above \$\{priceBasisNoun\(typed\)\}/.test(body),
      'the printed cut-line sentence hardcodes "market"',
    );
  });

  check('⚠️ `isMixed` is the CARRIED column, never `suppliers.length`', () => {
    const body = code(SUPPLIER_PANEL);
    assert.ok(/block\?\.isMixed/.test(body), 'the panel does not read the carried ALL/SOME column');
    assert.ok(
      !/suppliers\.length/.test(body),
      'the panel re-derives the ALL/SOME rule from a list length — that rule is a column on the view',
    );
  });

  check('⚠️ the MIXED marker is NOT the blend-selection marking', () => {
    const css = read(GLOBALS);
    const at = css.indexOf('.lens-cat-mixed {');
    assert.ok(at > 0, '.lens-cat-mixed is missing from globals.css');
    const rule = css.slice(at, css.indexOf('}', at));
    // A DASHED INSET OUTLINE in the band's own hue. The blend selection is a solid
    // `ring-2 ring-primary` plus a filled primary circle with a check at the TOP-RIGHT,
    // so the two differ in shape, in colour and in position.
    assert.ok(/outline:.*dashed/.test(rule), 'the mixed marker is not a dashed outline');
    assert.ok(/var\(--lens-hue\)/.test(rule), 'the mixed marker does not wear the band hue');
    assert.ok(/outline-offset: -/.test(rule), 'the mixed marker is not INSET, so it reads as a selection ring');
    assert.ok(!/--primary/.test(rule), 'the mixed marker borrowed the blend selection colour');
    assert.ok(!/ring-2/.test(rule) && !/box-shadow/.test(rule), 'the mixed marker fights the tint or the picked ring');
    assert.ok(!/animation/.test(rule), 'a cell marking was animated');
    // It is SPELLED once, and the panel reads the constant.
    assert.equal(SUPPLIER_LENS_MIXED_CLASS, 'lens-cat-mixed');
    assert.ok(
      /SUPPLIER_LENS_MIXED_CLASS/.test(code(SUPPLIER_PANEL)),
      'the panel spells the mixed class by hand',
    );
  });

  check('the THIRTEEN categorical classes exist AFTER `.blocking-cell-occupied`', () => {
    const css = read(GLOBALS);
    const occupied = css.indexOf('.blocking-cell-occupied {');
    assert.ok(occupied > 0);
    for (let i = 0; i < LENS_CATEGORY_STOPS; i += 1) {
      const at = css.search(new RegExp(`\\.lens-cat-${i}\\s+\\{`));
      assert.ok(at > 0, `.lens-cat-${i} is missing from globals.css`);
      assert.ok(
        at > occupied,
        `.lens-cat-${i} is declared BEFORE .blocking-cell-occupied — same specificity, so the cell's own background wins and the lens paints nothing`,
      );
      // It JOINS the shared tint rule rather than declaring its own alpha.
      assert.ok(css.includes(`.lens-cat-${i},`) || css.includes(`.lens-cat-${i} {`), `.lens-cat-${i} unreadable`);
      assert.ok(css.includes(`:is(.dark) .lens-cat-${i}`), `.lens-cat-${i} has no :is(.dark) variant`);
    }
    // The ONE shared tint rule carries them, so the measured 22% / 30% alpha is inherited.
    const rule = css.slice(css.indexOf('.lens-band-0,'), css.indexOf('}', css.indexOf('.lens-band-0,')));
    for (let i = 0; i < LENS_CATEGORY_STOPS; i += 1) {
      assert.ok(rule.includes(`.lens-cat-${i}`), `.lens-cat-${i} is not in the shared tint rule`);
    }
  });

  check('the NOMINAL ramp is identity-mapped and `others` takes the reserved neutral', () => {
    assert.equal(LENS_RAMP_IS_ORDINAL.cost, true);
    assert.equal(LENS_RAMP_IS_ORDINAL.age, true);
    assert.equal(LENS_RAMP_IS_ORDINAL.category, false);
    assert.equal(LENS_RAMP_CLASS_PREFIX.category, 'lens-cat-');
    assert.equal(LENS_RAMP_RGB.category.length, LENS_CATEGORY_STOPS);
    // A band's slot is its RANK — it does not move when N changes.
    assert.equal(supplierBandRampStop({ index: 0, isOthers: false }), 0);
    assert.equal(supplierBandRampStop({ index: 5, isOthers: false }), 5);
    assert.equal(supplierBandRampClass({ index: 5, isOthers: false }), 'lens-cat-5');
    // `others` is the neutral at EVERY N, so the fold never wears a supplier's identity.
    for (const i of [1, 6, 12]) {
      assert.equal(supplierBandRampStop({ index: i, isOthers: true }), LENS_CATEGORY_NEUTRAL_STOP);
      assert.equal(supplierBandRampClass({ index: i, isOthers: true }), 'lens-cat-12');
    }
    assert.equal(categoryStop(99, false), LENS_CATEGORY_NEUTRAL_STOP - 1, 'a stale index reached the neutral');
    assert.equal(rampClassAtStop('category', 99), 'lens-cat-12', 'a stop is not clamped to the ramp');
    // AND the ordinal ramps are byte-identical to what they were.
    assert.equal(rampClass('cost', 0, 4), 'lens-band-0');
    assert.equal(rampClass('cost', 3, 4), 'lens-band-6');
    assert.equal(rampClass('age', 1, 4), 'lens-age-2');
  });

  check('⚠️ no categorical hue is one of the supplier SEARCH\'s two meanings', () => {
    const css = read(GLOBALS);
    const all = /\.spotlight-supplier-all \{[\s\S]*?rgba\((\d+), (\d+), (\d+)/.exec(css);
    const some = /\.spotlight-supplier-some \{[\s\S]*?rgba\((\d+), (\d+), (\d+)/.exec(css);
    assert.ok(all && some, 'the supplier spotlight hues could not be read');
    const taken = [`${all[1]} ${all[2]} ${all[3]}`, `${some[1]} ${some[2]} ${some[3]}`];
    for (const triple of LENS_RAMP_RGB.category) {
      assert.ok(!taken.includes(triple), `the categorical ramp reuses a spotlight hue (${triple})`);
    }
    // Every slot distinct — twelve hues have to be TELLABLE APART, and a repeat would
    // silently merge two suppliers.
    assert.equal(new Set(LENS_RAMP_RGB.category).size, LENS_CATEGORY_STOPS);
  });

  check('the band label is the SUPPLIER, and `Others (N)` is the UI\'s word', () => {
    assert.equal(
      supplierBandLabel({ isOthers: false, display: 'Ornales', key: 'ORNALES', supplierCount: 1 }),
      'Ornales',
    );
    // The payload carries key: null / display: null on the fold and does NOT name it.
    assert.equal(
      supplierBandLabel({ isOthers: true, display: null, key: null, supplierCount: 11 }),
      'Others (11)',
    );
    // A band with neither is still labelled something a reader can act on.
    assert.equal(
      supplierBandLabel({ isOthers: false, display: null, key: null, supplierCount: 1 }),
      'Unnamed supplier',
    );
  });

  check('the stored settings are UNTRUSTED — proven by running the parser', () => {
    // Same discipline as the other two lenses: FIELD BY FIELD, falling back per field.
    assert.deepEqual(parseSupplierLensSettings(null), DEFAULT_SUPPLIER_LENS_SETTINGS);
    assert.deepEqual(parseSupplierLensSettings('nope'), DEFAULT_SUPPLIER_LENS_SETTINGS);
    assert.deepEqual(parseSupplierLensSettings([1, 2]), DEFAULT_SUPPLIER_LENS_SETTINGS);
    // One bad key must not cost the other its value.
    assert.deepEqual(parseSupplierLensSettings({ topN: 'x', unit: 'blocks' }), { topN: 6, unit: 'blocks' });
    assert.deepEqual(parseSupplierLensSettings({ topN: 3, unit: 'nope' }), { topN: 3, unit: 'kg' });
    // Out of range, non-integer and non-finite all fall back rather than being clamped —
    // a clamp would silently answer a question the reader did not ask.
    for (const bad of [0, 13, -1, 6.5, NaN, Infinity]) {
      assert.equal(parseSupplierLensSettings({ topN: bad }).topN, 6, `topN ${bad} was accepted`);
      assert.equal(normalizeTopN(bad), null, `normalizeTopN accepted ${bad}`);
    }
    assert.equal(normalizeTopN(1), 1);
    assert.equal(normalizeTopN(12), 12);
  });

  check('the stored document OMITS defaults, so Reset is a removal', () => {
    assert.deepEqual(serializeSupplierLensSettings(DEFAULT_SUPPLIER_LENS_SETTINGS), {});
    assert.ok(isDefaultSupplierLensSettings(DEFAULT_SUPPLIER_LENS_SETTINGS));
    assert.deepEqual(serializeSupplierLensSettings({ topN: 3, unit: 'kg' }), { topN: 3 });
    assert.deepEqual(serializeSupplierLensSettings({ topN: 6, unit: 'blocks' }), { unit: 'blocks' });
    assert.ok(!isDefaultSupplierLensSettings({ topN: 6, unit: 'blocks' }));
    // Settings live under their OWN module row, so one lens's save cannot erase another's.
    assert.ok(
      code(SUPPLIER_PANEL).includes('SUPPLIER_LENS_ID'),
      'the panel does not key its settings on the lens id',
    );
  });

  check('a rejected top-N is a SENTENCE, never a throw — and both ends are refused', () => {
    const low = setTopN(0);
    assert.equal(low.ok, false);
    if (!low.ok) assert.ok(/at least 1/.test(low.message), low.message);
    const high = setTopN(13);
    assert.equal(high.ok, false);
    if (!high.ok) assert.ok(/12/.test(high.message), high.message);
    const frac = setTopN(6.5);
    assert.equal(frac.ok, false);
    const ok = setTopN(4);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.topN, 4);
    // The typed input is parsed, not coerced.
    assert.equal(parseTopNInput('  ').ok, false);
    assert.equal(parseTopNInput('abc').ok, false);
    assert.equal(parseTopNInput('6.5').ok, false);
    const parsed = parseTopNInput(' 8 ');
    assert.ok(parsed.ok && parsed.value === 8);
  });

  check('there are NO band names, and that is deliberate', () => {
    // A supplier band already has a name — the supplier's. Renaming it would let the
    // legend disagree with the yard about whose charcoal it is.
    const body = code(SUPPLIER_SETTINGS);
    assert.ok(!/bandNames/.test(body), 'the supplier lens grew a band-name document');
    assert.ok(!/bandNames/.test(code(SUPPLIER_PANEL)), 'the supplier panel renames a band');
  });

  check('the FIXTURE drives the REAL three-lens frame, with a REAL delay', () => {
    const fixture = 'app/dev/table-playground/supplierlens/supplierlens-fixture.tsx';
    const page = 'app/dev/table-playground/supplierlens/page.tsx';
    const body = read(fixture);
    assert.ok(/<BlockingLensPanel/.test(body), 'the fixture does not mount the real frame');
    for (const lens of ['PRICE_LENS', 'AGE_LENS', 'SUPPLIER_LENS']) {
      assert.ok(body.includes(lens), `the fixture does not offer ${lens}`);
    }
    assert.ok(/adapter=\{supplierAdapter\}/.test(body), 'the supplier port is not injected');
    // A microtask-resolving stub hides the spinner, the placeholder chip and every race.
    assert.ok(/const FIXTURE_LATENCY_MS = 300;/.test(body), 'the fixture adapter has no realistic delay');
    assert.ok(/await sleep\(FIXTURE_LATENCY_MS\)/.test(body), 'a fixture read resolves in a microtask');
    assert.ok(/l\.canShow\(caps\)/.test(body), 'the fixture does not filter by each lens\'s own canShow');
    // Gated twice, and no data access of any kind.
    assert.ok(
      /process\.env\.NODE_ENV === 'production' && !process\.env\.TABLE_PLAYGROUND/.test(read(page)),
      'the fixture is not gated in production',
    );
    for (const f of ['createClient', '@/lib/supabase', 'getUserRole', 'canViewPrices()']) {
      assert.ok(!body.includes(f), `the fixture reaches for ${f}`);
    }
  });
}

// ===========================================================================
console.log('\n11a. THE SUPPLIER BAND TABLE\'S LAST COLUMN — ₱/kg, OR MIXED (2026-09-22)');
// ===========================================================================
//
// The owner, on the live supplier-lens print: *"I don't get the last column — 'kg dominant'
// — kind of useless. Replace it with average weighted price or something."* He was right: a
// band row already carried `Blocks` and `Kg`, so a third kilogram figure said nothing a
// reader could act on. What a type-checker cannot see, and what a data-layer test cannot:
// that the new column is the PAYLOAD's own weighted price rather than a TypeScript average,
// that a NULL prints an em dash and never ₱0, that the column is ABSENT (not blank, not ₱0)
// for a reader without the effective price flag with `Mixed` in its place, that the
// dominant-kg figure survived on the settings popover's detail line, and that the price and
// age sheets did not move.
{
  const supplier = code(SUPPLIER_PANEL);
  const sheet = code(`${LENS_DIR}/lens-summary-print.tsx`);

  check('the BAND column is the payload\'s `kgWeightedPhpKg` — not a fold, not `dominantKg`', () => {
    // The figure and the accounting pair both read the published key, verbatim.
    assert.ok(
      /figure: priced\s*\?\s*b\.kgWeightedPhpKg === null/.test(supplier),
      'the band figure is not the published weighted ₱/kg',
    );
    assert.ok(
      /figureAccounting:\s*priced && b\.kgWeightedPhpKg !== null/.test(supplier),
      'the accounting cell is not bound to the published weighted ₱/kg',
    );
    // `dominantKg` is GONE from the printed band figure — that was the owner's complaint.
    const printBlock = supplier.slice(supplier.indexOf('const printModel'), supplier.indexOf('/** THE BAR'));
    assert.ok(
      !/figure: `\$\{formatLensKg\(b\.dominantKg\)\} dominant`/.test(printBlock),
      'the printed band figure is still "N kg dominant"',
    );
    // And no TypeScript average anywhere near it. A weighted mean is SQL's, always.
    assert.ok(!/\.reduce\s*\(/.test(supplier), 'the supplier panel folds a figure');
    assert.ok(!/[^+]\+=[^=]/.test(supplier), 'the supplier panel accumulates');
    assert.ok(
      !/\/\s*(pricedDominantKg|dominantKg|lens\.total)/.test(supplier),
      'the panel divides to make a weighted price — that mean is `fn_blocking_supplier_lens`\'s',
    );
  });

  check('⚠️ NULL IS AN EM DASH, NEVER ₱0, and the WEIGHT is what says which null it is', () => {
    // The contract's three readings: null + pricesHidden = WITHHELD; null + pricedDominantKg
    // 0 = dominates no priced block; a number = a real price. The panel prints a blank for
    // both nulls and prints ₱0 for neither.
    assert.ok(
      /=== null\s*\?\s*LENS_EMDASH/.test(supplier),
      'a null weighted ₱/kg does not print an em dash',
    );
    assert.ok(
      !/kgWeightedPhpKg \?\? 0/.test(supplier) && !/kgWeightedPhpKg \|\| 0/.test(supplier),
      'a null weighted ₱/kg is COALESCED to zero — that is the L-008 placeholder mistake',
    );
    // The gate reads BOTH halves: the effective cap AND the payload's own statement.
    assert.ok(
      /caps\.canViewPrices && lens !== null && !lens\.pricesHidden/.test(supplier),
      'the price decision does not read both the effective flag and `pricesHidden`',
    );
    assert.ok(
      /const priced = caps\.canViewPrices && !lens\.pricesHidden;/.test(supplier),
      'the printed column\'s own decision does not read both halves',
    );
  });

  check('a price-DENIED reader gets MIXED in its place — the column is never blank', () => {
    assert.ok(
      /bandFigureColumnLabel: priced \? '₱\/kg' : 'Mixed',/.test(supplier),
      'the band column heading does not swap to Mixed when prices are withheld',
    );
    assert.ok(
      /\$\{b\.mixedBlockCount\.toLocaleString\(\)\} mixed/.test(supplier),
      'the price-denied band cell does not carry the published mixed-block count',
    );
    assert.ok(
      /\$\{lens\.total\.mixedBlockCount\.toLocaleString\(\)\} mixed/.test(supplier),
      'the price-denied footer does not carry the published yard mixed-block count',
    );
    // And the footer's qualifier follows the column: `avg of priced` only qualifies a price.
    assert.ok(
      /figureNote: priced \? 'avg of priced' : '',/.test(supplier),
      'the footer note does not follow the column it qualifies',
    );
  });

  check('the FOOTER is the payload\'s yard figure, labelled `avg of priced` like Price\'s', () => {
    assert.ok(
      /figure: priced\s*\?\s*lens\.total\.kgWeightedPhpKg === null/.test(supplier),
      'the footer is not the published yard weighted ₱/kg',
    );
    // The SAME words the price lens uses, because it is the same documented asymmetry —
    // the counts cover every occupied block, the price covers the priced ones.
    assert.ok(/figureNote: 'avg of priced'/.test(code(PANEL)), 'the price lens lost its footer label');
  });

  check('the ACCOUNTING layout is the Excel Standard, and the SHEET still formats nothing', () => {
    // ₱ pinned LEFT, number pinned RIGHT, tabular figures — `flex justify-between`.
    assert.ok(/flex justify-between gap-1 tabular-nums/.test(sheet), 'the ₱ cell is not the accounting layout');
    assert.ok(/\{acc\.symbol\}/.test(sheet) && /\{acc\.amount\}/.test(sheet), 'the accounting cell is not two slots');
    // Both slots are the LENS's strings. The sheet must still not know how a peso is written.
    assert.ok(!/formatLens/.test(sheet), 'the sheet formats a figure itself');
    assert.ok(!/toFixed\(/.test(sheet) && !/toLocaleString\(/.test(sheet), 'the sheet formats a number itself');
    assert.ok(!/₱/.test(sheet), 'the sheet spells a currency glyph — that is the lens\'s to supply');
    // FOUR decimals, as SQL publishes the weighted mean — the same precision the CONTEXT
    // quotes (₱43.5690), so the sheet cannot silently round a peso away.
    assert.ok(
      /minimumFractionDigits: 4, maximumFractionDigits: 4/.test(supplier),
      'the printed ₱/kg is no longer at the payload\'s own four decimals',
    );
  });

  check('the DOMINANT-kg figure survived — on the settings popover\'s detail line ONLY', () => {
    // It is still the attribution the TINT is drawn from, so it must stay readable
    // SOMEWHERE; the popover is where a reader goes to ask what a colour means.
    assert.ok(
      /`\$\{formatLensKg\(b\.dominantKg\)\} dominant`/.test(supplier),
      'the dominant kilograms vanished from the band detail line too',
    );
    assert.ok(
      /`\$\{formatLensKg\(b\.apportionedKg\)\} apportioned`/.test(supplier),
      'the detail line stopped naming the apportioned attribution beside it',
    );
    // BOTH attributions on one line is the whole point — see the panel's header note.
    assert.ok(/DOMINANCE/.test(read(SUPPLIER_PANEL)) && /APPORTIONED/.test(read(SUPPLIER_PANEL)));
  });

  check('the PRICE and AGE band tables did NOT move', () => {
    // Neither states a band heading of its own, and neither supplies an accounting pair —
    // so `bandFigureColumnLabel ?? figureColumnLabel` and the plain `figure` branch keep
    // their sheets byte-for-byte what they were.
    for (const panel of [PANEL, AGE_PANEL]) {
      const body = code(panel);
      assert.ok(!/bandFigureColumnLabel/.test(body), `${panel} grew a second band-column heading`);
      assert.ok(!/figureAccounting/.test(body), `${panel} grew an accounting cell`);
    }
    // The sheet's fallback is what makes that true.
    assert.ok(
      /\{model\.bandFigureColumnLabel \?\? model\.figureColumnLabel\}/.test(sheet),
      'the band table no longer falls back to the per-block column heading',
    );
  });

  check('the FIXTURE can produce the price-DENIED payload, so the Mixed column is reachable', () => {
    const fixture = read('app/dev/table-playground/supplierlens/supplierlens-fixture.tsx');
    assert.ok(
      /pricesHidden: !canViewPrices,/.test(fixture),
      'the rig cannot produce a WITHHELD supplier payload, so the Mixed column cannot be looked at',
    );
    assert.ok(
      /kgWeightedPhpKg: canViewPrices \?/.test(fixture) &&
        /pricedDominantKg: canViewPrices \?/.test(fixture),
      'the rig withholds only one of the two ₱ keys',
    );
    assert.ok(
      /makeSupplierLens\(cells, n, canViewPrices\)/.test(fixture),
      'the rig does not wire ?prices= into the supplier payload',
    );
  });
}

// ===========================================================================
console.log('\n12. THE YARD MAP PAGE (2026-09-22)');
// ===========================================================================
//
// The owner: *"I'd like to see the actual block arrangement in our app to be printed in
// SOLID colors… make the block loc (C-19A, etc.) right in the middle and in BIG font…
// show ALL blocks in one landscape page."*
//
// Node has no renderer and no font engine, so what it CAN prove is everything except how
// the paper looks: that the page exists for all three lenses, that the geometry is the
// grid's own rather than a literal, that a band's fill is the ramp's own triple, that the
// ink rule exists exactly once and picks the more legible side, that the fit is the
// PLATFORM solver rather than a private copy, and that nothing on the map does arithmetic
// on a kilogram. The look itself is proven by a REAL headless-Chrome PDF over the
// `/dev/table-playground/supplierlens` rig (see `blocking/CONTEXT.md` for the measured
// cell edge, the font and the page counts).
{
  const model = code(YARD_MAP_MODEL);
  const sheet = code(YARD_MAP_PRINT);
  const summary = code(`${LENS_DIR}/lens-summary-print.tsx`);
  const PRINT_PANELS = [PANEL, AGE_PANEL, SUPPLIER_PANEL];

  check('ALL THREE lenses carry the map, built from the SAME `bandOf` as their tables', () => {
    for (const panel of PRINT_PANELS) {
      const body = code(panel);
      assert.ok(/buildLensYardMap\(\{/.test(body), `${panel} builds no yard map`);
      assert.ok(/yardMap,/.test(body), `${panel} does not put the map in its print model`);
      // THE one-lookup rule: the map and the per-band tables must bucket identically, or
      // a block could be in one band on the map and another in the table beneath it.
      const buckets = /bandOf: \(loc\) => lens\.bandByBlock\[loc\]/g;
      assert.ok(
        (body.match(buckets) ?? []).length >= 2,
        `${panel} does not hand the map the same bandOf its buckets use`,
      );
    }
    assert.ok(/yardMap: LensYardMap;/.test(summary), 'the print model has no yard map');
    assert.ok(/<LensYardMapPage/.test(summary), 'the sheet never renders the map page');
  });

  check('the map takes its OWN page and cannot spill onto a second one', () => {
    const rules = summary.slice(summary.indexOf('LENS_SUMMARY_PRINT_RULES'));
    assert.ok(/lens-print-yardmap \{[\s\S]{0,200}break-before: page/.test(rules), 'the map does not start a page');
    assert.ok(/lens-print-yardmap \{[\s\S]{0,200}break-inside: avoid/.test(rules), 'the map may split across sheets');
    assert.ok(
      /page-break-inside: avoid/.test(rules),
      'the map has no legacy break-inside fallback',
    );
    assert.ok(/className="lens-print-yardmap"/.test(sheet), 'the page does not wear the scoped class');
  });

  // ── The GEOMETRY is the grid's, not a literal ─────────────────────────────
  check('the map reads `WAREHOUSES` and states NO slot count of its own', () => {
    assert.ok(/from '\.\.\/constants'/.test(model), 'the map does not read the grid geometry');
    for (const [rel, body] of [[YARD_MAP_MODEL, model], [YARD_MAP_PRINT, sheet]] as const) {
      assert.ok(
        !/\b(220|238|240|18)\b/.test(body.replace(/\d+px|\d+pt|\d+mm/g, ' ')),
        `${rel} hardcodes a slot count — the geometry has exactly one declaration`,
      );
    }
    // And the slot key is built the way `blocking-grid.tsx` builds it.
    assert.ok(/\$\{key\}-\$\{col\}\$\{row\}/.test(model), 'the map invents its own block_loc format');
    assert.ok(
      /`\$\{whseKey\}-\$\{col\}\$\{row\}`/.test(code(GRID)),
      'the grid changed how it spells a block_loc — the map now disagrees with it',
    );
  });

  check('EVERY slot is drawn, counted from the constants — and the count is the geometry', () => {
    const expected = Object.values(WAREHOUSES).reduce(
      (a, w) => a + w.cols * w.rows.length,
      0,
    );
    const standard = Object.entries(WAREHOUSES)
      .filter(([k]) => k.length === 1)
      .reduce((a, [, w]) => a + w.cols * w.rows.length, 0);
    const empty = buildLensYardMap({ data: {}, bandOf: () => undefined });
    assert.equal(empty.slotCount, standard, 'an empty yard does not draw every standard slot');
    assert.equal(empty.occupiedCount, 0);
    // PCA/PCB are OPT-IN **INDEPENDENTLY**, the way the grid's two filter chips are:
    // absent with no stock, present with it, and one does not drag the other in.
    assert.ok(!empty.sections.some((s) => s.key.length > 1), 'PCA/PCB drawn with no stock in them');
    const onlyPca = buildLensYardMap({ data: { 'PCA-15A': BLOCK_STUB }, bandOf: () => undefined });
    assert.ok(onlyPca.sections.some((s) => s.key === 'PCA'), 'PCA absent although the yard has stock in it');
    assert.ok(
      !onlyPca.sections.some((s) => s.key === 'PCB'),
      'an empty PCB was drawn because PCA had stock — the two are separate chips on the grid',
    );
    const both = buildLensYardMap({
      data: { 'PCA-15A': BLOCK_STUB, 'PCB-17C': BLOCK_STUB },
      bandOf: () => undefined,
    });
    assert.equal(both.slotCount, expected, 'the opt-in sections are not the rest of the geometry');
    // They share ONE lane. A lane each shrinks every other cell on the page.
    const lanes = new Set(both.sections.filter((s) => s.key.length > 1).map((s) => s.lane));
    assert.equal(lanes.size, 1, 'PCA and PCB took a lane each — every other cell shrinks');
  });

  check('a block that is NOT a slot on this layout is NAMED, never silently dropped', () => {
    const m = buildLensYardMap({
      data: { 'A-1A': BLOCK_STUB, 'FEEDING # 2': BLOCK_STUB, 'ZZ-99Z': BLOCK_STUB },
      bandOf: () => 0,
    });
    assert.deepEqual([...m.offMapLocs], ['FEEDING # 2', 'ZZ-99Z']);
    assert.equal(m.occupiedCount, 1, 'an off-map block was counted as occupying a slot');
    assert.ok(/offMapLocs\.length > 0/.test(sheet), 'the sheet never says it could not place a block');
  });

  // ── The FILL is the PRINT palette's own triple ────────────────────────────
  check('a banded cell wears the PRINT palette\'s triple — never a class, never a literal', () => {
    for (const ramp of ['cost', 'age', 'category'] as const) {
      const stops = LENS_PRINT_FILL_RGB[ramp];
      for (let stop = 0; stop < stops.length; stop += 1) {
        const paint = lensYardMapPaint(
          { loc: 'A-1A', lines: ['A-1A'], occupied: true, band: 3, mixed: false },
          ramp,
          new Map([[3, stop]]),
        );
        assert.equal(paint.kind, 'banded');
        assert.equal(
          paint.bg,
          `rgb(${stops[stop]})`,
          `${ramp} stop ${stop} is not the PRINT palette's fill`,
        );
        // AND it is NOT the screen ramp — the whole point of the second table. (Nothing in
        // either table repeats a value across ramps, so a coincidence cannot mask this.)
        assert.notEqual(
          paint.bg,
          `rgb(${LENS_RAMP_RGB[ramp][stop]})`,
          `${ramp} stop ${stop} still paints the SCREEN saturation solid`,
        );
      }
    }
    // The class prefixes must not appear: on paper the fill is SOLID, and `.lens-band-3`
    // is a 22% wash that the print stage would render as a pale tint.
    assert.ok(!/lens-band-|lens-age-|lens-cat-/.test(model), 'the map model spells a ramp class');
    assert.ok(!/lens-band-|lens-age-|lens-cat-/.test(sheet), 'the map sheet spells a ramp class');
    assert.ok(/printFillRgbAtStop/.test(model), 'the map does not read the PRINT palette');
    // And it must not reach for the SCREEN accessor at all — that is the single edit that
    // would silently put white ink back on half the map.
    for (const [rel, body] of [[YARD_MAP_MODEL, model], [YARD_MAP_PRINT, sheet]] as const) {
      assert.ok(
        !/rampRgbAtStop|LENS_RAMP_RGB/.test(body),
        `${rel} reads the SCREEN ramp — the map paints solid and must use LENS_PRINT_FILL_RGB`,
      );
    }
    // The LEGEND swatch is the same fill as the cells, or it describes a different map.
    assert.ok(
      /const rgb = printFillRgbAtStop\(/.test(sheet),
      'the map legend swatch no longer reads the PRINT palette',
    );
  });

  // ── The three PROPERTIES the print palette is chosen for ──────────────────
  //
  // `lens-ramp.ts` states all three in prose over `LENS_PRINT_FILL_RGB`, and prose is
  // not a control (the deliveries latch's whole lesson). They are pinned here so a
  // future palette edit that reached for a darker fill, a different hue or a flat
  // ordinal ramp fails the check instead of quietly landing on paper — which is the
  // exact failure the owner asked about: *"verify these are easy to read when printed
  // on lower-quality printers."*
  check('⚠️ BLACK INK ON EVERY PRINT FILL, at ≥ 7:1 — the white branch is unreachable', () => {
    const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    let worst = Infinity;
    for (const ramp of ['cost', 'age', 'category'] as const) {
      for (const rgb of LENS_PRINT_FILL_RGB[ramp]) {
        const L = lensYardMapLuminance(rgb);
        // ABOVE the contrast-parity crossover, so `lensYardMapInkOn` cannot answer white.
        assert.ok(
          L > LENS_YARD_MAP_INK_CROSSOVER,
          `${ramp} print fill ${rgb} (L ${L.toFixed(4)}) is dark enough to flip the loc to WHITE ink`,
        );
        assert.equal(
          lensYardMapInkOn(rgb),
          LENS_YARD_MAP_DARK_INK,
          `${ramp} print fill ${rgb} does not take the near-black ink`,
        );
        worst = Math.min(worst, ratio(L, 0));
      }
    }
    // Measured 2026-09-22: 7.75:1 (age stop 6, the deep-fuchsia tint). The floor is 7.0
    // rather than that exact figure so a hue may be nudged; a fill that drops below it
    // is a different palette and should be re-argued, not re-baselined.
    assert.ok(worst >= 7, `the worst print fill is only ${worst.toFixed(2)}:1 against black`);
  });

  check('⚠️ a PRINT fill is a WHITE TINT of its own SCREEN hue — same hue angle, ≤ 2°', () => {
    // This is what lets a reader match the map's legend swatch against the BAND TABLE's
    // saturated `.lens-cat-N` swatch on page one. Measured max deviation 0.79°.
    const hue = (triple: string): number => {
      const [r, g, b] = triple.trim().split(/\s+/).map((n) => Number(n) / 255);
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      if (d === 0) return NaN; // the neutral zinc — no hue to preserve
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const ramp of ['cost', 'age', 'category'] as const) {
      LENS_PRINT_FILL_RGB[ramp].forEach((print, i) => {
        const a = hue(print);
        const b = hue(LENS_RAMP_RGB[ramp][i]);
        if (Number.isNaN(a) || Number.isNaN(b)) return;
        const raw = Math.abs(a - b) % 360;
        const dev = raw > 180 ? 360 - raw : raw;
        assert.ok(dev <= 2, `${ramp}[${i}] shifted ${dev.toFixed(2)}° off its screen hue`);
      });
    }
  });

  check('⚠️ the SEQUENTIAL ramps stay MONOTONIC in tone — a GREYSCALE print still reads', () => {
    // A mono printer keeps the tone and loses the hue, so "dearer" / "older" has to stay
    // readable as "darker". Measured min adjacent gap: cost 0.0751, age 0.0780.
    for (const ramp of ['cost', 'age'] as const) {
      const Ls = LENS_PRINT_FILL_RGB[ramp].map(lensYardMapLuminance);
      let minGap = Infinity;
      for (let i = 1; i < Ls.length; i += 1) {
        assert.ok(
          Ls[i] < Ls[i - 1],
          `${ramp} stop ${i} is not darker than stop ${i - 1} — the ordinal ramp lost its order`,
        );
        minGap = Math.min(minGap, Ls[i - 1] - Ls[i]);
      }
      assert.ok(
        minGap >= 0.06,
        `${ramp}'s closest adjacent stops differ by only ${minGap.toFixed(4)} in luminance`,
      );
    }
  });

  check('⚠️ the NOMINAL ramp is deliberately FLAT, and `others` is deliberately NOT', () => {
    // A supplier is not "more" than another supplier, so a tone gradient would invite a
    // reading that does not exist. The stated consequence — the twelve are told apart in
    // greyscale by the legend, the loc and the dashed mixed outline, never by tone — is
    // only honest while they actually are flat. Measured 0.6973 … 0.7027.
    const twelve = LENS_PRINT_FILL_RGB.category.slice(0, LENS_CATEGORY_NEUTRAL_STOP).map(
      lensYardMapLuminance,
    );
    assert.equal(twelve.length, 12, 'the categorical ramp is no longer twelve hues + a neutral');
    const spread = Math.max(...twelve) - Math.min(...twelve);
    assert.ok(spread <= 0.02, `the twelve categorical tints span ${spread.toFixed(4)} in luminance`);
    // The neutral `others` IS separated — from the twelve, and from the map's own
    // muted/no-data grey, which is the fill it would otherwise be confused with.
    const others = lensYardMapLuminance(LENS_PRINT_FILL_RGB.category[LENS_CATEGORY_NEUTRAL_STOP]);
    assert.ok(
      Math.min(...twelve) - others >= 0.1,
      `the \`others\` neutral is only ${(Math.min(...twelve) - others).toFixed(4)} below the nearest hue`,
    );
    const muted = lensYardMapLuminance(
      LENS_YARD_MAP_MUTED_BG.replace(
        /^#(..)(..)(..)$/,
        (_m, r: string, g: string, b: string) =>
          `${parseInt(r, 16)} ${parseInt(g, 16)} ${parseInt(b, 16)}`,
      ),
    );
    assert.ok(
      muted - others >= 0.1,
      `the \`others\` neutral is only ${(muted - others).toFixed(4)} below the map's muted grey`,
    );
  });

  check('⚠️ THE LUMINANCE RULE EXISTS EXACTLY ONCE, and picks the MORE legible ink', () => {
    // One definition, in the model. The sheet must not compute a second one.
    assert.equal((model.match(/function lensYardMapInkOn/g) ?? []).length, 1);
    assert.ok(!/0\.2126|0\.7152|0\.0722/.test(sheet), 'the sheet computes its own luminance');
    assert.ok(
      !/#ffffff|#18181b/.test(sheet.replace(/LENS_YARD_MAP_[A-Z_]+/g, ' ')),
      'the sheet hardcodes an ink colour instead of reading the rule',
    );
    // The crossover is the contrast-parity point, not a taste value.
    assert.ok(
      Math.abs(LENS_YARD_MAP_INK_CROSSOVER - (Math.sqrt(1.05 * 0.05) - 0.05)) < 5e-4,
      'the ink crossover is no longer the white/black contrast-parity luminance',
    );
    // And on every hue the ramps actually declare, the chosen ink WINS on contrast.
    const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    for (const ramp of ['cost', 'age', 'category'] as const) {
      for (const rgb of LENS_RAMP_RGB[ramp]) {
        const L = lensYardMapLuminance(rgb);
        const ink = lensYardMapInkOn(rgb);
        const white = ratio(L, 1.0);
        const black = ratio(L, 0.0);
        const chose = ink === '#ffffff' ? white : black;
        assert.ok(
          chose >= Math.max(white, black) - 1e-9,
          `${ramp} hue ${rgb} took the LESS legible ink (white ${white.toFixed(2)} vs black ${black.toFixed(2)})`,
        );
      }
    }
  });

  check('GREY is two answers, and only ONE of them draws a dash', () => {
    const hidden = lensYardMapPaint(
      { loc: 'A-1A', lines: ['A-1A'], occupied: true, band: 2, mixed: false },
      'cost',
      new Map([[0, 0]]), // band 2 is isolated OUT
    );
    assert.equal(hidden.kind, 'muted', 'an isolated-out band is not muted on the map');
    const unplaced = lensYardMapPaint(
      { loc: 'A-1A', lines: ['A-1A'], occupied: true, band: null, mixed: false },
      'cost',
      new Map([[0, 0]]),
    );
    assert.equal(unplaced.kind, 'nodata', 'a block in NO band is not marked as such');
    assert.equal(hidden.bg, unplaced.bg, 'the two greys diverged — the dash is the distinction');
    const empty = lensYardMapPaint(
      { loc: 'A-1A', lines: ['A-1A'], occupied: false, band: null, mixed: false },
      'cost',
      new Map([[0, 0]]),
    );
    assert.equal(empty.kind, 'empty');
    assert.equal(empty.bg, '#ffffff', 'an empty slot is not white');
    // The dash rides on the `nodata` kind, in the sheet, and nowhere else.
    assert.ok(/kind === 'nodata'/.test(sheet), 'the sheet does not mark the no-data cells');
  });

  check('a MIXED block keeps its dashed INSET outline, in the ink rather than the hue', () => {
    const paint = lensYardMapPaint(
      { loc: 'A-1A', lines: ['A-1A'], occupied: true, band: 0, mixed: true },
      'category',
      new Map([[0, 0]]),
    );
    assert.equal(paint.outline, paint.ink, 'the mixed dash is not the colour that is legible on the fill');
    assert.ok(/outlineOffset: '-2px'/.test(sheet), 'the mixed marker is not INSET — it reads as a selection ring');
    assert.ok(/dashed/.test(sheet), 'the mixed marker is not dashed');
    // Only the SUPPLIER lens can answer the question, and it reads the carried column.
    assert.ok(
      /isMixed: \(loc\) => lens\.blockByLoc\[loc\]\?\.isMixed === true/.test(code(SUPPLIER_PANEL)),
      'the supplier lens does not hand the map the VIEW\'s own ALL/SOME column',
    );

    // ── RESTATED 2026-09-22, NOT WEAKENED ───────────────────────────────────
    // This used to ban the WORD `isMixed` from the price panel outright, which was the
    // right shape of guard while `fn_blocking_price_lens` had no supplier fact in it at
    // all. Migration `20260922093000` gave it one — `blockByLoc[loc].isMixed`, the VIEW's
    // own `supplier_count_in_block > 1` column — and the printed price sheet's new SUPPLIER
    // column legitimately reads it, to decide whether a block's dominant supplier is the
    // WHOLE pile or only part of it.
    //
    // So the ban moves onto the property it was always protecting: **the price lens must
    // not tell the YARD MAP about mixedness.** The map's dashed inset outline is the
    // supplier lens's marker, and a price map drawing it would be describing a filter it
    // is not applying. The AGE panel keeps the blanket ban — its payload carries no
    // supplier fact of any kind, so the word appearing there at all would be an invention.
    const priceYardMapCall = code(PANEL).slice(
      code(PANEL).indexOf('buildLensYardMap('),
      code(PANEL).indexOf('buildLensYardMap(') + 240,
    );
    assert.ok(priceYardMapCall.startsWith('buildLensYardMap('), 'the price lens stopped drawing a yard map');
    assert.ok(
      !/isMixed/.test(priceYardMapCall),
      'the PRICE lens hands the yard map a mixed flag — that marker belongs to the supplier lens',
    );
    // And where it DOES read it, it reads the carried column rather than a list length.
    assert.ok(
      /b\.isMixed !== true/.test(code(PANEL)),
      'the price sheet\'s supplier column does not read the VIEW\'s own ALL/SOME column',
    );
    assert.ok(
      !/suppliers\.length/.test(code(PANEL)),
      'the price panel re-derives mixedness from a list length',
    );
    assert.ok(!/isMixed/.test(code(AGE_PANEL)), `${AGE_PANEL} claims to know whether a block is mixed`);
  });

  // ── The FIT is the PLATFORM solver ────────────────────────────────────────
  check('the fit is the SHARED solver, and that solver has ZERO tenant vocabulary', () => {
    assert.ok(
      /from '@\/components\/shared\/print\/print-fit'/.test(sheet),
      'the map page does not use the platform fit module',
    );
    assert.ok(/fitCellGrid\(\{/.test(sheet), 'the map does not call the shared cell-grid solver');
    assert.ok(!/A4_|PX_PER_MM|297|210/.test(sheet), 'the map page re-derives the paper geometry');
    // The CODE, not the prose: the module's header DISCLAIMS these words by name, which
    // is exactly the kind of sentence a raw-source scan would trip over.
    const fitSrc = code(PRINT_FIT);
    for (const word of [
      'charcoal', 'block', 'warehouse', 'batch', 'supplier', 'lens', 'blocking',
      'campaign', 'php', 'peso', '₱',
    ]) {
      assert.ok(
        !new RegExp(word, 'i').test(fitSrc),
        `the platform fit module names a tenant concept: "${word}"`,
      );
    }
    assert.ok(!/import .* from/.test(fitSrc), 'the platform fit module grew a dependency');
  });

  check('the solve is MEASURED — the shipped geometry lands where CONTEXT.md says', () => {
    // These two shapes are the whole population: the standard four warehouses, and the
    // same plus PCA/PCB. Both were rendered to a REAL PDF at these exact numbers.
    const run = (data: Record<string, typeof BLOCK_STUB>) => {
      const m = buildLensYardMap({ data, bandOf: () => 0 });
      return fitCellGrid({
        sections: m.sections.map((s) => ({
          key: s.key, cols: s.cols.length, rows: s.rows.length, lane: s.lane,
        })),
        box: a4LandscapeBox(10),
        reservedHeightPx: 40,
        gutterPx: 16,
        laneChromePx: 22,
        laneGapPx: 5,
        sectionGapPx: 8,
        cellChromePx: 2,
        minCellPx: 20,
        maxCellPx: 64,
        labelChars: m.labelChars,
        advanceEm: 0.65,
        fontLadderPt: [13, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7],
      });
    };
    const std = run({ 'A-1A': BLOCK_STUB });
    const pca = run({ 'A-1A': BLOCK_STUB, 'PCA-15A': BLOCK_STUB, 'PCB-17C': BLOCK_STUB });
    assert.ok(std.fits && pca.fits, 'a shipped yard shape no longer fits one sheet');
    assert.equal(std.cellRowCount, 11, 'the standard warehouses no longer total 11 cell rows');
    assert.equal(pca.cellRowCount, 14, 'PCA/PCB no longer add exactly 3 cell rows');
    assert.ok(std.cellPx > 51 && std.cellPx < 52, `standard cell moved to ${std.cellPx}px`);
    assert.ok(pca.cellPx > 39 && pca.cellPx < 40, `worst-case cell moved to ${pca.cellPx}px`);
    // And the LOC is never smaller than the legibility floor, because the page wraps
    // rather than shrinks below it. `pca` solves to 8.5 unwrapped, so it MUST wrap.
    assert.ok(std.fontPt >= LENS_YARD_MAP_MIN_LOC_PT, `standard loc fell to ${std.fontPt}pt`);
    assert.ok(pca.fontPt < LENS_YARD_MAP_MIN_LOC_PT, 'the worst case no longer needs the wrap');
    const wrapped = fitMonoLabelPt({
      widthPx: pca.labelBoxPx,
      chars: buildLensYardMap({ data: { 'PCA-15A': BLOCK_STUB }, bandOf: () => 0 }).wrappedLabelChars,
      advanceEm: 0.65,
      ladder: [13, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7],
      maxPt: (pca.labelBoxPx - 5.5 * PX_PER_PT) / 2 / (PX_PER_PT * 1.1),
    });
    assert.ok(
      wrapped >= LENS_YARD_MAP_MIN_LOC_PT,
      `wrapping the worst case still only reaches ${wrapped}pt`,
    );
    assert.ok(wrapped > pca.fontPt, 'wrapping made the loc SMALLER, which is the wrong trade');
  });

  check('a loc is WRAPPED, never truncated — the whole code is always on the paper', () => {
    assert.deepEqual([...lensYardMapLines('A', 'A-20C')], ['A-20C']);
    assert.deepEqual([...lensYardMapLines('PCA', 'PCA-15A')], ['PCA', '15A']);
    assert.deepEqual([...lensYardMapLines('A', 'A-20C', true)], ['A', '20C']);
    const m = buildLensYardMap({ data: { 'PCA-15A': BLOCK_STUB }, bandOf: () => 0 });
    assert.equal(m.labelChars, 5, 'the unwrapped worst-case label is no longer `A-20C`');
    assert.equal(m.wrappedLabelChars, 3, 'the wrapped worst-case label moved');
    for (const body of [model, sheet]) {
      // `slice(0, cut)` IS the hyphen split and is allowed; a NUMERIC bound is not, and
      // neither is a CSS ellipsis — both would shorten a code a person has to read.
      assert.ok(!/\.slice\(\s*0\s*,\s*\d/.test(body), 'a loc is cut to a fixed length');
      assert.ok(!/substring|substr\(|truncate|text-ellipsis|…/.test(body), 'a loc is truncated');
    }
  });

  // ── It carries NOTHING but a location ─────────────────────────────────────
  check('the map is LOCATION REFERENCE ONLY — no kg, no ₱, no age, no supplier', () => {
    for (const [rel, body] of [[YARD_MAP_MODEL, model], [YARD_MAP_PRINT, sheet]] as const) {
      for (const forbidden of [
        'balance', 'total_in', 'php', 'peso', 'cost', 'price', 'ageDays', 'kg',
        'formatLens', 'toFixed', 'toLocaleString',
      ]) {
        assert.ok(
          !new RegExp(`\\b${forbidden}\\b`).test(body),
          `${rel} reaches for \`${forbidden}\` — the map draws a loc and a fill, nothing else`,
        );
      }
      assert.ok(!/\.reduce\s*\(/.test(body), `${rel} folds something`);
      assert.ok(!/\+=/.test(body), `${rel} accumulates`);
    }
    // And the sheet says so on the paper, so a reader never mistakes it for a report.
    assert.ok(/location\s*\n?\s*reference only/.test(read(YARD_MAP_PRINT)), 'the map never states what it is for');
  });

  check('the page is explicitly LIGHT, like the rest of the sheet it lives on', () => {
    // It lays out in the LIVE DOM, so a theme token prints whatever theme the reader is
    // in. Every surface is an explicit zinc/hex.
    assert.ok(
      !/bg-background|bg-card|bg-muted|text-foreground|text-muted-foreground|border-border/.test(sheet),
      'the map page uses a theme token and will print dark for a dark-mode reader',
    );
    assert.ok(/text-zinc-/.test(sheet), 'the map page lost its explicit light inks');
  });

  check('the map and the band swatches resolve their stop through ONE function', () => {
    assert.ok(/resolveBandRampStop/.test(code(RAMP)), 'the shared stop resolver is gone');
    assert.ok(/resolveBandRampStop/.test(sheet), 'the map decides a band stop itself');
    assert.ok(/resolveBandRampStop/.test(summary), 'the band swatch decides its stop itself');
    // Ordinal: position. Nominal: the lens's own slot. Same answers, one implementation.
    assert.equal(resolveBandRampStop('cost', 1, 3), rampStop(1, 3, 'cost'));
    assert.equal(resolveBandRampStop('category', 1, 7, categoryStop(6, true)), LENS_CATEGORY_NEUTRAL_STOP);
  });

  check('the MARGIN is stated once and read by both the @page rule and the solve', () => {
    assert.ok(/export const LENS_PRINT_MARGIN_MM = 10;/.test(summary), 'the sheet margin is no longer exported');
    assert.ok(/marginMm: LENS_PRINT_MARGIN_MM/.test(summary), 'the @page rule uses a different margin');
    assert.ok(/marginMm=\{LENS_PRINT_MARGIN_MM\}/.test(summary), 'the map solves against a different margin');
    assert.ok(/a4LandscapeBox\(marginMm\)/.test(sheet), 'the map does not solve against the sheet\'s own box');
  });

  check('the FIXTURE can produce BOTH map shapes, so the worst case is reachable', () => {
    const fixture = read('app/dev/table-playground/supplierlens/supplierlens-fixture.tsx');
    assert.ok(/MOCK_PREPARED_BLOCKS/.test(fixture), 'the rig cannot put stock in PCA/PCB');
    assert.ok(/params\.get\('pca'\) === '1'/.test(fixture), 'the rig has no ?pca= switch');
    assert.ok(/'PCA-/.test(fixture) && /'PCB-/.test(fixture), 'the rig names neither prepared area');
  });
}

// ===========================================================================
console.log("\n13. PAGE ONE'S CONTEXT BLOCKS, AND THE PRICE SHEET'S SECOND PASS (2026-09-22)");
// ===========================================================================
//
// The owner's review of the live lens prints asked for four more things, and this section
// is where the three that are about the LENSES live (the fourth, the shipped default basis,
// is pinned in §5 where the settings parser is proven):
//
//   PRICE SHEET   each `WHSE X` heading starts a FRESH PAGE, the band heading repeating
//                 above it as a small running line; the warehouse SUBTOTAL's seven lab
//                 cells and its ₱/kg FILLED IN from `warehouseSubtotals`; and a SUPPLIER
//                 column per block between BATCH and BALANCE.
//   PAGE ONE      a MARKET table + chart on the price sheet, and PRICE vs VOLUME panels +
//                 table on the supplier sheet, under the ratio bar.
//
// ── WHAT THIS SECTION IS GUARDING ───────────────────────────────────────────
// Every one of those figures is a field of a payload, and the temptation each time is to
// fold one in TypeScript instead — a subtotal's MC is a weighted mean, a supplier's share
// is a ratio, a market average is Σ money ÷ Σ priced kg. §2 already bans `reduce` and `+=`
// in the four new files outright. What is asserted HERE is the half a source scan cannot
// see: that the figures are LOOKUPS with the right blank fallback, proven by RUNNING the
// two models; that the price sheet's three additions are absent from the other two sheets,
// so their pages are provably unchanged; and that both context reads are print-only and
// take their SECTION AWAY rather than emptying it when they refuse.
{
  const panel = code(PANEL);
  const agePanel = code(AGE_PANEL);
  const supplierPanel = code(SUPPLIER_PANEL);
  const sheet = code(SUMMARY_PRINT);
  const model = code(SUMMARY_MODEL);
  const marketModel = code(MARKET_MODEL);
  const marketPrint = code(MARKET_PRINT);
  const supplierMarketPrint = code(SUPPLIER_MARKET_PRINT);
  const chart = code(PRINT_CHART);
  const EM = '—';

  // ── (a) ONE PAGE PER WAREHOUSE — the PRICE sheet only ─────────────────────

  check('the PRICE sheet pages per WAREHOUSE, and the other two sheets keep MERGED groups', () => {
    assert.ok(/warehousePages: true,/.test(panel), 'the price sheet no longer pages per warehouse');
    for (const [body, label] of [[agePanel, 'age'], [supplierPanel, 'supplier']] as const) {
      assert.ok(
        !/warehousePages/.test(body),
        `the ${label} sheet started paging per warehouse — its tables were byte-for-byte unchanged and must stay so`,
      );
    }
    // The flag is OPTIONAL on the shared model, so "absent" is the age/supplier shape
    // rather than an explicit `false` somebody could invert by accident.
    assert.ok(/warehousePages\?: boolean;/.test(sheet), 'the paging flag became mandatory');
    assert.ok(
      /model\.warehousePages \? \(/.test(sheet.replace(/\s+/g, ' ')),
      'the sheet no longer branches on the paging flag',
    );
  });

  check('the break rules exist, and the FIRST warehouse rides the BAND\'s own page break', () => {
    // A fresh sheet per later warehouse…
    assert.ok(
      /\[data-lens-print\] \.lens-print-whse-page \{ break-before: page; page-break-before: always; \}/.test(sheet),
      'a warehouse no longer starts a fresh sheet',
    );
    // …and the band's own break still exists, unchanged.
    assert.ok(
      /\[data-lens-print\] \.lens-print-band \{ break-before: page; page-break-before: always; \}/.test(sheet),
      'a band no longer starts a fresh sheet',
    );
    // THE FIRST warehouse must NOT take a second break, or every band opens on a blank page.
    assert.ok(
      /i === 0 \? 'lens-print-band' : 'lens-print-whse-page'/.test(sheet),
      'the first warehouse of a band takes its own break — every band would open on a blank sheet',
    );
    // The repeated band line and each warehouse heading must not be stranded at a page foot.
    assert.ok(
      /\[data-lens-print\] \.lens-print-band-run \{ break-after: avoid; \}/.test(sheet),
      'the repeated band line can be stranded above a page boundary',
    );
    assert.ok(
      /\[data-lens-print\] \.lens-print-whse-page h2 \{ break-after: avoid; \}/.test(sheet),
      'a warehouse heading can be stranded at a page foot',
    );
    assert.ok(/lens-print-band-run/.test(sheet), 'the running band line lost its class');
    // ⚠️ THE HEADING IS SAID ONCE. Measured on a real PDF (2026-09-22): the paged sheet
    // printed `WHSE A 10 BLOCKS · 1,047,000 KG` as an `<h2>` and AGAIN as the table's own
    // first row, one line below it. The merged sheets keep the in-table row — it is what
    // separates one warehouse from the next inside a single table — so this is a flag, not
    // a deletion, and its default is the merged behaviour.
    assert.ok(
      /showWarehouseHeadingRow = true/.test(sheet),
      'the in-table warehouse heading stopped defaulting on — the merged sheets would lose their group separators',
    );
    assert.ok(
      /showWarehouseHeadingRow=\{false\}/.test(sheet),
      'the paged sheet prints its warehouse heading twice',
    );
    assert.ok(/\{showWarehouseHeadingRow && \(/.test(sheet), 'the in-table heading row is unconditional again');
  });

  check('the BAND TOTAL is stated exactly ONCE per band — on its LAST warehouse', () => {
    assert.ok(
      /showBandTotal=\{i === band\.warehouses\.length - 1\}/.test(sheet),
      'the band total is no longer pinned to the last warehouse page',
    );
    // And the merged (age / supplier) path still states it, unconditionally.
    assert.ok(/showBandTotal$/m.test(sheet) || /showBandTotal\s*$/m.test(sheet), 'the merged path lost its band total');
    // The EXCLUDED page has no band, so it must have no band total either.
    assert.ok(
      /showBandTotal=\{false\}/.test(sheet),
      'the excluded-population table prints a band total for a band that does not exist',
    );
  });

  check('the printed PAGE COUNT follows the paging, per (band × warehouse)', () => {
    // A count that still said "one page per band" would be the first thing to go stale, and
    // it is the only place the sheet states its own shape out loud.
    assert.ok(/function blockPageCount\(/.test(sheet), 'the page count is no longer a named function');
    assert.ok(
      /if \(!model\.warehousePages\) return model\.bands\.length;/.test(sheet),
      'the merged sheets no longer count one page per band',
    );
    assert.ok(
      /Math\.max\(1, b\.warehouses\.length\)/.test(sheet),
      'a band with no warehouse group counts zero pages — it still prints the sentence that says so',
    );
    assert.ok(/blockPageCount\(model\) \+/.test(sheet.replace(/\s+/g, ' ')), 'the count label does not use it');
  });

  // ── (b) THE SUBTOTAL AND BAND-TOTAL FIGURES — a lookup, run for real ──────

  check('the subtotal figures are a LOOKUP of `warehouseSubtotals`, keyed by (band × warehouse)', () => {
    assert.ok(
      /lens\.warehouseSubtotals\.map\(\(s\) => \[`\$\{s\.bandIndex\}\|\$\{s\.warehouse\}`, s\]\)/.test(panel),
      'the price panel no longer indexes the published (band × warehouse) rows',
    );
    assert.ok(/figuresOf: \(bandIndex, warehouse\) =>/.test(panel), 'the panel passes no figures lookup');
    // A pair SQL emitted no row for gets NULL, and NULL is what prints the blank row.
    assert.ok(/if \(!s\) return null;/.test(panel), 'a missing (band × warehouse) row is invented rather than left blank');
    // OPTIONAL on the shared bucketing, so "absent" is the age/supplier shape rather than
    // an explicit value somebody could invert.
    assert.ok(
      /figures\?: LensSummaryGroupFigures \| null;/.test(model),
      'the group figures became mandatory on the shared bucketing',
    );
    assert.ok(
      /totalFigures\?: LensSummaryGroupFigures \| null;/.test(sheet),
      'the band-total figures became mandatory on the shared sheet',
    );
    // And the BAND TOTAL reads the band row the same way its warehouse children do.
    assert.ok(/totalFigures: buildLensGroupFigures\(/.test(panel), 'the band total no longer reads the payload row');
    // The two sheets with no such published partition must pass NEITHER.
    for (const [body, label] of [[agePanel, 'age'], [supplierPanel, 'supplier']] as const) {
      assert.ok(!/figuresOf/.test(body), `the ${label} panel passes a group-figures lookup it has no payload for`);
      assert.ok(!/totalFigures/.test(body), `the ${label} panel passes band-total figures it has no payload for`);
    }
  });

  check('`buildLensGroupFigures` RENDERS the published means and WEIGHTS nothing — run it', () => {
    // Two groups, same seven means, DIFFERENT group kilograms. If the function weighted
    // anything at all, the lab strings would move between them. They must be identical.
    const stats: BlockingLensLabStats = {
      wMc: 11.234, mcKg: 500_000,
      wAsh: 3.456, ashKg: 500_000,
      wBdAstm: 0.41234, bdAstmKg: 500_000,
      wBdJis: 0.42678, bdJisKg: 500_000,
      wGrit: 1.5, gritKg: 500_000,
      wVm: 18.049, vmKg: 500_000,
      wFc: 78.951, fcKg: 500_000,
    };
    const a = buildLensGroupFigures(stats, 500_000, '₱48.50', (n) => `${n} kg`);
    const b = buildLensGroupFigures(stats, 9_000_000, '₱48.50', (n) => `${n} kg`);
    // The Excel Standard: BD → 3 dp, the other five → 2 dp. The payload's own digits.
    assert.equal(a.lab.mc, '11.23');
    assert.equal(a.lab.ash, '3.46');
    assert.equal(a.lab.bdAstm, '0.412');
    assert.equal(a.lab.bdJis, '0.427');
    assert.equal(a.lab.grit, '1.50');
    assert.equal(a.lab.vm, '18.05');
    assert.equal(a.lab.fc, '78.95');
    assert.equal(a.figure, '₱48.50', 'the figure is not the caller\'s own preformatted string');
    assert.deepEqual(b.lab, a.lab, 'the lab strings moved with the GROUP kilograms — something is being weighted');
  });

  check('a NULL mean is an EM DASH, never a 0 — and a 0 coverage weight is a real 0', () => {
    // The live shape: MC measured over the whole group, the other six not measured at all.
    // `avg_ash = 0` on the grid means "no ASH figure", so SQL excludes it and publishes NULL.
    const stats: BlockingLensLabStats = {
      wMc: 11.5, mcKg: 400_000,
      wAsh: null, ashKg: 0,
      wBdAstm: null, bdAstmKg: 0,
      wBdJis: null, bdJisKg: 0,
      wGrit: null, gritKg: 0,
      wVm: null, vmKg: 0,
      wFc: null, fcKg: 0,
    };
    const f = buildLensGroupFigures(stats, 400_000, EM, (n) => `${n} kg`);
    assert.equal(f.lab.mc, '11.50');
    for (const k of ['ash', 'bdAstm', 'bdJis', 'grit', 'vm', 'fc'] as const) {
      assert.equal(f.lab[k], EM, `a NULL ${k} did not print an em dash`);
      assert.notEqual(f.lab[k], '0.00', `a NULL ${k} printed as zero — the L-008 placeholder in a lab coat`);
    }
    // A stat with NO mean already prints an em dash, so "over 0 kg" beside it would be noise.
    assert.equal(f.coverageNote, '', 'an unmeasured stat was given a coverage note as well as a dash');
  });

  check('the COVERAGE NOTE names ONLY the stats short of the group, and names their kilograms', () => {
    // The live shape, measured 2026-09-22: every block carries MC, eleven read 0 on the
    // other six. One shared "lab kg" would be wrong for MC or wrong for the rest.
    const stats: BlockingLensLabStats = {
      wMc: 11.5, mcKg: 1_000_000,
      wAsh: 3.2, ashKg: 800_000,
      wBdAstm: 0.41, bdAstmKg: 800_000,
      wBdJis: null, bdJisKg: 0,
      wGrit: 1.1, gritKg: 1_000_000,
      wVm: 18.0, vmKg: 1_000_000,
      wFc: 78.0, fcKg: 1_000_000,
    };
    const f = buildLensGroupFigures(stats, 1_000_000, '₱40.00', (n) => `${n.toLocaleString()} kg`);
    assert.equal(f.coverageNote, 'ash over 800,000 kg · bd astm over 800,000 kg');
    assert.ok(!f.coverageNote.includes('mc'), 'a stat covering the WHOLE group was reported as short');
    assert.ok(!f.coverageNote.includes('bd jis'), 'an UNMEASURED stat was reported as short rather than dashed');
    // The note is the SHEET's to render conditionally; it must never be printed empty.
    assert.ok(
      /coverageNote !== ''/.test(sheet),
      'the sheet prints the coverage note unconditionally — an empty note would add a blank annotation',
    );
  });

  check('a lens with NO published partition prints the BLANK subtotal row it always did', () => {
    // The fallback lives in ONE component, so the subtotal and the band total can never
    // disagree about what a missing figure looks like.
    const flat = sheet.replace(/\s+/g, ' ');
    assert.ok(/function LabCells\(/.test(sheet), 'the seven subtotal cells are no longer one component');
    assert.ok(/figures \? figures\.lab\[k\] : null/.test(flat), 'a missing figure no longer prints an empty cell');
    assert.ok(
      /<LabCells figures=\{w\.figures\} className=\{TD_SMALL\} \/>/.test(flat),
      'the warehouse subtotal does not render the shared cells',
    );
    assert.ok(
      /<LabCells figures=\{band\.totalFigures\} className=\{TD\} \/>/.test(flat),
      'the band total does not render the shared cells',
    );
    // And the figure cell beside them follows the same fallback.
    assert.ok(/w\.figures \? w\.figures\.figure : null/.test(flat), 'a missing subtotal figure prints something');
  });

  // ── (c) THE SUPPLIER COLUMN — price sheet only ────────────────────────────

  check('the SUPPLIER column is bound to `dominantSupplierDisplay`, and is PRICE-SHEET only', () => {
    assert.ok(/blockSupplierColumnLabel: 'Supplier',/.test(panel), 'the price sheet lost its supplier column');
    assert.ok(/supplierOf: \(loc\) =>/.test(panel), 'the price panel passes no per-block supplier');
    assert.ok(
      /b\.dominantSupplierDisplay/.test(panel),
      'the supplier cell is not the payload\'s own RAW spelling',
    );
    assert.ok(/b\.dominantSharePct/.test(panel), 'a mixed block\'s share is not the payload\'s own');
    // ⚠️ NEVER re-derived from a list length — the ALL/SOME rule is a carried COLUMN.
    assert.ok(!/suppliers\.length/.test(panel), 'the price panel re-derives mixedness from a list length');
    // Absent means the column does not EXIST — not an empty column.
    assert.ok(
      /blockSupplierColumnLabel\?: string;/.test(sheet),
      'the supplier heading became mandatory, so the age and supplier tables would grow an empty column',
    );
    assert.ok(
      /const withSupplier = supplierColumnLabel !== undefined;/.test(sheet),
      'the sheet no longer decides the column from the heading\'s presence',
    );
    for (const [body, label] of [[agePanel, 'age'], [supplierPanel, 'supplier']] as const) {
      assert.ok(
        !/blockSupplierColumnLabel/.test(body),
        `the ${label} sheet grew a per-block supplier column — its table widths were unchanged and must stay so`,
      );
      assert.ok(!/supplierOf:/.test(body), `the ${label} panel passes a per-block supplier it has no payload for`);
    }
  });

  check('BOTH column-width tables sum to EXACTLY 100%, so no `table-fixed` column crushes', () => {
    // "Never crush, always scroll" on paper: `table-fixed` redistributes whatever does not
    // add up, and the column that absorbs it is the one that silently crushes.
    const widthsOf = (name: string): number[] => {
      const m = sheet.match(new RegExp(`${name} = \\[([^\\]]+)\\]`));
      assert.ok(m, `${name} is gone from the sheet`);
      return [...m![1].matchAll(/'([\d.]+)%'/g)].map((x) => Number(x[1]));
    };
    const oneOf = (name: string): number => {
      const m = sheet.match(new RegExp(`${name} = '([\\d.]+)%'`));
      assert.ok(m, `${name} is gone from the sheet`);
      return Number(m![1]);
    };
    const plain =
      widthsOf('BLOCK_COL_WIDTHS').reduce((a, b) => a + b, 0) +
      7 * oneOf('LAB_COL_WIDTH') +
      oneOf('FIGURE_COL_WIDTH');
    const withSupplier =
      widthsOf('BLOCK_COL_WIDTHS_WITH_SUPPLIER').reduce((a, b) => a + b, 0) +
      7 * oneOf('LAB_COL_WIDTH_WITH_SUPPLIER') +
      oneOf('FIGURE_COL_WIDTH_WITH_SUPPLIER');
    assert.equal(plain, 100, `the age/supplier table sums to ${plain}%, not 100%`);
    assert.equal(withSupplier, 100, `the price table sums to ${withSupplier}%, not 100%`);
    // Three lead columns without the supplier, four with it — and the label cell of a
    // subtotal row must span everything LEFT of the balance, whichever shape it is.
    assert.equal(widthsOf('BLOCK_COL_WIDTHS').length, 3);
    assert.equal(widthsOf('BLOCK_COL_WIDTHS_WITH_SUPPLIER').length, 4);
    assert.ok(/const labelSpan = leadCols - 1;/.test(sheet), 'the subtotal label span is no longer derived from the columns');
  });

  check('a block with NO delivery row reads an EM DASH — proven by running the bucketing', () => {
    const lab = { bd_astm: 0.4, bd_jis: 0.42, ash: 3, mc: 11, grit: 1, vm: 18, fc: 78 };
    const data: Record<string, BlockData> = {
      'A-1A': { batch_code: 'X1', batch_id: 'x1', status: 'STORED', balance: 100, total_in: 100, php: 40, ...lab },
      'A-2A': { batch_code: 'X2', batch_id: 'x2', status: 'STORED', balance: 90, total_in: 90, php: 40, ...lab },
      'B-1A': { batch_code: 'X3', batch_id: 'x3', status: 'STORED', balance: 80, total_in: 80, php: 40, ...lab },
    };
    // The panel's own three cases: whole pile · mixed · no supplier at all.
    const supplierOf = (loc: string) =>
      loc === 'A-1A' ? 'Ornales' : loc === 'A-2A' ? 'Llanto 71%' : EM;
    const { byBand } = buildLensSummaryBuckets({
      data,
      bandOf: () => 0,
      figureOf: () => '₱40.00',
      sortKeyOf: (_l, b) => b.balance,
      formatKg: (n) => String(n),
      formatBlocks: (n) => String(n),
      excludedFigure: EM,
      supplierOf,
      figuresOf: () => null,
    });
    const rows = (byBand.get(0) ?? []).flatMap((g) => g.rows);
    assert.deepEqual(
      rows.map((r) => r.supplier),
      ['Ornales', 'Llanto 71%', EM],
      'the bucketing does not carry the supplier cell through verbatim',
    );
    // And WITHOUT a `supplierOf` the field is absent, which is what removes the column.
    const bare = buildLensSummaryBuckets({
      data,
      bandOf: () => 0,
      figureOf: () => '₱40.00',
      sortKeyOf: (_l, b) => b.balance,
      formatKg: (n) => String(n),
      formatBlocks: (n) => String(n),
      excludedFigure: EM,
    });
    for (const g of bare.byBand.get(0) ?? []) {
      for (const r of g.rows) {
        assert.equal(r.supplier, undefined, 'a lens that passes no supplier still gets a supplier cell');
      }
      assert.equal(g.figures, null, 'a lens that passes no figures lookup still gets group figures');
    }
  });

  // ── (d) PAGE ONE'S TWO CONTEXT BLOCKS, AND THEIR GATE ─────────────────────

  check('page one\'s context is a NODE — the shared sheet learns no market vocabulary', () => {
    assert.ok(/page1Extra\?: React\.ReactNode;/.test(sheet), 'the context block became a model the sheet must understand');
    assert.ok(/\{model\.page1Extra\}/.test(sheet), 'the sheet does not render the context block');
    for (const word of ['market', 'quarter', 'correlation', 'premium', 'supplierMarket']) {
      assert.ok(
        !new RegExp(`\\b${word}`, 'i').test(sheet),
        `the shared sheet reaches for \`${word}\` — page one's context must stay a node it cannot read`,
      );
    }
    // It still formats nothing and still spells no currency glyph.
    assert.ok(!/toFixed\(/.test(sheet) && !/toLocaleString\(/.test(sheet), 'the sheet formats a number itself');
    assert.ok(!/₱/.test(sheet), 'the shared sheet spells a peso');
  });

  check('the MARKET read is PRINT-ONLY, fired ONCE, and takes its SECTION away on a refusal', () => {
    assert.ok(/fetchMarketContext: \(months: number\)/.test(panel), 'the market read is not on the adapter port');
    assert.ok(
      /fetchMarketContext\(BLOCKING_MARKET_CONTEXT_DEFAULT_MONTHS\)/.test(panel),
      'the panel does not ask for the shipped twelve months',
    );
    // Fired ONCE per mount: an EMPTY dependency list. A settings-shaped dependency would
    // re-read a series that cannot move when a reader drags a cut line.
    assert.ok(
      /setMarketContext\(res\.ok \? res\.context : null\);/.test(panel),
      'a refusal no longer clears the market context',
    );
    assert.ok(/setMarketContext\(null\);/.test(panel), 'a thrown error no longer clears the market context');
    assert.ok(
      /\}, \[\]\);/.test(panel.slice(panel.indexOf('fetchMarketContext'))),
      'the market read is no longer fired exactly once on mount',
    );
    // ABSENT, never blank.
    assert.ok(
      /marketSection === null \? null : <LensMarketContextSection/.test(panel.replace(/\s+/g, ' ')),
      'a missing market context renders an empty section instead of none',
    );
    // And it must be nowhere near the classify read — the bar, chips and tint work without it.
    assert.ok(
      !/fetchMarketContext[\s\S]{0,400}?fetchLens\(/.test(panel),
      'the market read got entangled with the band read',
    );
    // No spinner, no banner, no toast: it is not an operational fact anyone is waiting on.
    assert.ok(
      !/errorToast[\s\S]{0,120}?[Mm]arket[Cc]ontext/.test(panel),
      'the print-only market read raises a toast a reader cannot act on',
    );
  });

  check('the SUPPLIER MARKET read is gated BEFORE the request, and its section is ABSENT not empty', () => {
    assert.ok(
      /if \(!caps\.canViewPrices \|\| namedKeysSig === ''\) \{/.test(supplierPanel),
      'the supplier market read is no longer gated before the request',
    );
    // The two halves, both of them: the EFFECTIVE cap AND the payload's own statement.
    assert.ok(
      /!priced \|\| market === null/.test(supplierPanel),
      'the printed section no longer requires BOTH the effective price flag and a landed read',
    );
    assert.ok(
      /marketSection === null \? null : <LensSupplierMarketSection/.test(supplierPanel.replace(/\s+/g, ' ')),
      'a price-denied or failed supplier market renders an empty section instead of none',
    );
    // `others` IS NOT A SUPPLIER: only the NAMED bands' keys are ever asked about.
    assert.ok(/!b\.isOthers && b\.key !== null/.test(supplierPanel), 'the fold band is asked about as if it were a supplier');
    // And the rest of that sheet stays unconditional — Production walks the yard.
    assert.ok(
      !/market[\s\S]{0,80}<LensYardMapPage/.test(supplierPanel),
      'the yard map became conditional on the market read',
    );
  });

  check('the supplier key signature uses a VISIBLE separator, and the file holds no raw control byte', () => {
    // The effect SPLITS the signature back apart, so `join('')` would hand the action one
    // character per LETTER — a read that succeeds, matches nothing, and prints an empty
    // table naming every band as having no history. A literal U+0001 typed into the source
    // works and is INVISIBLE in a diff, which is the same bug wearing a disguise.
    assert.ok(
      /const SUPPLIER_KEY_SIG_SEP = '\\u0001';/.test(supplierPanel),
      'the key separator is not a named constant written as an escape',
    );
    assert.ok(/namedKeys\.join\(SUPPLIER_KEY_SIG_SEP\)/.test(supplierPanel), 'the signature joins on something else');
    assert.ok(/namedKeysSig\.split\(SUPPLIER_KEY_SIG_SEP\)/.test(supplierPanel), 'the keys are split on something else');
    assert.ok(!/\.join\(''\)/.test(supplierPanel), 'the signature joins on the empty string');
    for (const rel of [SUPPLIER_PANEL, PANEL, AGE_PANEL, MARKET_MODEL, MARKET_PRINT, SUPPLIER_MARKET_PRINT, PRINT_CHART]) {
      assert.ok(
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(read(rel)),
        `${rel} contains a RAW control character — invisible in a diff, and a formatter may eat it`,
      );
    }
  });

  check('the MARKET print model COMPUTES NOTHING — run it and read the strings back', () => {
    const ctx = fixtureMarketContext();
    const m = buildLensMarketPrintModel({
      context: ctx,
      basisPhpKg: 39.1816,
      basisLabel: "This quarter's deliveries",
      highlight: { kind: 'currentQuarter' },
    });
    // 3 months + 2 quarters + YTD + trailing-12m.
    assert.equal(m.rows.length, 7, `the market table has ${m.rows.length} rows, not 7`);
    assert.deepEqual(
      m.rows.map((r) => r.kind),
      ['month', 'month', 'month', 'quarter', 'quarter', 'span', 'span'],
    );
    // Every figure is the payload's, at the price sheet's own two decimals.
    assert.equal(m.rows[0].price, '₱44.92');
    assert.equal(m.rows[0].kg, '1,284,500 kg');
    assert.equal(m.rows[0].deliveries, '78');
    assert.equal(m.rows[0].suppliers, '9');
    // NULL IS NEVER 0 — a month with kilos but no priced ones reads an em dash.
    assert.equal(m.rows[1].price, EM, 'an unpriced month printed a price');
    // A quarter/span row publishes no supplier count, so the cell is EMPTY, not a zero.
    assert.equal(m.rows[3].suppliers, '');
    // The CURRENT quarter is flagged, named and highlighted — and it is the only highlight.
    assert.ok(m.rows[4].label.includes('(current)'), 'the current quarter is not flagged');
    assert.equal(m.rows.filter((r) => r.highlighted).length, 1, 'more than one row claims to be the basis');
    assert.equal(m.rows[4].highlighted, true, 'the current quarter is not the highlighted row');
    // A PARTIAL quarter at the window edge says so rather than reading as a full one.
    assert.equal(m.rows[3].note, '2 of 3 months');
    // The chart's twelve… here three points, one of them a genuine GAP.
    assert.equal(m.chart.points.length, 3);
    assert.equal(m.chart.points[1].line, null, 'an unpriced month was drawn at zero instead of left as a gap');
    assert.deepEqual(m.chart.points.map((p) => p.tick), ['Oct', 'Nov', 'Dec']);
    // The reference line IS the lens's own basis.
    assert.equal(m.chart.refLine?.label, '₱39.18');
    // And the domain covers the basis, so the dashed line cannot fall off the plot.
    assert.ok(
      m.chart.lineDomain[0] <= 39.1816 && m.chart.lineDomain[1] >= 39.1816,
      'the chart domain excludes the reference level',
    );
    // A CAPTION IS A LIST OF FACTS, and it names the basis rather than inventing a row.
    assert.ok(m.caption.includes('3 of 50 months'), 'the caption does not state its coverage');
    assert.ok(m.caption.includes("this quarter's deliveries"), 'the caption does not name the basis');
    assert.ok(m.caption.includes('as of 2026-09-22'), 'the caption does not state the as-of date');
  });

  check('the basis HIGHLIGHT is decided from the basis\'s OWN anchor — an aggregate highlights NOTHING', () => {
    const ctx = fixtureMarketContext();
    const run = (highlight: Parameters<typeof buildLensMarketPrintModel>[0]['highlight']) =>
      buildLensMarketPrintModel({ context: ctx, basisPhpKg: 40, basisLabel: 'x', highlight }).rows.filter(
        (r) => r.highlighted,
      );
    // A calendar month's `fromDate` IS that month's first day, so no date arithmetic happens.
    const month = run({ kind: 'month', month: '2025-12-01' });
    assert.equal(month.length, 1);
    assert.equal(month[0].key, 'm-2025-12-01');
    // `last_3_months`, `trailing_days` and a TYPED price are aggregates this table carries no
    // row for. Inventing one would put a figure on the sheet that no view publishes.
    assert.equal(run(null).length, 0, 'an aggregate basis highlighted a row the payload does not publish');
    // A month the window does not contain highlights nothing rather than the nearest row.
    assert.equal(run({ kind: 'month', month: '2024-01-01' }).length, 0, 'an out-of-window month matched a row');
    // The panel's own mapping: only the two calendar months read `fromDate`, only
    // `this_quarter` reads the current quarter, everything else highlights nothing.
    assert.ok(
      /settings\.basis === 'this_month' \|\| settings\.basis === 'last_month'/.test(panel),
      'the panel no longer decides a month highlight from the two calendar bases',
    );
    assert.ok(/kind: 'month', month: activeBasis\.fromDate/.test(panel), 'the month highlight is not the window anchor');
    assert.ok(/kind: 'currentQuarter'/.test(panel), 'the quarter basis highlights nothing');
  });

  check('the SUPPLIER MARKET model computes nothing, and NAMES a band it has no series for', () => {
    const market = fixtureSupplierMarket();
    const m = buildLensSupplierMarketPrintModel({
      market,
      displayByKey: new Map([['ORNALES', 'Ornales'], ['LAYUPAN', 'Layupan']]),
      // A third band was asked about and the payload has no series for it.
      requestedKeys: ['ORNALES', 'LAYUPAN', 'SEVILLA'],
      maxPanels: 1,
    });
    // Every row is a supplier; the PANEL count is capped but the TABLE lists them all.
    assert.equal(m.rows.length, 2, 'the table dropped a supplier the payload published');
    assert.equal(m.panels.length, 1, 'the panel cap was ignored');
    // The LENS's pretty spelling, joined on `key` — the view publishes only the canonical.
    assert.equal(m.rows[0].supplier, 'Ornales');
    assert.equal(m.panels[0].title, 'Ornales');
    // The payload's own figures, verbatim: four decimals on ₱/kg, two on the pair.
    assert.equal(m.rows[0].kg, '5,620,744 kg');
    assert.equal(m.rows[0].phpKg, '₱44.9225');
    assert.equal(m.rows[0].firstLast, '₱50.86 → ₱44.92');
    assert.equal(m.rows[0].changePct, '-11.7%', 'a change figure lost its sign');
    assert.equal(m.rows[0].direction, '↓ down');
    assert.equal(m.rows[0].corr, '0.26', 'the correlation is not two decimals');
    assert.equal(m.rows[0].premium, '+₱0.4968', 'a premium above market lost its plus sign');
    // ⚠️ NULL IS NEVER 0 and never "flat": under three priced months there is no correlation,
    // and a direction is a CLAIM.
    assert.equal(m.rows[1].corr, 'n/a (2 m)', 'a two-month correlation printed a number');
    assert.equal(m.rows[1].direction, EM, 'a NULL direction printed "flat"');
    assert.equal(m.rows[1].premium, EM, 'an unknown premium printed zero');
    assert.equal(m.rows[1].firstLast, EM, 'an unpriced end printed a pair');
    // The SPINE is the WINDOW's, so a quiet supplier gets a GAP, not a shorter chart.
    assert.equal(m.panels[0].points.length, market.months.length);
    // The footer: the SELECTION beside the WHOLE market.
    assert.equal(m.footer.label, '2 suppliers shown');
    assert.equal(m.footer.kg, '5,720,744 kg');
    assert.ok(m.footer.note.includes('whole market 14,144,848 kg'), 'the footer does not state the whole market');
    // A band with no series is NAMED, never dropped in silence.
    assert.ok(m.omittedNote.includes('SEVILLA'), 'a requested band with no history vanished silently');
    assert.ok(m.caption.includes('direction dead band 2%'), 'the caption does not state the dead band');
    // EACH INK SAYS WHAT IT MEANS. Measured on a real PDF: the line's swatch used to carry
    // the whole caption, so the legend stated the AREA's meaning twice and the line's never.
    assert.equal(m.areaLegend, 'kilograms delivered (area, left)');
    assert.equal(m.lineLegend, '₱/kg (line, right)');
    assert.ok(!m.chartCaption.includes('kilograms'), 'the caption repeats the legend it sits under');
    assert.ok(m.chartCaption.includes('scales to its own range'), 'the caption stopped saying panels are autoscaled');
    assert.ok(m.chartCaption.includes('a gap is a month'), 'the caption stopped explaining a gap');
  });

  check('`printChartDomain` is an AXIS RANGE, not a statistic — and it never hides a level', () => {
    // It is `Math.min`/`Math.max` over values the payload published, which is geometry.
    const [lo, hi] = printChartDomain([10, 20]);
    assert.ok(lo < 10 && hi > 20, 'the domain does not pad, so a series runs along the frame');
    assert.equal(lo, 10 - 0.8);
    assert.equal(hi, 20 + 0.8);
    // A reference level is INCLUDED, or the dashed line draws off the plot.
    const withRef = printChartDomain([10, 20], 99);
    assert.ok(withRef[1] >= 99, 'the domain excludes a reference level above the series');
    // Twelve identical prices is a real answer: a ZERO span, which the chart draws down the
    // middle rather than on an edge.
    assert.deepEqual(printChartDomain([7, 7, 7]), [7, 7]);
    // Nulls are skipped, not read as zero — and an all-null series is not a crash.
    assert.deepEqual(printChartDomain([null, undefined]), [0, 1]);
    assert.deepEqual(printChartDomain([5, null], null), printChartDomain([5]));

    // ⚠️ THE FLOOR — measured on a real PDF (2026-09-22): the volume axis of every
    // price-vs-volume panel read `548t / 254t / −41t`, because an area domain starts at 0 and
    // the 8% pad then pushed its lower bound BELOW zero. A negative tonne is not a quantity.
    const unfloored = printChartDomain([0, 500_000]);
    assert.ok(unfloored[0] < 0, 'the pad no longer reaches below a zero minimum — re-check this guard');
    assert.deepEqual(printChartDomain([0, 500_000], null, 0), [0, 540_000]);
    // It is a FLOOR, not a zero-base: a price axis keeps its own bottom and does not collapse
    // onto zero, or the movement the chart exists to show would flatten out.
    assert.deepEqual(printChartDomain([39, 48], null, 0), [39 - 0.72, 48 + 0.72]);
    // And every call site in the model passes it, on BOTH axes.
    assert.ok(
      /printChartDomain\(prices, basisPhpKg, 0\)/.test(marketModel),
      'the market line domain is no longer floored at zero',
    );
    assert.ok(
      /printChartDomain\(points\.map\(\(p\) => p\.line\), null, 0\)/.test(marketModel),
      'a panel\'s price axis is no longer floored at zero',
    );
    assert.ok(
      /printChartDomain\(\[0, \.\.\.points\.map\(\(p\) => p\.area\)\], null, 0\)/.test(marketModel),
      'a panel\'s VOLUME axis is no longer floored at zero — it will print a negative tonne',
    );
  });

  check('every DEV RIG offers the SHIPPED DEFAULT basis — a rig that does not shows no bands', () => {
    // MEASURED, not hypothetical (2026-09-22): the default moved to `this_quarter` and the
    // three rigs' `BASES` mocks were not given that row, so the price lens opened on a basis
    // that does not exist — `activeBasis` null → no market price → the classify read never
    // fires → no band chip, and a DISABLED Print button. The live page is fine (SQL returns
    // the row), so the only surface that breaks is the only surface a reviewer can look at.
    for (const rig of [
      'app/dev/table-playground/pricelens/pricelens-fixture.tsx',
      'app/dev/table-playground/agelens/agelens-fixture.tsx',
      'app/dev/table-playground/supplierlens/supplierlens-fixture.tsx',
    ]) {
      const body = read(rig);
      assert.ok(
        new RegExp(`basisKey: '${DEFAULT_PRICE_LENS_SETTINGS.basis}'`).test(body),
        `${rig} has no \`${DEFAULT_PRICE_LENS_SETTINGS.basis}\` basis row — its price lens opens on a basis it cannot resolve`,
      );
      // And every basis the select OFFERS should be resolvable on the rig, so switching the
      // dropdown on a fixture can never land on a silent blank.
      for (const key of PRICE_LENS_BASIS_ORDER) {
        if (key === 'manual') continue; // client-side — it needs no basis row
        assert.ok(
          new RegExp(`basisKey: '${key}'`).test(body),
          `${rig} cannot resolve the \`${key}\` basis the select offers`,
        );
      }
    }
  });

  check('the two context SHEETS format NOTHING — one model owns every string on them', () => {
    // The same discipline as the shared summary sheet: if a peso is ever written differently
    // on page one it will be because ONE function changed.
    for (const [rel, body] of [[MARKET_PRINT, marketPrint], [SUPPLIER_MARKET_PRINT, supplierMarketPrint]] as const) {
      assert.ok(!/toFixed\(/.test(body), `${rel} rounds a number itself`);
      assert.ok(!/toLocaleString\(/.test(body), `${rel} groups a number itself`);
      assert.ok(!/₱/.test(body), `${rel} spells a peso — the model owns the glyph`);
      // Explicitly light, like the rest of the sheet: it lays out in the LIVE DOM.
      assert.ok(
        !/bg-background|bg-card|bg-muted|text-foreground|text-muted-foreground|border-border/.test(body),
        `${rel} uses a theme token and will print dark for a dark-mode reader`,
      );
      assert.ok(/text-zinc-/.test(body), `${rel} lost its explicit light inks`);
    }
    // And the MODEL is where the formatting lives — so the split is real, not a coincidence.
    assert.ok(/₱/.test(marketModel), 'the market model no longer owns the peso glyph');
    assert.ok(/toLocaleString\(/.test(marketModel), 'the market model no longer formats');
    // It still does no ARITHMETIC about charcoal: no reduce, no `+=` (§2 bans both), and no
    // division by a total. `Math.min`/`Math.max` over published values is an AXIS RANGE.
    assert.ok(
      !/\/\s*(total|totalKg|marketKg|pricedKg|monthCount)\b/.test(marketModel),
      'the market model divides by a total — every average it prints is SQL\'s',
    );
  });

  check('the printed chart is HAND-DRAWN: no recharts, no theme token, no measurement', () => {
    // Comments stripped: the file's own header EXPLAINS at length why recharts was ruled
    // out, so a scan of the raw source would fail on its own reasoning.
    assert.ok(!/recharts/.test(chart), 'the print chart imports recharts — it measures a frame later');
    assert.ok(!/ResponsiveContainer/.test(chart), 'the print chart sizes itself from a callback');
    assert.ok(!/useState|useEffect|useRef|ResizeObserver/.test(chart), 'the print chart measures or holds state');
    // Explicit ink only: a theme token would print dark for a dark-mode reader.
    assert.ok(!/var\(--/.test(chart), 'the print chart reaches for a CSS variable');
    assert.ok(
      !/bg-background|bg-card|bg-muted|text-foreground|text-muted-foreground|border-border/.test(chart),
      'the print chart uses a theme token and will print dark for a dark-mode reader',
    );
    assert.ok(/printColorAdjust: 'exact'/.test(chart), 'the chart does not force its ink onto paper');
    // Both sheets state their box in PIXELS, for the same reason.
    assert.ok(/const CHART_W_PX = \d+;/.test(marketPrint), 'the market chart has no explicit width');
    assert.ok(/const PANEL_W_PX = \d+;/.test(supplierMarketPrint), 'the supplier panels have no explicit width');
    // A GAP is a gap: a null breaks the run rather than joining across it.
    assert.ok(/current = null;/.test(chart), 'a null no longer breaks the series into runs');
    assert.ok(/v === null \|\| v === undefined \|\| !Number\.isFinite\(v\)/.test(chart), 'the gap test moved');
    // And no currency glyph or number formatting lives in the primitive.
    assert.ok(!/₱/.test(chart), 'the print chart spells a peso');
    assert.ok(!/toLocaleString\(/.test(chart), 'the print chart formats a number');
  });

  check('CONTEXT.md documents all three of the second pass\'s changes, and both context blocks', () => {
    const doc = read(CONTEXT);
    for (const phrase of [
      // The four new files, in Files.
      'lens/lens-print-chart.tsx',
      'lens/lens-market-model.ts',
      'lens/lens-market-print.tsx',
      'lens/lens-supplier-market-print.tsx',
      // JOB 1 — the price sheet's three changes.
      'THE SECOND PASS',
      'ONE PAGE PER WAREHOUSE INSIDE A BAND',
      'warehousePages',
      'showWarehouseHeadingRow',
      'COVERAGE NOTE names only the stats SHORT of the group',
      'A SUPPLIER COLUMN PER BLOCK',
      'blockSupplierColumnLabel',
      // JOB 2 + JOB 3 — page one.
      "PAGE ONE'S CONTEXT BLOCKS",
      'page1Extra',
      'fetchBlockingMarketContext(12)',
      'fetchBlockingSupplierMarket(12, bandKeys)',
      'THE BASIS',
      'THE WHOLE SECTION IS ABSENT',
      'SUPPLIER_KEY_SIG_SEP',
      // The chart decision, and the explicit statement that analytics was not touched.
      'HAND-DRAWN SVG, NOT RECHARTS',
      'that CONTEXT.md is untouched',
      'A VOLUME AXIS MAY NOT RUN BELOW ZERO',
      'LENS_PRINT_CHART_LABEL_PX',
      // The default basis, and the trap that comes with it.
      "This quarter's deliveries",
      'A DEV RIG MUST CARRY THE ROW',
    ]) {
      assert.ok(doc.includes(phrase), `CONTEXT.md does not mention "${phrase}"`);
    }
    // And the claims the second pass RETIRED must be gone, or the doc states two rules.
    assert.ok(
      !/leaves \*\*every lab cell BLANK\*\*/.test(doc),
      'CONTEXT.md still says a warehouse subtotal leaves every lab cell blank',
    );
    assert.ok(
      !/THE UI STEP THAT IS NOT DONE/.test(doc),
      'CONTEXT.md still calls the default-basis flip an outstanding UI step',
    );
  });

  check('every printed label sits at or above the sheet\'s own 7px floor', () => {
    // The lens sheet prints from the LIVE DOM, so its sizes are Tailwind px rather than the
    // `pt` the iframe prints use — the floor is the same idea and 7px is where this sheet
    // has always sat. The first pass drew chart ticks at 5.5 (~4pt on paper).
    assert.equal(LENS_PRINT_CHART_LABEL_PX, 7, 'the chart label size left the floor');
    const files = [SUMMARY_PRINT, MARKET_PRINT, SUPPLIER_MARKET_PRINT, PRINT_CHART, YARD_MAP_PRINT];
    for (const rel of files) {
      const body = read(rel);
      for (const m of body.matchAll(/text-\[([\d.]+)px\]/g)) {
        assert.ok(Number(m[1]) >= 7, `${rel} prints text at ${m[1]}px, below the 7px floor`);
      }
      // A bare numeric `fontSize={n}` on an SVG label must go through the constant, so one
      // axis cannot be shrunk while the others stay put.
      for (const m of body.matchAll(/fontSize=\{([\d.]+)\}/g)) {
        assert.fail(`${rel} hardcodes fontSize=${m[1]} — it must read LENS_PRINT_CHART_LABEL_PX`);
      }
    }
  });
}

// ── The two payload fixtures this section runs the models over ──────────────
//
// Built HERE rather than imported from `app/dev/table-playground/lens-fixture-lab.ts`:
// that module is a dev RIG and reaches for the `@/` alias, and a verify script must not
// depend on a playground staying wired the way it is today. Three months rather than twelve
// keeps the expected strings readable; the SHAPES are the live ones — a month with kilos and
// no priced kilos, a partial quarter at the window edge, a supplier with two priced months.

function fixtureMarketContext(): BlockingMarketContext {
  return {
    monthsRequested: 3,
    asOf: '2026-09-22',
    months: [
      { month: '2025-10-01', marketPhpKg: 44.9159, marketKg: 1_284_500, marketPricedKg: 1_284_500, deliveryCount: 78, activeSuppliers: 9 },
      // ⚠️ KILOS, NO PRICED KILOS — the gap the chart and the table must both respect.
      { month: '2025-11-01', marketPhpKg: null, marketKg: 1_101_300, marketPricedKg: 0, deliveryCount: 66, activeSuppliers: 8 },
      { month: '2025-12-01', marketPhpKg: 45.7412, marketKg: 1_342_880, marketPricedKg: 1_342_880, deliveryCount: 81, activeSuppliers: 10 },
    ],
    quarters: [
      // A PARTIAL quarter at the window edge — `monthCount` is what says so.
      { quarterKey: '2025-Q3', label: 'Q3 2025', quarterStart: '2025-07-01', marketPhpKg: 44.1, marketKg: 900_000, marketPricedKg: 900_000, deliveryCount: 55, monthCount: 2, firstMonth: '2025-08-01', lastMonth: '2025-09-01', isCurrent: false },
      { quarterKey: '2025-Q4', label: 'Q4 2025', quarterStart: '2025-10-01', marketPhpKg: 39.1816, marketKg: 3_728_680, marketPricedKg: 2_627_380, deliveryCount: 225, monthCount: 3, firstMonth: '2025-10-01', lastMonth: '2025-12-01', isCurrent: true },
    ],
    yearToDate: { marketPhpKg: 44.5762, marketKg: 10_416_168, marketPricedKg: 10_304_901, deliveryCount: 628, monthCount: 9, fromDate: '2026-01-01', toDate: '2026-09-30' },
    trailing12m: { marketPhpKg: 44.8002, marketKg: 14_144_848, marketPricedKg: 12_932_281, deliveryCount: 853, monthCount: 12, fromDate: '2025-10-01', toDate: '2026-09-30' },
    latestMonth: { month: '2025-12-01', marketPhpKg: 45.7412, marketKg: 1_342_880, marketPricedKg: 1_342_880, deliveryCount: 81, activeSuppliers: 10, isCurrentMonth: false },
    monthsAvailable: 50,
    monthsReturned: 3,
  };
}

function fixtureSupplierMarket(): BlockingSupplierMarket {
  const months = ['2025-10-01', '2025-11-01', '2025-12-01'];
  const entry = (
    key: string,
    summary: Partial<BlockingSupplierMarketEntry['summary']>,
    series: BlockingSupplierMarketEntry['series'],
  ): BlockingSupplierMarketEntry => ({
    key,
    // The analytics view publishes only the CANONICAL name — the pretty spelling is the
    // LENS's and is joined on `key`, which is what `displayByKey` proves.
    display: key,
    series,
    summary: {
      monthsActive: series.length,
      totalKg: 0,
      totalPricedKg: 0,
      deliveryCount: 0,
      kgWeightedPhpKg: null,
      firstMonth: series[0]?.month ?? null,
      lastMonth: series[series.length - 1]?.month ?? null,
      firstPrice: null,
      lastPrice: null,
      priceChangePhpKg: null,
      priceChangePct: null,
      kgChangePct: null,
      priceVolumeCorr: null,
      corrMonthCount: 0,
      direction: null,
      avgPremiumPhpKg: null,
      ...summary,
    },
  });
  const point = (month: string, kg: number, price: number | null) => ({
    month,
    kg,
    pricedKg: price === null ? 0 : kg,
    avgPricePhpKg: price,
    premiumPhpKg: null,
    shareOfMonthPct: null,
    deliveryCount: 3,
  });
  return {
    monthsRequested: 3,
    asOf: '2026-09-22',
    fromMonth: months[0],
    toMonth: months[months.length - 1],
    directionDeadBandPct: 2,
    supplierKeysRequested: ['ORNALES', 'LAYUPAN', 'SEVILLA'],
    // THE WINDOW'S spine, never the selection's.
    months,
    suppliers: [
      entry(
        'ORNALES',
        {
          totalKg: 5_620_744,
          totalPricedKg: 5_620_744,
          kgWeightedPhpKg: 44.9225,
          firstPrice: 50.86,
          lastPrice: 44.92,
          priceChangePct: -11.67,
          kgChangePct: 18.2,
          priceVolumeCorr: 0.264,
          corrMonthCount: 12,
          direction: 'down',
          avgPremiumPhpKg: 0.4968,
        },
        [point(months[0], 1_800_000, 50.86), point(months[1], 1_900_000, 47.9), point(months[2], 1_920_744, 44.92)],
      ),
      // ⚠️ TWO priced months, a quiet first month, and every judgement NULL rather than 0.
      entry('LAYUPAN', { totalKg: 100_000, totalPricedKg: 0, corrMonthCount: 2 }, [
        point(months[1], 40_000, null),
        point(months[2], 60_000, null),
      ]),
    ],
    supplierCount: 2,
    windowTotal: { marketKg: 14_144_848, marketPricedKg: 12_932_281, marketPhpKg: 44.8002, deliveryCount: 853 },
    selectedTotal: { marketKg: 5_720_744, marketPricedKg: 5_620_744, marketPhpKg: 44.9225, deliveryCount: 40 },
  };
}

console.log(`\n${passed} assertions passed.`);
