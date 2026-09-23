/**
 * verify-blend-analysis-ui.ts — the proofs behind the BLEND ANALYSIS **UI** and the
 * printed LENS SUMMARY.
 *
 * Run: npx tsx scripts/verify-blend-analysis-ui.ts
 *
 * ============================================================================
 * WHAT THIS SCRIPT IS FOR, AND WHAT IT IS DELIBERATELY NOT FOR
 * ============================================================================
 * `scripts/verify-blend-analysis.ts` proves the DATA layer against the live database
 * (71 assertions: the natural-breaks optimum by brute force, the as-of rule, the
 * ₱-deletion gate, every invariant). This one proves the things a data-layer test
 * cannot see and a type-checker will not catch — the properties that rot SILENTLY,
 * because nothing crashes when they break and the screen still renders something:
 *
 *   NO MATHS      a subtotal or a footer figure must be the PAYLOAD's. A `reduce` over
 *                 the block rows would type-check perfectly, agree with the SQL for
 *                 weeks, and then quietly disagree the first time an unmeasured block
 *                 joined the blend — because SQL's averages exclude it and a
 *                 TypeScript fold would not.
 *   THE GATE      the price PAGE, the price CHECKBOX and the price LENS's Print button
 *                 all hang off the grid's EFFECTIVE flag (`serverCanViewPrices &&
 *                 showPrices`), never off the server flag alone. The server deletes the
 *                 whole `price` section regardless; this is the UI half.
 *   UNTRUSTED     the Include-pages choice comes back from a free-form jsonb bag with
 *                 no CHECK constraint. Proven by RUNNING the parser over a hostile
 *                 document, not by reading it.
 *   ONE LABEL     a band must be called the same thing on the grid, in the analysis
 *                 page and on paper — so the two label functions are IMPORTED from the
 *                 lenses, never re-written.
 *   NO `tfoot`    Chrome REPEATS a `<tfoot>` on every printed page, so a total in one
 *                 reads as a duplicated total. Every subtotal and footer is a `<tbody>`
 *                 row, on screen and on paper.
 *   ONE SOURCE    a SAVED version sends `{proposalId, versionNo}` and a live what-if
 *                 sends `{blockLocs}`. Both at once is a refusal by contract, so the
 *                 hook must be structurally incapable of sending both.
 *   THE REQUEST   fired on the MOUNT FRAME and guarded by its own SIGNATURE. A
 *                 debounce-only read is the 2026-09-21 lens stall, and a monotonic
 *                 counter is what made it unrecoverable.
 *   THE RAMP      the printed group tints are a second copy of `globals.css`'s seven
 *                 hues per ramp (an iframe has no stylesheet). The copies are PROVEN
 *                 equal here, which is the project's standing answer to a constant that
 *                 must live in two places.
 *
 * ============================================================================
 * NO ₱ IS PRINTED BY THIS SCRIPT
 * ============================================================================
 * It reads source files and calls pure functions. It opens no database connection and
 * holds no key; the only prices it mentions are literals in a synthetic payload.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  analysisPages,
  analysisPagesLabel,
  includedPageCount,
  BLEND_ANALYSIS_PAGE_ORDER,
  BLEND_INCLUDE_PAGE_ORDER,
  BLEND_ANALYSIS_SETTINGS_MODULE,
  DEFAULT_BLEND_ANALYSIS_OPTIONS,
  parseBlendAnalysisOptions,
  serializeBlendAnalysisOptions,
  wantsAnalysis,
} from '../app/(app)/inventory/_shared/blend-analysis-options';
import {
  BLEND_PRINT_MARGIN_MM,
  buildBlendYardMapModel,
  buildBlendYardMapPage,
  blendYardMapLegend,
  blendYardMapStops,
} from '../app/(app)/inventory/_shared/blend-yard-map-print';
import {
  BLEND_YARD_MAP_ACCENT_STOP,
  LENS_YARD_MAP_MUTED_BG,
  lensYardMapPaint,
} from '../app/(app)/inventory/blocking/lens/lens-yard-map-model';
import { LENS_PRINT_FILL_RGB } from '../app/(app)/inventory/blocking/lens/lens-ramp';
import { WAREHOUSES } from '../app/(app)/inventory/blocking/constants';
import {
  ageMethodNote,
  groupWord,
  monthAbbr,
  monthName,
  naturalMethodNote,
  priceBasisNoun,
  qualityDecimals,
  snapshotGapNote,
  undatedNote,
  unmeasuredNote,
  vsMarketCaption,
  vsMarketHeading,
  vsMarketUnavailableNote,
  fmtDays,
  fmtKg,
  fmtQuality,
  fmtSharePct,
} from '../app/(app)/inventory/_shared/blend-analysis-text';
import {
  LENS_CATEGORY_NEUTRAL_STOP,
  LENS_CATEGORY_STOPS,
  LENS_RAMP_RGB,
  LENS_RAMP_STOPS,
  categoryStop,
  rampRgb,
  rampStop,
} from '../app/(app)/inventory/blocking/lens/lens-ramp';
import {
  BLEND_ANALYSIS_DEFAULT_AGE_EDGES,
  BLEND_ANALYSIS_DEFAULT_PRICE_EDGES,
  BLEND_ANALYSIS_QUALITY_METRICS,
  type BlendAnalysis,
  type BlendQualityMetric,
  type BlendQualityNatural,
} from '../app/(app)/inventory/blocking/types';
import { buildBlendAnalysisPages } from '../app/(app)/inventory/_shared/blend-analysis-print';
import { buildLensSummaryBuckets } from '../app/(app)/inventory/blocking/lens/lens-summary-model';
import type { BlockData } from '../app/(app)/inventory/blocking/types';
import { DEFAULT_LAB_HIGHLIGHTS } from '../types/table-settings';
import { BLOCKING_AGE_LENS_DEFAULT_EDGES, BLOCKING_PRICE_LENS_DEFAULT_EDGES } from '../app/(app)/inventory/blocking/types';

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const SHARED = 'app/(app)/inventory/_shared';
const LENS = 'app/(app)/inventory/blocking/lens';
const OPTIONS = `${SHARED}/blend-analysis-options.ts`;
const TEXT = `${SHARED}/blend-analysis-text.ts`;
const SECTIONS = `${SHARED}/blend-analysis-sections.tsx`;
const PRINT = `${SHARED}/blend-analysis-print.ts`;
const HOOK = `${SHARED}/use-blend-analysis.ts`;
const DIALOG = `${SHARED}/blend-proposal-dialog.tsx`;
const PDF = `${SHARED}/blend-proposal-pdf.ts`;
const YARD = `${SHARED}/blend-yard-map-print.ts`;
const YARD_MODEL = 'app/(app)/inventory/blocking/lens/lens-yard-map-model.ts';
const GRID = 'app/(app)/inventory/blocking/blocking-grid.tsx';
const LENS_PRINT = `${LENS}/lens-summary-print.tsx`;
const PRICE_PANEL = `${LENS}/price-lens-panel.tsx`;
const AGE_PANEL = `${LENS}/age-lens-panel.tsx`;
const SUPPLIER_PANEL = `${LENS}/supplier-lens-panel.tsx`;
const GLOBALS = 'app/globals.css';
const CONTEXT = 'app/(app)/inventory/blocking/CONTEXT.md';
const FIXTURE = 'app/dev/table-playground/blendanalysis/blendanalysis-fixture.tsx';
const FIXTURE_PAGE = 'app/dev/table-playground/blendanalysis/page.tsx';

/** Every file this script reasons about. A missing one is a failure, not a pass. */
const ALL_FILES = [
  OPTIONS, TEXT, SECTIONS, PRINT, HOOK, DIALOG, PDF, YARD, YARD_MODEL, GRID, LENS_PRINT,
  PRICE_PANEL, AGE_PANEL, SUPPLIER_PANEL, `${LENS}/lens-summary-model.ts`,
];

const cache = new Map<string, string>();
function read(rel: string): string {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  const body = readFileSync(resolve(process.cwd(), rel), 'utf8');
  assert.ok(body.length > 0, `${rel} is empty`);
  cache.set(rel, body);
  return body;
}

/** Source with `//` and block comments blanked, so a comment can neither satisfy nor
 *  trip a code assertion. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

// ===========================================================================
console.log('\n1. NOTHING IN THE ANALYSIS UI COMPUTES A STATISTIC');
// ===========================================================================
//
// The rule is CLAUDE.md's ("never calculate weighted averages or inventory balances in
// TypeScript") applied to four tables whose whole content is weighted averages. A
// subtotal row is the payload's group figures; a footer row is the payload's `overall`,
// which is what makes the price footer visibly equal the proposal's own raw blend price.
{
  for (const f of [SECTIONS, PRINT, TEXT, OPTIONS, HOOK, LENS_PRINT]) {
    check(`${f.split('/').pop()} sums nothing: no reduce / += / running total`, () => {
      const body = code(f);
      assert.ok(!/\breduce\s*\(/.test(body), 'a reduce appeared');
      assert.ok(!/[^+]\+=[^=]/.test(body), 'a running total appeared');
      assert.ok(!/\bMath\.(min|max)\s*\(\s*\.\.\./.test(body), 'a spread extreme appeared');
    });
  }

  check('no share is derived: nothing divides by a total, a count or a length', () => {
    for (const f of [SECTIONS, PRINT, LENS_PRINT]) {
      const body = code(f);
      assert.ok(
        !/\/\s*(total|totalKg|overall\.kg|blockCount|\w+\.length)\b/.test(body),
        `${f} divides by a total — every share and weighted figure comes out of SQL`,
      );
      assert.ok(!/\*\s*100\b/.test(body), `${f} builds a percentage itself`);
    }
  });

  check('the ONE piece of money arithmetic is a per-ROW product, named and commented', () => {
    // A row multiplying its OWN two published numbers cannot disagree with a total it
    // does not contribute to. Every subtotal and footer value is `valuePhp`.
    for (const f of [SECTIONS, PRINT]) {
      const body = code(f);
      const products = [...body.matchAll(/\bkg\s*\*\s*phpKg\b/g)];
      assert.equal(products.length, 1, `${f} multiplies kg by a price more than once`);
      assert.ok(/function blockValuePhp\(/.test(body), `${f} has no named row-value helper`);
      assert.ok(read(f).includes('per-ROW product'), `${f} does not say what that product is`);
    }
    // And the aggregates are read, not built.
    assert.ok(code(SECTIONS).includes('valuePhp'), 'the sections do not read the published value');
    assert.ok(code(PRINT).includes('valuePhp'), 'the print does not read the published value');
  });

  check('the group and footer cells read PUBLISHED fields, not local variables', () => {
    for (const f of [SECTIONS, PRINT]) {
      const body = code(f);
      for (const field of ['kgWeightedPhpKg', 'kgWeightedValue', 'kgWeightedAgeDays', 'kgSharePct']) {
        assert.ok(body.includes(field), `${f} does not read ${field}`);
      }
      assert.ok(body.includes('overall'), `${f} does not read the payload's own overall`);
    }
  });

  check('the shared TEXT module only formats — `toFixed` and `Math.round`, nothing else', () => {
    const body = code(TEXT);
    assert.ok(!/\breduce\s*\(/.test(body));
    assert.ok(!/\bsort\s*\(/.test(body), 'the text module sorts — that is a caller concern');
    // gvf → a percentage is the ONE multiplication, and it is a unit conversion of a
    // published ratio, not a statistic.
    const mults = [...body.matchAll(/\*\s*100/g)];
    assert.equal(mults.length, 1, 'the text module does arithmetic beyond the gvf percentage');
    assert.ok(/gvf \* 100/.test(body), 'the one multiplication is not the gvf conversion');
  });
}

// ===========================================================================
console.log('\n2. THE PRICE GATE — PAGE, CHECKBOX AND THE LENS PRINT');
// ===========================================================================
{
  check('`analysisPages` is the ONE place the choice meets the permission', () => {
    const all = { price: true, quality: true, age: true, yardMap: true };
    // `analysisPages` NEVER returns the yard map, however it is ticked — see §11.
    assert.deepEqual(analysisPages(all, true), ['price', 'quality', 'age']);
    // A denied reader loses the price page WHATEVER the stored option says.
    assert.deepEqual(analysisPages(all, false), ['quality', 'age']);
    const priceOnly = { price: true, quality: false, age: false, yardMap: false };
    assert.deepEqual(analysisPages(priceOnly, false), []);
    assert.equal(wantsAnalysis(priceOnly, false), false);
    assert.equal(wantsAnalysis(priceOnly, true), true);
  });

  check('the sections and the print BOTH route through it, and neither re-implements it', () => {
    for (const f of [SECTIONS, PRINT]) {
      assert.ok(code(f).includes('analysisPages('), `${f} does not use the shared gate`);
      assert.ok(
        !/options\.price\s*&&\s*canViewPrices/.test(code(f)),
        `${f} re-implements the gate inline`,
      );
    }
  });

  check('the dialog passes the EFFECTIVE flag, never the server flag alone', () => {
    const body = code(DIALOG);
    // `showPrices` IS the effective flag in this file: `can_view_prices && showPricesPref`.
    assert.ok(
      /const showPrices = !!proposal\?\.can_view_prices && showPricesPref;/.test(body),
      'the effective flag moved — the analysis gate may now read the server flag alone',
    );
    for (const site of [
      /analysisPages\(analysisOptions, showPrices\)/,
      /canViewPrices=\{showPrices\}/,
      /canViewPrices: showPrices/,
    ]) {
      assert.ok(site.test(body), `an analysis surface does not take the effective flag (${site})`);
    }
    assert.ok(
      !/canViewPrices=\{proposal\.can_view_prices\}/.test(body),
      'an analysis surface takes the SERVER flag directly, so hiding prices would not hide the page',
    );
  });

  check('the Include-pages popover omits the price ROW for a denied reader', () => {
    const body = code(SECTIONS);
    assert.ok(
      /filter\(\(id\) => id !== 'price' \|\| canViewPrices\)/.test(body),
      'the price checkbox is not filtered out for a denied reader',
    );
    assert.ok(
      !/disabled=\{!canViewPrices\}/.test(body),
      'the price checkbox is DISABLED rather than absent — an invitation the server refuses',
    );
  });

  check('`pricesHidden` is SAID once, not rendered as an empty page', () => {
    const body = read(SECTIONS);
    assert.ok(body.includes('pricesHidden'), 'the sections ignore the server’s own flag');
    assert.ok(
      /Prices are not shown for your role/.test(body),
      'nothing tells a denied reader why the pages are missing',
    );
  });

  check('the PRICE lens print is gated; the AGE lens print is NOT, and must never be', () => {
    const price = code(PRICE_PANEL);
    const age = code(AGE_PANEL);
    assert.ok(
      /caps\.canViewPrices && \(\s*<LensSummaryPrintControl/.test(price.replace(/\s+/g, ' ')),
      'the price lens print button is not behind the price flag',
    );
    assert.ok(age.includes('<LensSummaryPrintControl'), 'the age lens has no print button');
    assert.ok(
      !/canViewPrices/.test(age),
      'the AGE panel grew a price flag — its payload carries no money and Production must keep it',
    );
    // The shared sheet knows nothing about prices at all.
    assert.ok(
      !/canViewPrices/.test(code(LENS_PRINT)),
      'the shared print sheet has grown a price concern — the gate belongs at the button',
    );
  });
}

// ===========================================================================
console.log('\n3. THE INCLUDE-PAGES CHOICE IS UNTRUSTED — proven by running the parser');
// ===========================================================================
{
  check('the default is every page ON, and the yard map is the FOURTH checkbox', () => {
    assert.deepEqual(DEFAULT_BLEND_ANALYSIS_OPTIONS, {
      price: true,
      quality: true,
      age: true,
      yardMap: true,
    });
    // The ANALYSIS order is unchanged — the map is not an analysis page (§11).
    assert.deepEqual(BLEND_ANALYSIS_PAGE_ORDER, ['price', 'quality', 'age']);
    assert.deepEqual(BLEND_INCLUDE_PAGE_ORDER, ['price', 'quality', 'age', 'yardMap']);
  });

  check('a hostile document falls back FIELD BY FIELD, never wholesale', () => {
    // One good field, three kinds of rubbish: the good one survives.
    const parsed = parseBlendAnalysisOptions({
      price: false,
      quality: 'yes',
      age: 1,
      __proto__: { age: false },
      extra: { nested: true },
    });
    assert.deepEqual(parsed, { price: false, quality: true, age: true, yardMap: true });
  });

  check('junk of every shape parses to the shipped defaults', () => {
    for (const junk of [null, undefined, 0, '', 'price', [], [1, 2], true, NaN]) {
      assert.deepEqual(parseBlendAnalysisOptions(junk), DEFAULT_BLEND_ANALYSIS_OPTIONS);
    }
  });

  check('serialize OMITS defaults, so turning everything back on is a REMOVAL', () => {
    assert.deepEqual(serializeBlendAnalysisOptions(DEFAULT_BLEND_ANALYSIS_OPTIONS), {});
    assert.deepEqual(
      serializeBlendAnalysisOptions({
        price: false,
        quality: true,
        age: false,
        yardMap: false,
      }),
      { price: false, age: false, yardMap: false },
    );
  });

  check('parse ∘ serialize is the identity on every one of the SIXTEEN states', () => {
    for (const price of [true, false]) {
      for (const quality of [true, false]) {
        for (const age of [true, false]) {
          for (const yardMap of [true, false]) {
            const o = { price, quality, age, yardMap };
            assert.deepEqual(parseBlendAnalysisOptions(serializeBlendAnalysisOptions(o)), o);
          }
        }
      }
    }
  });

  check('it stores in `user_table_settings` under its OWN module — no new table', () => {
    assert.equal(BLEND_ANALYSIS_SETTINGS_MODULE, 'blocking_blend_analysis');
    // `saveUserModuleSettings` REPLACES the row, so sharing a lens's key would be
    // destructive in both directions.
    assert.ok(!BLEND_ANALYSIS_SETTINGS_MODULE.startsWith('blocking_lens_'));
    const body = code(DIALOG);
    assert.ok(body.includes('useModuleSettings'), 'the dialog does not use the shared store');
    assert.ok(!/\.from\(/.test(code(OPTIONS)), 'the options module queries a table');
    assert.ok(
      code(OPTIONS).includes('') && !/createClient/.test(code(OPTIONS)),
      'the options module builds a Supabase client',
    );
  });

  check('the page count the button shows IS the page count the print builds', () => {
    assert.equal(analysisPagesLabel(3), '3 extra pages');
    assert.equal(analysisPagesLabel(1), '1 extra page');
    assert.equal(analysisPagesLabel(0), 'no extra pages');
    const body = code(DIALOG);
    // RESTATED 2026-09-23: the count is now `includedPageCount` (the analysis pages PLUS
    // the yard map) and the ANALYSIS gate is still called by name for the price-group
    // decision, so both halves are asserted rather than one standing in for the other.
    assert.ok(
      /analysisPageIds = analysisPages\(analysisOptions, showPrices\)/.test(body),
      'the dialog no longer routes through the shared analysis gate',
    );
    assert.ok(
      /printPageCount = includedPageCount\(analysisOptions, showPrices\)/.test(body),
      'the button count is derived some other way than the shared count',
    );
    assert.ok(/data-blend-print/.test(body), 'the print button lost its test hook');
    assert.ok(/\+\{printPageCount\}/.test(body), 'the print button does not show the count');
  });
}

// ===========================================================================
console.log('\n4. ONE DEFINITION OF A LABEL, A BAND AND A DECIMAL');
// ===========================================================================
{
  check('the band labels are IMPORTED from the two lenses, never re-written', () => {
    for (const f of [SECTIONS, PRINT, PDF]) {
      const body = code(f);
      assert.ok(
        /from '.*price-lens-settings'/.test(body) || /priceBandLabel/.test(body),
        `${f} does not import the price lens's label`,
      );
      assert.ok(body.includes('priceBandLabel('), `${f} does not CALL the price band label`);
      assert.ok(body.includes('ageBandLabel('), `${f} does not CALL the age band label`);
      // A locally-defined twin is the failure this guards.
      assert.ok(
        !/function (priceBandLabel|ageBandLabel)\b/.test(body),
        `${f} declares its own band label function`,
      );
    }
  });

  check('the reader’s own band NAMES reach both surfaces', () => {
    const body = code(DIALOG);
    assert.ok(/priceBandNames=\{priceLensSettings\.bandNames\}/.test(body));
    assert.ok(/ageBandNames=\{ageLensSettings\.bandNames\}/.test(body));
    assert.ok(/priceBandNames: priceLensSettings\.bandNames/.test(body), 'the print loses the names');
    assert.ok(/ageBandNames: ageLensSettings\.bandNames/.test(body), 'the print loses the names');
  });

  check('the reader’s own CUT LINES drive the analysis, not a second default', () => {
    const body = code(DIALOG);
    assert.ok(/priceEdgeOffsets: priceLensSettings\.edgeOffsets/.test(body));
    assert.ok(/ageEdgeDays: ageLensSettings\.edgeDays/.test(body));
    // And the two families of default agree with the lenses', so an unconfigured reader
    // sees the same bands on the page as on the grid.
    assert.deepEqual(
      [...BLEND_ANALYSIS_DEFAULT_PRICE_EDGES],
      [...BLOCKING_PRICE_LENS_DEFAULT_EDGES],
    );
    assert.deepEqual([...BLEND_ANALYSIS_DEFAULT_AGE_EDGES], [...BLOCKING_AGE_LENS_DEFAULT_EDGES]);
  });

  check('a TYPED market price is the cut line; a measured one sends nothing', () => {
    const body = code(DIALOG);
    assert.ok(
      /basis === 'manual' \? priceLensSettings\.manualPrice : null/.test(body),
      'the market price is not taken from the lens’s own basis',
    );
    assert.ok(
      /basis === 'manual' \? manualRoundedUpPhp\(priceLensSettings\.manualPrice\) : null/.test(body),
      'R is not the lens’s own typed-cut-line rule',
    );
    assert.ok(!/Math\.(ceil|floor)/.test(body), 'the dialog rounds a price itself');
  });

  check('the quality decimals are the Excel Standard, and BD JIS is a COLUMN not a table', () => {
    assert.equal(qualityDecimals('mc'), 2);
    assert.equal(qualityDecimals('ash'), 2);
    assert.equal(qualityDecimals('bd_astm'), 3);
    assert.equal(qualityDecimals('bd_jis'), 3);
    assert.deepEqual([...BLEND_ANALYSIS_QUALITY_METRICS], ['mc', 'ash', 'bd_astm', 'bd_jis']);
    for (const f of [SECTIONS, PRINT, PDF]) {
      const body = code(f);
      assert.ok(
        /\{ metric: 'bd_astm', companion: 'bd_jis' \}/.test(body),
        `${f} does not carry BD JIS as the BD table's companion column`,
      );
      assert.ok(
        !/\{ metric: 'bd_jis' \}/.test(body),
        `${f} gives BD JIS a fourth table — its groups are cut in different places`,
      );
    }
  });

  check('the lab highlight is the reader’s own threshold, on screen AND on paper', () => {
    assert.ok(
      code(SECTIONS).includes('getLabHighlightText('),
      'the screen re-implements the WET / ASHY rule',
    );
    const print = code(PRINT);
    assert.ok(print.includes('getLabHighlightText('), 'the print re-implements the WET / ASHY rule');
    // The iframe has no stylesheet, so the CLASS cannot travel — but the DECISION does.
    assert.ok(
      /=== ''\) return ''/.test(print),
      'the print decides "is this flagged" some way other than the shared helper',
    );
    assert.ok(!/limit/.test(print) || !/direction/.test(print), 'the print reads the spec’s thresholds itself');
  });
}

// ===========================================================================
console.log('\n5. THE WORDS — the method note, the captions and the NULL cases');
// ===========================================================================
{
  const cuts = [
    { index: 0, below: 38.59, above: 39.34, value: 38.965 },
    { index: 1, below: 42, above: 47, value: 44.5 },
  ];

  check('the method line is CUT LINES and FIT, and nothing else', () => {
    const note = naturalMethodNote({
      groupCount: 3,
      cuts,
      gvf: 0.9761,
      formatCut: (v) => `₱${v.toFixed(2)}`,
    });
    // The owner's own target, to the character: `Cut lines ₱38.97 · ₱44.50 · fit 97.6%`.
    assert.equal(note, 'Cut lines ₱38.97 · ₱44.50 · fit 97.6%', note);
  });

  check('ONE cut line is singular; ONE GROUP says so and claims no fit', () => {
    const one = naturalMethodNote({
      groupCount: 2,
      cuts: [cuts[0]],
      gvf: 0.81,
      formatCut: (v) => `₱${v.toFixed(2)}`,
    });
    assert.equal(one, 'Cut line ₱38.97 · fit 81.0%', one);

    // A blend whose blocks all cost the same has NO variance, so `gvf` is NULL — and a
    // "fit 0.0%" would be a lie about a population there is nothing to explain in.
    const none = naturalMethodNote({
      groupCount: 1,
      cuts: [],
      gvf: null,
      formatCut: (v) => String(v),
    });
    assert.equal(none, 'One group', none);
    assert.ok(!none.includes('fit'), 'a degenerate split claims a fit');
  });

  check('a QUALITY method line reads in the metric\'s own decimals, still terse', () => {
    const note = naturalMethodNote({
      groupCount: 3,
      cuts: [
        { index: 0, below: 9.1, above: 10.6, value: 9.84 },
        { index: 1, below: 10.9, above: 11.6, value: 11.23 },
      ],
      gvf: 0.896,
      formatCut: (v) => v.toFixed(2),
    });
    assert.equal(note, 'Cut lines 9.84 · 11.23 · fit 89.6%', note);
  });

  check('the group WORDS are the owner’s: HIGH / AVERAGE / LOW, and never "average" alone', () => {
    assert.equal(groupWord('high', 3), 'HIGH');
    assert.equal(groupWord('mid', 3), 'AVERAGE');
    assert.equal(groupWord('low', 3), 'LOW');
    assert.equal(groupWord('high', 2), 'HIGH');
    assert.equal(groupWord('low', 2), 'LOW');
    // One group is not "average" — it is one group.
    assert.equal(groupWord('mid', 1), 'ALL ONE GROUP');
  });

  check('the caption says MARKET for a measurement and SET PRICE for a typed figure', () => {
    const measured = vsMarketCaption({
      marketPhpKg: 39.8272,
      marketBasis: 'as_of_month',
      marketBasisMonth: '2026-09-01',
      roundedUpPhp: 40,
      edgeOffsets: [-1, 0],
      bands: [],
      unmeasured: { blockCount: 0, kg: 0, blocks: [] },
      overall: { blockCount: 0, kg: 0, kgWeightedPhpKg: null, valuePhp: 0 },
    });
    assert.equal(measured, 'Market ₱39.83 (Sep 2026) · ₱40 and up is above', measured);

    const typed = vsMarketCaption({
      marketPhpKg: 45,
      marketBasis: 'given',
      marketBasisMonth: null,
      roundedUpPhp: 45,
      edgeOffsets: [-1, 0],
      bands: [],
      unmeasured: { blockCount: 0, kg: 0, blocks: [] },
      overall: { blockCount: 0, kg: 0, kgWeightedPhpKg: null, valuePhp: 0 },
    });
    assert.equal(typed, 'Set price ₱45.00 · ₱45 and up is above', typed);
    // ⚠️ THE WHOLE POINT of the rename: a typed figure is never called market.
    assert.ok(!/market/i.test(typed), `a TYPED price was called market: ${typed}`);
    assert.ok(!typed.includes('rounds up'), 'a typed price is described as rounding up');
    assert.equal(monthName('2026-09-01'), 'September 2026');
    assert.equal(monthAbbr('2026-09-01'), 'Sep 2026');
  });

  check('`vsMarketHeading` is the ONE definition, and every surface reads it', () => {
    assert.equal(vsMarketHeading(false), 'Against market');
    assert.equal(vsMarketHeading(true), 'Against set price');
    assert.equal(priceBasisNoun(false), 'market');
    assert.equal(priceBasisNoun(true), 'set price');
    // All FOUR surfaces — screen, HTML print, PDF and the lens legend — take the label
    // from the shared function rather than spelling "Against market" themselves.
    for (const f of [SECTIONS, PRINT, PDF]) {
      const body = code(f);
      assert.ok(/vsMarketHeading\(/.test(body), `${f} does not read the shared heading`);
      assert.ok(
        !/'Against market'/.test(body) && !/>Against market</.test(body),
        `${f} hardcodes "Against market", so a typed price would be mislabelled`,
      );
    }
    // And the price LENS itself never says "market" about a typed figure.
    const lens = code(PRICE_PANEL);
    assert.ok(/priceBasisNoun\(/.test(lens), 'the price lens does not read the shared noun');
  });

  check('a market that cannot be measured is SAID, terse, and never treated as ₱0', () => {
    const note = vsMarketUnavailableNote({
      reason: 'no_market_price',
      message: 'No market price for this month.',
      marketBasis: 'as_of_month',
      marketBasisMonth: '2026-09-01',
    });
    assert.equal(note, 'No market price for Sep 2026 · set one on the Price lens', note);
    for (const f of [SECTIONS, PRINT]) {
      assert.ok(
        code(f).includes('vsMarketUnavailable'),
        `${f} ignores the reason and would render an empty table`,
      );
    }
  });

  check('the no-reading note is `No reading: N blocks`, and ABSENT when the count is 0', () => {
    const note = unmeasuredNote(
      { blockCount: 2, kg: 30_115, noValueCount: 1, noWeightCount: 0, blocks: [] },
      'No reading',
    );
    assert.equal(note, 'No reading: 2 blocks', note);
    // A reading with nothing to weight it is a SECOND gap — one token, not a clause.
    const weighted = unmeasuredNote(
      { blockCount: 2, kg: 30_115, noValueCount: 1, noWeightCount: 1, blocks: [] },
      'No reading',
    );
    assert.equal(weighted, 'No reading: 2 blocks · 1 unweighted', weighted);
    // ⚠️ EMPTY, not a sentence saying nothing is missing.
    assert.equal(
      unmeasuredNote({ blockCount: 0, kg: 0, noValueCount: 0, noWeightCount: 0, blocks: [] }, 'No reading'),
      '',
    );
    assert.equal(undatedNote(2), 'No delivery dates: 2 blocks');
    assert.equal(undatedNote(0), '');
  });

  check('NULL reads as an em dash everywhere, and a snapshot gap shows BOTH figures', () => {
    assert.equal(fmtSharePct(null), '—');
    assert.equal(fmtDays(null), '—');
    assert.equal(fmtQuality('ash', null), '—');
    assert.equal(fmtKg(74_590.4), '74,590');
    const gap = snapshotGapNote({ snapshot: '2.13', measured: '3.13', excluded: 'no-reading' });
    assert.equal(gap, 'Blend avg 2.13 · excl. no-reading 3.13', gap);
  });

  check('the AGE method line is the as-of date, the cuts and the oldest pile', () => {
    const note = ageMethodNote({
      asOf: '2026-09-21',
      cutDays: [60, 120, 365],
      oldestDays: null,
      oldestBlockLoc: null,
    });
    assert.equal(note, 'As of 2026-09-21 · cuts 60 · 120 · 365 d', note);
    const withOldest = ageMethodNote({
      asOf: '2026-09-21',
      cutDays: [60, 120, 365],
      oldestDays: 444.5,
      oldestBlockLoc: 'C-5B',
    });
    assert.equal(withOldest, 'As of 2026-09-21 · cuts 60 · 120 · 365 d · oldest 444.5 d C-5B', withOldest);
  });

  check('⚠️ NO CAPTION CARRIES PROSE — proven on the STRINGS the words module emits', () => {
    // The owner: *"I don't want descriptions like this, straight to the point, not
    // wordy. Apply to all sections, not just price."* The strongest form of this check is
    // over the OUTPUT, not the source: every caption either surface can print comes out
    // of one of these six functions, so a matrix over them is exhaustive by construction.
    const banned = ['naturally', 'minimise', 'dearest', 'spread', '→', 'first inside'];
    const emitted: string[] = [
      naturalMethodNote({ groupCount: 3, cuts, gvf: 0.9761, formatCut: (v) => `₱${v.toFixed(2)}` }),
      naturalMethodNote({ groupCount: 1, cuts: [], gvf: null, formatCut: String }),
      naturalMethodNote({ groupCount: 2, cuts: [cuts[0]], gvf: 0.5, formatCut: (v) => v.toFixed(3) }),
      vsMarketCaption({
        marketPhpKg: 39.8272, marketBasis: 'as_of_month', marketBasisMonth: '2026-09-01',
        roundedUpPhp: 40, edgeOffsets: [-1, 0], bands: [],
        unmeasured: { blockCount: 0, kg: 0, blocks: [] },
        overall: { blockCount: 0, kg: 0, kgWeightedPhpKg: null, valuePhp: 0 },
      }),
      vsMarketCaption({
        marketPhpKg: 45, marketBasis: 'given', marketBasisMonth: null,
        roundedUpPhp: 45, edgeOffsets: [-1, 0], bands: [],
        unmeasured: { blockCount: 0, kg: 0, blocks: [] },
        overall: { blockCount: 0, kg: 0, kgWeightedPhpKg: null, valuePhp: 0 },
      }),
      vsMarketUnavailableNote({
        reason: 'no_market_price', message: 'x', marketBasis: 'as_of_month',
        marketBasisMonth: '2026-09-01',
      }),
      unmeasuredNote({ blockCount: 3, kg: 1, noValueCount: 1, noWeightCount: 2, blocks: [] }, 'No price'),
      undatedNote(4),
      snapshotGapNote({ snapshot: 'a', measured: 'b', excluded: 'unpriced' }),
      ageMethodNote({ asOf: '2026-09-21', cutDays: [60], oldestDays: 9, oldestBlockLoc: 'A-1A' }),
      vsMarketHeading(true),
      vsMarketHeading(false),
    ];
    for (const text of emitted) {
      for (const word of banned) {
        assert.ok(!text.toLowerCase().includes(word), `an emitted caption carries "${word}": ${text}`);
      }
      // A caption is a LIST OF FACTS, so it never ends in a full stop.
      assert.ok(!/\.$/.test(text), `a caption ends in a full stop, so it is a sentence: ${text}`);
    }
  });

  check('and the three SURFACES do not re-introduce prose of their own', () => {
    // The literals each surface adds AROUND a caption were where "Dearest band first"
    // and "high → average → low" lived. Comment-stripped, so a header note explaining
    // the rule cannot trip it.
    for (const f of [SECTIONS, PRINT, PDF]) {
      // The PDF legitimately transliterates `→` for WinAnsi; that one occurrence is its
      // CHARACTER FILTER, not a caption, so it is excluded by name rather than ignored.
      const body = code(f).replace(/\.replace\(\/→\/g, 'to'\)/, '');
      for (const word of ['naturally', 'minimise', 'dearest', 'spread', '→']) {
        assert.ok(!body.includes(word), `${f} still carries the banned caption word "${word}"`);
      }
      for (const phrase of ['band first', 'block first', 'reading first', 'High to low']) {
        assert.ok(!body.includes(phrase), `${f} still explains its own row order ("${phrase}")`);
      }
    }
  });
}

// ===========================================================================
console.log('\n6. THE READ — one source, a mount-frame first request, a signature guard');
// ===========================================================================
{
  check('the source is a DISCRIMINATED union, so both halves can never be sent', () => {
    const body = code(HOOK);
    assert.ok(/kind: 'saved'; proposalId: string; versionNo: number/.test(body));
    assert.ok(/kind: 'live'; blockLocs: readonly string\[\]/.test(body));
    assert.ok(/input\.proposalId = id;/.test(body), 'the saved source does not send a proposal id');
    assert.ok(/input\.versionNo = Number\(v\);/.test(body), 'the saved source does not send a version');
    assert.ok(/input\.blockLocs = /.test(body), 'the live source does not send block locs');
    // The two assignments are in opposite branches of ONE if/else.
    assert.ok(
      /if \(sourceKey\.startsWith\('saved:'\)\) \{[\s\S]{0,260}\} else \{[\s\S]{0,200}blockLocs/.test(body),
      'the two sources are not mutually exclusive branches',
    );
  });

  check('the dialog picks SAVED when it has a version, LIVE otherwise', () => {
    const body = code(DIALOG);
    assert.ok(/kind: 'saved' as const, proposalId: savedProposalId, versionNo: savedVersionNo/.test(body));
    assert.ok(/kind: 'live' as const, blockLocs: analysisLocsKey\.split\('\|'\)/.test(body));
  });

  check('the FIRST request fires on the mount frame — there is no debounce to lose', () => {
    const body = code(HOOK);
    assert.ok(!/setTimeout\(\s*run/.test(body), 'the read is deferred into a timer');
    assert.ok(!/LENS_DEBOUNCE_MS/.test(body), 'the read is debounced — its inputs are discrete events');
    assert.ok(
      /void \(adapterRef\.current \?\? fetchBlendAnalysis\)\(input\)/.test(body),
      'the read is not issued directly inside the effect',
    );
  });

  check('the guard is the request’s own SIGNATURE, never a monotonic counter', () => {
    const body = code(HOOK);
    assert.ok(/wantRef\.current = signature;/.test(body), 'nothing records what is wanted');
    const guards = [...body.matchAll(/if \(wantRef\.current !== signature\) return;/g)];
    assert.ok(guards.length >= 3, `a reply path is unguarded (${guards.length} guards)`);
    assert.ok(!/tokenRef/.test(body), 'a monotonic token is back — that is the unrecoverable stall');
    // The signature must contain everything that changes the answer.
    for (const part of ['sourceKey', 'priceKey', 'ageKey', 'marketPhpKg', 'roundedUpPhp']) {
      assert.ok(
        new RegExp(`signature = [^;]*${part}`).test(body),
        `${part} is not in the request signature`,
      );
    }
  });

  check('a stall is VISIBLE and retryable — the watchdog, and the shared banner', () => {
    const body = code(HOOK);
    assert.ok(body.includes('LENS_STALL_MS'), 'there is no watchdog');
    assert.ok(/stopWatchdog\(\);\s*setLoading\(false\);/.test(body), 'the watchdog outlives the reply');
    const sections = code(SECTIONS);
    assert.ok(sections.includes('RefusalBanner'), 'a refusal has nowhere to be shown');
    assert.ok(/stalled && !refusal/.test(sections), 'a stall and a refusal would stack two banners');
  });

  check('errors go through `errorToast` only — never a raw `toast.error`', () => {
    for (const f of [...ALL_FILES]) {
      const body = code(f);
      assert.ok(!/toast\.error\s*\(/.test(body), `${f} calls sonner directly`);
    }
    assert.ok(code(HOOK).includes('errorToast('), 'a thrown read is swallowed');
  });

  check('a refusal KEEPS the previous payload — it never blanks the pages on screen', () => {
    const body = code(HOOK);
    assert.ok(
      /setRefusal\(res\.message\);/.test(body) && !/setAnalysis\(null\)[\s\S]{0,80}setRefusal/.test(body),
      'a refusal clears the payload',
    );
  });
}

// ── A MINIMAL, TYPE-CORRECT PAYLOAD, so the page COUNT can be measured ──────
//
// The sheets are counted rather than read out of the source, because "one table per
// sheet" is a property of the OUTPUT and a regression would be a structural change the
// source could still look right after. Empty group arrays are deliberate: a table with no
// rows still emits its heading, its `thead` and its total `tbody`, which is exactly the
// six-section shape being counted.

const SAMPLE_HIGHLIGHTS = DEFAULT_LAB_HIGHLIGHTS;

const EMPTY_STATS = {
  n: 0, distinctCount: 0, totalWeight: 0, weightedMean: null,
  totalSs: null, withinSs: null, betweenSs: null, candidatesConsidered: 0,
};
const EMPTY_UNMEASURED = { blockCount: 0, kg: 0, noValueCount: 0, noWeightCount: 0, blocks: [] };

function sampleQuality(metric: BlendQualityMetric): BlendQualityNatural {
  return {
    metric,
    groupCount: 1,
    gvf: null,
    cuts: [],
    stats: EMPTY_STATS,
    groups: [],
    unmeasured: EMPTY_UNMEASURED,
    overall: {
      blockCount: 0, kg: 0, kgWeightedValue: null,
      snapshotValue: null, snapshotGap: null, equalsSnapshot: null,
    },
  };
}

const SAMPLE_ANALYSIS: BlendAnalysis = {
  source: 'live',
  asOf: '2026-09-22',
  proposalId: null,
  versionNo: null,
  title: null,
  snapshotComputedAt: null,
  computedAt: '2026-09-22T01:00:00Z',
  blockCount: 0,
  totalKg: 0,
  pricesHidden: false,
  price: {
    natural: {
      metric: 'php_kg',
      groupCount: 1,
      gvf: null,
      cuts: [],
      stats: EMPTY_STATS,
      groups: [],
      unmeasured: EMPTY_UNMEASURED,
      overall: {
        blockCount: 0, kg: 0, kgWeightedPhpKg: null, valuePhp: 0,
        snapshotPhpKg: null, snapshotGap: null, equalsSnapshot: null,
      },
    },
    vsMarket: {
      marketPhpKg: 39.8272,
      marketBasis: 'as_of_month',
      marketBasisMonth: '2026-09-01',
      roundedUpPhp: 40,
      edgeOffsets: [-1, 0],
      bands: [],
      unmeasured: { blockCount: 0, kg: 0, blocks: [] },
      overall: { blockCount: 0, kg: 0, kgWeightedPhpKg: null, valuePhp: 0 },
    },
    vsMarketUnavailable: null,
  },
  quality: {
    metrics: ['mc', 'ash', 'bd_astm', 'bd_jis'],
    byMetric: {
      mc: sampleQuality('mc'),
      ash: sampleQuality('ash'),
      bd_astm: sampleQuality('bd_astm'),
      bd_jis: sampleQuality('bd_jis'),
    },
  },
  age: {
    asOf: '2026-09-22',
    edgeDays: [60, 120, 365],
    bands: [],
    undated: { blockCount: 0, kg: 0, blocks: [] },
    overall: {
      blockCount: 0, kg: 0, kgWeightedAgeDays: null,
      oldestAgeDays: null, oldestBlockLoc: null, oldestBatchCode: null,
    },
  },
};

// ===========================================================================
console.log('\n7. THE PRINTED SHEETS — tbody totals, page breaks, a 7pt floor');
// ===========================================================================
{
  check('every subtotal and footer is a `<tbody>` row — Chrome repeats a `<tfoot>`', () => {
    // Comment-stripped: both files EXPLAIN the tfoot trap in prose, and prose must
    // neither satisfy nor trip a code assertion.
    const body = code(PRINT);
    assert.ok(!/<tfoot/.test(body), 'the analysis sheets use a tfoot — it prints once per page');
    assert.ok(/class="gsub"/.test(body), 'the subtotal row lost its class');
    assert.ok(/class="gtotal"/.test(body), 'the grand total row lost its class');
    assert.ok(/<tbody\$\{small\}>\$\{headRow\}\$\{rows\}\$\{sub\}<\/tbody>/.test(body),
      'a group is not one tbody carrying its own header, rows and subtotal');
    // And the screen follows the same rule, so the two cannot diverge.
    const screen = code(SECTIONS);
    assert.ok(!/<tfoot/.test(screen), 'the screen table uses a tfoot');
    assert.ok(
      read(SECTIONS).includes('The grand FOOTER — also a tbody row'),
      'the screen does not say why its totals are tbody rows',
    );
  });

  check('⚠️ EVERY TABLE starts on a fresh sheet — the HTML path', () => {
    // The owner's screenshot had a heading sitting at the bottom of a page above the TAIL
    // of the table before it. The fix is structural rather than a nudge: each analysis
    // TABLE is its own `<section class="apage">`, and `.apage` breaks before.
    const css = code(PRINT);
    assert.ok(
      /\.apage \{ break-before: page; page-break-before: always; \}/.test(css),
      'the page-break rule is gone from the HTML print path',
    );
    assert.ok(/\.apage h2 \{[\s\S]*?break-after: avoid;/.test(css), 'an h2 can be orphaned');
    assert.ok(/\.apage \.anote \{[\s\S]*?break-after: avoid;/.test(css), 'a caption can be orphaned');
    // THE STRUCTURAL HALF, and the one that actually fixes the bug: there is no `h3`
    // left, because a sub-heading INSIDE a page was precisely the thing that could be
    // stranded above somebody else's rows.
    assert.ok(!/<h3>/.test(css), 'a table is introduced by an h3 inside another table\'s page');
  });

  check('⚠️ and the count of sheets EQUALS the count of tables — measured on a payload', () => {
    // The strongest form: build the real pages from a real-shaped analysis and count.
    const html = buildBlendAnalysisPages({
      analysis: SAMPLE_ANALYSIS,
      options: { price: true, quality: true, age: true, yardMap: true },
      canViewPrices: true,
      labHighlights: SAMPLE_HIGHLIGHTS,
    });
    const sheets = (html.match(/<section class="apage">/g) ?? []).length;
    const tables = (html.match(/<table class="atab">/g) ?? []).length;
    assert.ok(sheets > 0, 'no analysis sheet was emitted at all');
    assert.equal(
      sheets,
      tables,
      `${tables} tables landed on ${sheets} sheets — a table is sharing a page`,
    );
    // Six tables: price groups, against market/set price, MC, ASH, BD, age.
    assert.equal(sheets, 6, `expected six sheets, got ${sheets}`);
    // And a HEADING is the first thing on each of them.
    for (const chunk of html.split('<section class="apage">').slice(1)) {
      assert.ok(/^\s*<h2>/.test(chunk), `a sheet does not open with its heading: ${chunk.slice(0, 60)}`);
    }
  });

  check('⚠️ EVERY TABLE starts on a fresh page — the PDF path', () => {
    const pdf = code(PDF);
    // `analysisHeading` is the ONE place a page is added, and it adds one EVERY time.
    assert.ok(
      /function analysisHeading\([\s\S]{0,200}?doc\.addPage\(\);/.test(pdf),
      'the PDF heading helper no longer adds a page',
    );
    // Six call sites — one per table — and NO other `addPage` in the analysis builder.
    // BOUNDED 2026-09-23: the yard map's own `drawYardMapPage` lives further down the
    // file and legitimately adds its ONE page, so the slice ends where this builder does.
    const builder = pdf.slice(
      pdf.indexOf('function appendAnalysisPages'),
      pdf.indexOf('function pdfPhp('),
    );
    assert.ok(builder.length > 0, 'the analysis builder slice is empty — the bound moved');
    const headings = (builder.match(/analysisHeading\(/g) ?? []).length;
    assert.ok(headings >= 4, `only ${headings} PDF tables add a page of their own`);
    assert.ok(
      !/doc\.addPage\(\)/.test(builder),
      'the PDF analysis builder adds a page outside the heading helper — two rules for one thing',
    );
    // The quality metrics each get their own heading INSIDE the loop, which is what turns
    // one "Quality" page into three.
    assert.ok(
      /for \(const \{ metric, companion \} of QUALITY_PDF_TABLES\) \{[\s\S]*?analysisHeading\(/.test(builder),
      'the PDF quality metrics still share one page',
    );
  });

  check('a SMALL group travels whole; a big one may split', () => {
    const body = code(PRINT);
    assert.ok(/\.apage tbody\.small \{ break-inside: avoid; \}/.test(body));
    assert.ok(/const SMALL_GROUP_ROWS = 4;/.test(body), 'the small-group threshold moved');
    assert.ok(
      /g\.rows\.length <= SMALL_GROUP_ROWS \? ' class="small"' : ''/.test(body),
      'every group is forced whole, which pushes a page of white space ahead of a big one',
    );
  });

  check('the printed type never falls below 7pt, and padding is squeezed first', () => {
    const body = code(PRINT);
    const sizes = [...body.matchAll(/font-size: ([\d.]+)pt/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length > 0, 'the analysis CSS declares no point sizes');
    assert.ok(Math.min(...sizes) >= 7, `a printed font fell below the 7pt floor (${Math.min(...sizes)}pt)`);
    assert.ok(/padding: 1\.5px 3px/.test(body), 'the analysis table does not tighten its padding');
  });

  check('the document is LANDSCAPE and the analysis CSS does NOT restate `@page`', () => {
    // One document, one page box: the proposal sheet already declares it.
    assert.ok(/@page \{ size: A4 landscape/.test(read(DIALOG)), 'the proposal print is not landscape');
    assert.ok(!/@page/.test(code(PRINT)), 'the analysis sheets declare a second page box');
    assert.ok(
      read(DIALOG).includes('print-color-adjust: exact') ||
        read('app/(app)/inventory/_shared/print-utils.ts').includes('print-color-adjust: exact'),
      'the printed colours depend on the reader ticking "Background graphics"',
    );
  });

  check('an EMPTY analysis leaves the existing document byte-identical', () => {
    const body = code(DIALOG);
    assert.ok(
      /const analysisCss = analysisHtml === '' \? '' : BLEND_ANALYSIS_PRINT_CSS;/.test(body),
      'the analysis CSS rides even when there are no analysis pages',
    );
    assert.ok(/const analysisHtml = \(analysisPagesHtml \?\? ''\)\.trim\(\);/.test(body));
  });

  check('a price-denied PRINT and PDF carry no ₱ at all', () => {
    // Two independent reasons: the page is dropped by the gate, and the payload's whole
    // price section is deleted server-side.
    const print = code(PRINT);
    assert.ok(/if \(id === 'price'\) out\.push\(pricePage/.test(print));
    assert.ok(/if \(!analysis\) return '';/.test(print), 'a missing payload still emits sheets');
    assert.ok(/if \(!price\) return '';/.test(print), 'the price page renders without a price section');
    const pdf = code(PDF);
    assert.ok(/if \(!price\) continue;/.test(pdf), 'the PDF price page renders without a price section');
    assert.ok(/for \(const page of analysisPages\(options, canViewPrices\)\)/.test(pdf));
  });

  check('the PDF spells ₱ as `PHP` and runs EVERY cell through the WinAnsi filter', () => {
    const pdf = code(PDF);
    assert.ok(/body: rows\.map\(\(r\) => r\.cells\.map\(pdfText\)\)/.test(pdf), 'a cell can carry a ₱ glyph');
    assert.ok(/head: \[head\.map\(pdfText\)\]/.test(pdf), 'a header can carry a ₱ glyph');
    assert.ok(/function pdfPhp\(/.test(pdf) && /`PHP \$\{/.test(pdf), 'the PDF currency is not spelled out');
    assert.ok(!/foot: \[/.test(pdf.split('appendAnalysisPages')[1] ?? ''), 'an analysis table uses a repeating foot');
  });
}

// ===========================================================================
console.log('\n8. THE PRINTED RAMP IS THE SCREEN’S RAMP — proven against globals.css');
// ===========================================================================
{
  check('all twenty-seven hues match `globals.css` exactly', () => {
    // Fourteen ORDINAL stops plus the NOMINAL ramp's thirteen (2026-09-22). The category
    // ramp is duplicated for the same reason the other two are — the blend proposal's
    // iframe cannot reach `globals.css` — so it is proven equal, never assumed.
    const css = read(GLOBALS);
    for (const [ramp, prefix, stops] of [
      ['cost', 'lens-band', LENS_RAMP_STOPS],
      ['age', 'lens-age', LENS_RAMP_STOPS],
      ['category', 'lens-cat', LENS_CATEGORY_STOPS],
    ] as const) {
      for (let i = 0; i < stops; i++) {
        const m = new RegExp(`\\.${prefix}-${i}\\s+\\{ --lens-hue: ([\\d ]+); \\}`).exec(css);
        assert.ok(m, `globals.css has no .${prefix}-${i} hue`);
        assert.equal(
          LENS_RAMP_RGB[ramp][i],
          m[1].trim(),
          `.${prefix}-${i} differs between globals.css and lens-ramp.ts`,
        );
      }
    }
  });

  check('the printed tint uses the SAME stop mapping the screen class does', () => {
    // 3 bands → stops 0 · 3 · 6; both ends always used.
    assert.equal(rampStop(0, 3), 0);
    assert.equal(rampStop(1, 3), 3);
    assert.equal(rampStop(2, 3), 6);
    assert.equal(rampRgb('cost', 0, 3), LENS_RAMP_RGB.cost[0]);
    assert.equal(rampRgb('cost', 2, 3), LENS_RAMP_RGB.cost[6]);
    assert.equal(rampRgb('age', 2, 3), LENS_RAMP_RGB.age[6]);
    const print = code(PRINT);
    // The print's tint helper takes the ramp as an argument, so the call names the
    // VARIABLE — what must be true is that both ramps reach it and that no class does.
    assert.ok(/rampRgb\(ramp,/.test(print), 'the printed tint does not come from the shared ramp table');
    assert.ok(/ramp: 'cost'/.test(print) && /ramp: 'age'/.test(print), 'a ramp is missing from the print');
    assert.ok(!/lens-band-\d/.test(print), 'the iframe print spells a CSS class that cannot reach it');
  });

  check('the NOMINAL ramp is IDENTITY-mapped, and `others` always takes the neutral', () => {
    // A supplier is not "further along" a scale, so spreading N supplier bands across the
    // ramp would be meaningless — and worse, it would MOVE a supplier's colour the moment
    // the reader changed how many are named.
    assert.equal(categoryStop(0, false), 0);
    assert.equal(categoryStop(5, false), 5);
    assert.equal(categoryStop(11, false), 11);
    // Clamped short of the reserved slot, whatever index arrives.
    assert.equal(categoryStop(99, false), LENS_CATEGORY_NEUTRAL_STOP - 1);
    // ⚠️ `others` is the NEUTRAL, at every N — never one supplier's hue.
    for (const i of [0, 3, 6, 12, 99]) assert.equal(categoryStop(i, true), LENS_CATEGORY_NEUTRAL_STOP);
    // And the ORDINAL ramps did not move: 3 bands → 0 · 3 · 6, exactly as before.
    assert.equal(rampStop(0, 3), 0);
    assert.equal(rampStop(1, 3), 3);
    assert.equal(rampStop(2, 3), 6);
  });

  check('⚠️ no categorical hue is one of the supplier SEARCH\'s two meanings', () => {
    // `.spotlight-supplier-all` is emerald and `-some` is orange; both already mean
    // something on this grid ("the whole block is this supplier" / "only some of it").
    // A band wearing either would collide with a meaning the page has.
    const css = read(GLOBALS);
    const emerald = /\.spotlight-supplier-all \{[\s\S]*?rgba\((\d+), (\d+), (\d+)/.exec(css);
    const orange = /\.spotlight-supplier-some \{[\s\S]*?rgba\((\d+), (\d+), (\d+)/.exec(css);
    assert.ok(emerald && orange, 'the supplier spotlight hues could not be read from globals.css');
    const taken = [
      `${emerald[1]} ${emerald[2]} ${emerald[3]}`,
      `${orange[1]} ${orange[2]} ${orange[3]}`,
    ];
    for (const triple of LENS_RAMP_RGB.category) {
      assert.ok(
        !taken.includes(triple),
        `the categorical ramp reuses a supplier-spotlight hue (${triple})`,
      );
    }
    // Thirteen slots: twelve hues plus one neutral, and they are all distinct.
    assert.equal(LENS_RAMP_RGB.category.length, LENS_CATEGORY_STOPS);
    assert.equal(new Set(LENS_RAMP_RGB.category).size, LENS_CATEGORY_STOPS);
  });

  check('QUALITY is painted on the AGE ramp, never the COST one', () => {
    // Green→amber→red means cheap→dear on this page, so a wet block in red would read
    // as an expensive one.
    for (const f of [SECTIONS, PRINT]) {
      const body = code(f);
      const qualityRamp = /ramp: 'age'( as LensRampId)?,\s*\n?\s*(\/\/[^\n]*\n\s*)*rows: g\.blocks/.test(body) ||
        /Quality is not cost/.test(read(f));
      assert.ok(qualityRamp, `${f} does not paint quality on the age ramp`);
      assert.ok(/ramp: 'cost'/.test(body), `${f} does not paint price on the cost ramp`);
    }
  });

  check('the SCREEN never spells a `.lens-*` class either — it calls `rampClass`', () => {
    const body = code(SECTIONS);
    assert.ok(body.includes('rampClass('), 'the sections build their swatch some other way');
    assert.ok(
      !/'lens-band-\d/.test(body) && !/'lens-age-\d/.test(body),
      'the sections spell a band class by hand',
    );
  });
}

// ===========================================================================
console.log('\n9. THE LENS SUMMARY PRINT — the platform kit, the filter, the asymmetry');
// ===========================================================================
{
  check('it reuses the platform print kit rather than a second mechanism', () => {
    const body = code(LENS_PRINT);
    assert.ok(/from '@\/components\/shared\/print\/group-print'/.test(body), 'the stage is not the shared one');
    assert.ok(/from '@\/components\/shared\/print\/print-page-rules'/.test(body), 'the rules are not the shared ones');
    assert.ok(/buildPrintPageRules\(\{/.test(body), 'the @page block is not built by the kit');
    assert.ok(/size: A4 landscape|marginMm: LENS_PRINT_MARGIN_MM/.test(body), 'no landscape page box');
    assert.ok(!/printViaIframe/.test(body), 'it mixes the iframe mechanism into the stage one');
  });

  check('the stage is PORTALLED to <body> — the translate trap', () => {
    const body = code(LENS_PRINT);
    assert.ok(/createPortal\(/.test(body), 'the stage is not portalled');
    assert.ok(/document\.body,/.test(body), 'the stage is portalled somewhere other than <body>');
  });

  check('`components/shared/**` stayed TENANT-FREE', () => {
    for (const f of [
      'components/shared/print/group-print.tsx',
      'components/shared/print/print-page-rules.ts',
      'components/shared/print/print-card.ts',
      'components/shared/print/print-fit.ts',
    ]) {
      // COMMENT-STRIPPED: two of these files say "no charcoal, no campaign" in their
      // own headers, which is the opposite of learning the word. What must stay out of
      // the platform layer is tenant vocabulary in the CODE.
      const body = code(f).toLowerCase();
      for (const word of ['charcoal', 'block_loc', 'blend', 'batch', 'lens', 'peso', '₱']) {
        assert.ok(!body.includes(word), `${f} learned the tenant word "${word}"`);
      }
    }
    // The one change made to the kit's sibling is a presentational prop, not knowledge.
    const bar = read(`${LENS}/lens-ratio-bar.tsx`);
    assert.ok(bar.includes('trackClassName'), 'the ratio bar cannot be re-skinned for paper');
  });

  check('the sheet is explicitly LIGHT — a theme token would print the reader’s theme', () => {
    // SCOPED TO THE SHEET. The BUTTON beside it is on-screen chrome on the legend bar
    // and must wear the app's own tokens; it is the printed SHEET that may not, because
    // it is laid out in the live DOM and would otherwise print the reader's theme.
    const whole = code(LENS_PRINT);
    const start = whole.indexOf('function LensSummarySheet');
    const end = whole.indexOf('export interface LensSummaryPrintControlProps');
    assert.ok(start > 0 && end > start, 'the sheet component moved — this check cannot see it');
    const body = whole.slice(start, end);
    assert.ok(/bg-white/.test(body), 'the sheet has no white ground');
    for (const token of ['bg-background', 'bg-card', 'text-foreground', 'text-muted-foreground', 'bg-muted']) {
      assert.ok(!body.includes(token), `the sheet uses the theme token ${token}`);
    }
    // The two deliberate exceptions: the swatch and the bar segments are theme-neutral.
    assert.ok(/lens-band-swatch/.test(body), 'the sheet lost the shared swatch fill');
    assert.ok(/trackClassName="border-zinc-400 bg-zinc-100"/.test(body), 'the bar track is not re-skinned');
  });

  check('it prints the FILTER: isolation is respected and SAID', () => {
    const sheet = code(LENS_PRINT);
    assert.ok(/Showing \{shown\} of \{model\.bandCount\} bands/.test(sheet), 'the sheet never says it is partial');
    for (const panel of [PRICE_PANEL, AGE_PANEL]) {
      const body = code(panel);
      assert.ok(
        /picked\.size === 0 \|\| picked\.has\(b\.index\)/.test(body),
        `${panel} prints every band regardless of what is isolated on screen`,
      );
      assert.ok(/bandCount,/.test(body), `${panel} does not tell the sheet how many bands there are`);
    }
  });

  check('the band table footer says WHICH POPULATION its average covers', () => {
    // The price lens's `total.kgWeightedPhpKg` is over the PRICED blocks while its
    // counts cover every occupied block — a documented asymmetry, so the cell labels it.
    assert.ok(code(PRICE_PANEL).includes("figureNote: 'avg of priced'"), 'the price footer is unlabelled');
    assert.ok(code(AGE_PANEL).includes("figureNote: 'avg of dated'"), 'the age footer is unlabelled');
    assert.ok(/figureNote/.test(code(LENS_PRINT)), 'the sheet drops the note');
  });

  check('the excluded population is a MUTED list, never a band', () => {
    const sheet = code(LENS_PRINT);
    assert.ok(/border-dashed/.test(sheet), 'the excluded list is not visually separated');
    assert.ok(/model\.excluded/.test(sheet));
    for (const panel of [PRICE_PANEL, AGE_PANEL, SUPPLIER_PANEL]) {
      const body = code(panel);
      assert.ok(/excludedRows/.test(body), `${panel} does not list the blocks it cannot place`);
      assert.ok(
        /excludedFigure: (EMDASH|LENS_EMDASH)/.test(body),
        `${panel} gives an unplaced block a figure other than an em dash`,
      );
    }
  });

  check('the sheet is handed PREFORMATTED strings — it formats no figure of its own', () => {
    const body = code(LENS_PRINT);
    assert.ok(!/toFixed\(/.test(body), 'the sheet formats a number itself');
    assert.ok(!/toLocaleString\(/.test(body), 'the sheet formats a number itself');
    assert.ok(!/formatLens/.test(body), 'the sheet reaches for a formatter instead of taking a string');
    // The widths ARE the published shares — the same property the on-screen bar has.
    assert.ok(/sharePct: b\.sharePct/.test(body), 'the bar re-derives its widths');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // THE 2026-09-22 REDESIGN — the owner's four asks, each as an assertion.
  // ─────────────────────────────────────────────────────────────────────────

  check('⚠️ THE TITLE IS THE LENS\'S NAME — exactly, on all three lenses', () => {
    // *"It should just be called price lens."* Not a sentence about the yard.
    assert.ok(code(PRICE_PANEL).includes("title: 'Price lens'"), 'the price sheet is not called "Price lens"');
    assert.ok(code(AGE_PANEL).includes("title: 'Age lens'"), 'the age sheet is not called "Age lens"');
    assert.ok(
      code(SUPPLIER_PANEL).includes("title: 'Supplier lens'"),
      'the supplier sheet is not called "Supplier lens"',
    );
    // The old title, and the old blurb slot, are gone from the model entirely.
    const sheet = code(LENS_PRINT);
    assert.ok(!/settingsLines/.test(sheet), 'the sheet still takes a LIST of settings lines');
    assert.ok(/settingsLine: string;/.test(sheet), 'the sheet has no single terse settings line');
    assert.ok(!/cutLine/.test(sheet), 'the sheet still carries a separate cut-line line');
    assert.ok(!/subtitle=\{model\.settingsLines/.test(sheet));
  });

  check('⚠️ ONE TERSE SETTINGS LINE — `·`-joined facts, and no AI-slop subheading', () => {
    for (const panel of [PRICE_PANEL, AGE_PANEL, SUPPLIER_PANEL]) {
      const body = code(panel);
      assert.ok(
        /settingsLine: \[[\s\S]*?\]\.join\(' · '\)/.test(body),
        `${panel} does not build its settings line as ·-joined facts`,
      );
    }
    // The sheet appends the stamp itself, so a lens never has to know the clock.
    assert.ok(
      /\{model\.settingsLine\} · printed \{printedAt\}/.test(code(LENS_PRINT)),
      'the printed-at stamp is not appended to the one settings line',
    );
    // And the stage header stays OFF — a second heading restating the title is wordiness.
    assert.ok(/showHeader=\{false\}/.test(code(LENS_PRINT)), 'the stage header came back');
  });

  check('⚠️ THE RATIO BAR IS KEPT — the owner said he liked it', () => {
    const sheet = code(LENS_PRINT);
    assert.ok(/<LensRatioBar/.test(sheet), 'the ratio bar was dropped from the sheet');
    assert.ok(/trackClassName="border-zinc-400 bg-zinc-100"/.test(sheet), 'the bar track is not re-skinned');
  });

  check('⚠️ THE THREE-COLUMN LISTS ARE GONE — blocks are grouped by WAREHOUSE', () => {
    const sheet = code(LENS_PRINT);
    assert.ok(!/column-count/.test(sheet), 'the sheet still lays blocks out in newspaper columns');
    assert.ok(!/lens-print-cols/.test(sheet), 'the three-column class survived');
    assert.ok(/band\.warehouses\.map/.test(sheet), 'the sheet does not render warehouse groups');
    // ONE bucketing, shared — three copies would order warehouses three ways.
    const model = code(`${LENS}/lens-summary-model.ts`);
    assert.ok(
      /WAREHOUSE_ORDER: readonly string\[\] = \[\.\.\.Object\.keys\(WAREHOUSES\)/.test(model),
      'the warehouse order is re-listed instead of read from the grid layout',
    );
    for (const panel of [PRICE_PANEL, AGE_PANEL, SUPPLIER_PANEL]) {
      assert.ok(
        /buildLensSummaryBuckets\(\{/.test(code(panel)),
        `${panel} buckets its print rows itself instead of sharing the one bucketing`,
      );
    }
  });

  check('⚠️ EACH BAND STARTS A NEW PAGE, and a warehouse keeps its heading', () => {
    const sheet = code(LENS_PRINT);
    assert.ok(
      /\[data-lens-print\] \.lens-print-band \{ break-before: page; page-break-before: always; \}/.test(sheet),
      'a band no longer starts on a fresh sheet',
    );
    assert.ok(
      /tbody\.lens-print-whse-small \{ break-inside: avoid; \}/.test(sheet),
      'a small warehouse group can be split across sheets',
    );
    assert.ok(
      /tr\.lens-print-whse-head \{ break-after: avoid; \}/.test(sheet),
      'a warehouse heading can be stranded at a page foot',
    );
    assert.ok(/const SMALL_WAREHOUSE_ROWS = 6;/.test(sheet), 'the small-group threshold moved');
  });

  check('⚠️ THE LAB COLUMNS ARE READ, and a SUBTOTAL still COMPUTES none of them', () => {
    const sheet = code(LENS_PRINT);
    // Seven readings, in the RC IN column order, spelled in ONE place.
    const model = code(`${LENS}/lens-summary-model.ts`);
    assert.ok(
      /LENS_SUMMARY_LAB_KEYS = \[\s*'mc',\s*'ash',\s*'bdAstm',\s*'bdJis',\s*'grit',\s*'vm',\s*'fc',\s*\] as const/.test(model),
      'the seven lab columns are not declared in the RC IN order, in one place',
    );
    // The Excel Standard: BD → 3 decimals, everything else → 2.
    assert.ok(/bdAstm: lab3\(/.test(model) && /bdJis: lab3\(/.test(model), 'a BD reading is not 3 dp');
    assert.ok(/mc: lab2\(/.test(model) && /ash: lab2\(/.test(model), 'MC or ASH is not 2 dp');

    // ── RESTATED 2026-09-22, AND DELIBERATELY NOT WEAKENED ────────────────────
    // This used to require the subtotal's seven `<td>`s to be literally EMPTY
    // (`<td key={k} className={TD_SMALL} />`). That was the right guard while the payload
    // published no (band × warehouse) partition: a figure in that cell could only have been
    // a kg-weighted mean computed in TypeScript, which is the one thing this directory may
    // not do. Migration `20260922093000` gave `fn_blocking_price_lens` a
    // `warehouse_subtotals[]` array carrying those seven means, so the cell is now a LOOKUP
    // of SQL's own figure — and the owner asked for it.
    //
    // **The rule did not move; the assertion moved onto the rule.** What is forbidden is
    // COMPUTING a lab mean, so that is what is now checked, in the only two files that
    // could: the sheet may not multiply a reading by a kilogram or divide by one, and the
    // bucketing module may not either. The blank cell is still the ONLY thing a lens with no
    // such published partition can print, which the `LabCells` fallback is what guarantees —
    // pinned below, and pinned again behaviourally in `verify-blocking-lens-ui.ts` §13.
    assert.ok(
      /figures \? figures\.lab\[k\] : null/.test(sheet.replace(/\s+/g, ' ')),
      "a subtotal's lab cell is no longer a LOOKUP of the payload with a blank fallback",
    );
    for (const [rel, body] of [['the sheet', sheet], ['the bucketing module', model]] as const) {
      assert.ok(
        !/\*\s*(kg|weight|balance)\b/i.test(body) && !/\b(kg|weight|balance)\s*\*/i.test(body),
        `${rel} multiplies a reading by a kilogram — that is a weighted average in TypeScript`,
      );
      assert.ok(
        !/\/\s*(kg|groupKg|totalKg|weight)\b/i.test(body),
        `${rel} divides by a weight — a lab mean must come out of SQL`,
      );
    }
    assert.ok(
      !/weighted/i.test(model) || /never/i.test(model),
      'the bucketing module claims to weight something',
    );
    // The readings come off the grid payload, joined by block_loc — read, not computed.
    assert.ok(/lensSummaryLab\(block\)/.test(model), 'the lab row is not read from the grid payload');
  });

  check('⚠️ THE ONE SUM is a warehouse partition, and it FOLDS BACK to the band', () => {
    // The stated exception to "no lens file sums a kilogram": the payload publishes no
    // figure for "band 2's kilograms in warehouse C", so there is nothing this can
    // disagree with. Proven by running the real bucketing over a synthetic grid.
    const data: Record<string, BlockData> = {};
    const lab = { bd_astm: 0.4, bd_jis: 0.42, ash: 3, mc: 11, grit: 1, vm: 18, fc: 78 };
    // Two warehouses, five blocks, all in band 0.
    for (const [loc, balance] of [
      ['A-1A', 100_000], ['A-2A', 50_000], ['B-1A', 25_000], ['B-2A', 12_500], ['PCA-15A', 6_250],
    ] as const) {
      data[loc] = { batch_code: `X-${loc}`, batch_id: loc, status: 'STORED', balance, total_in: balance, php: 40, ...lab };
    }
    const { byBand, excludedRows } = buildLensSummaryBuckets({
      data,
      bandOf: () => 0,
      figureOf: () => 'x',
      sortKeyOf: (_l, b) => b.balance,
      formatKg: (n) => String(n),
      formatBlocks: (n) => String(n),
      excludedFigure: '-',
    });
    const groups = byBand.get(0) ?? [];
    assert.equal(groups.length, 3, 'the blocks did not split into three warehouses');
    // The page's OWN order: A, B, …, then PCA / PCB.
    assert.deepEqual(groups.map((g) => g.key), ['A', 'B', 'PCA']);
    assert.deepEqual(groups.map((g) => g.label), ['WHSE A', 'WHSE B', 'PCA']);
    // Biggest pile first inside a warehouse.
    assert.deepEqual(groups[0].rows.map((r) => r.blockLoc), ['A-1A', 'A-2A']);
    // ⚠️ THE FOLD: the warehouse subtotals add up to the band's own kilograms.
    const folded = groups.map((g) => Number(g.kg)).reduce((a, b) => a + b, 0);
    assert.equal(folded, 193_750, `the warehouse subtotals do not fold to the band (${folded})`);
    assert.equal(excludedRows.length, 0);
    // And a block the lens cannot place lands OUTSIDE every band.
    const unplaced = buildLensSummaryBuckets({
      data,
      bandOf: (loc) => (loc === 'A-1A' ? undefined : 0),
      figureOf: () => 'x',
      sortKeyOf: () => 0,
      formatKg: (n) => String(n),
      formatBlocks: (n) => String(n),
      excludedFigure: '-',
    });
    assert.equal(unplaced.excludedRows.length, 1);
    assert.equal(unplaced.excludedRows[0].blockLoc, 'A-1A');
    assert.equal(unplaced.excludedRows[0].figure, '-');
    for (const g of unplaced.byBand.get(0) ?? []) {
      assert.ok(!g.rows.some((r) => r.blockLoc === 'A-1A'), 'an unplaced block was folded into a band');
    }
  });
}

// ===========================================================================
console.log('\n10. THE DEV FIXTURE, AND THE DOCS');
// ===========================================================================
{
  check('the fixture is gated TWICE and holds no data access', () => {
    const page = read(FIXTURE_PAGE);
    assert.ok(/process\.env\.NODE_ENV === 'production' && !process\.env\.TABLE_PLAYGROUND/.test(page),
      'the fixture is not gated in production');
    assert.ok(/notFound\(\)/.test(page), 'the gate does not 404');
    const mw = read('middleware.ts');
    assert.ok(/TABLE_PLAYGROUND/.test(mw) && /table-playground/.test(mw), 'the second lock is gone');
    const body = read(FIXTURE);
    for (const f of ['createClient', '@/lib/supabase', 'getUserRole', 'canViewPrices()']) {
      assert.ok(!body.includes(f), `the fixture reaches for ${f}`);
    }
  });

  check('the fixture drives the REAL dialog through its adapter PORT, with a REAL delay', () => {
    const body = read(FIXTURE);
    assert.ok(/<BlendProposalDialog/.test(body), 'the fixture does not mount the real dialog');
    assert.ok(/analysisAdapter=\{analysisAdapter\}/.test(body), 'the analysis port is not injected');
    // A microtask-resolving stub hid a request race on the lens panels last week.
    assert.ok(/setTimeout\(r, Number\.isFinite\(delay\) \? delay : 300\)/.test(body),
      'the fixture adapter resolves in a microtask — a skeleton that never renders cannot be reviewed');
    assert.ok(/\?prices=0|prices'\) !== '0'/.test(body), 'the fixture cannot show the price-denied case');
    assert.ok(/stall/.test(body), 'the fixture cannot show the watchdog');
  });

  check('CONTEXT.md documents the feature, the option and both prints', () => {
    const doc = read(CONTEXT);
    for (const phrase of [
      'blend-analysis-options.ts',
      'blend-analysis-sections.tsx',
      'blend-analysis-print.ts',
      'blend-analysis-text.ts',
      'use-blend-analysis.ts',
      'lens/lens-summary-print.tsx',
      'blocking_blend_analysis',
      'Include pages',
      'natural breaks',
      'Against market',
      'Against set price',
      'avg of priced',
      // The 2026-09-22 pass: the three lenses, the bucketing, the categorical palette,
      // the mixed marker, the two attributions, and the two new print rules.
      'lens/supplier-lens-panel.tsx',
      'lens/supplier-lens-settings.ts',
      'lens/lens-summary-model.ts',
      'blocking_lens_supplier',
      'lens-cat-mixed',
      'ONE TABLE, ONE SHEET',
      'A CAPTION IS A LIST OF FACTS',
      'A TYPED FIGURE IS A SET PRICE',
      'apportioned',
      'Supplier lens — UI',
    ]) {
      assert.ok(doc.includes(phrase), `CONTEXT.md does not mention "${phrase}"`);
    }
  });
}

// ===========================================================================
console.log('\n11. THE YARD MAP PAGE IN THE BLEND PRINT (2026-09-23)');
// ===========================================================================
//
// The owner: *"I'd also like to see a blocking view in the print of blend proposals,
// similar to the ones we made for the lens prints."*
//
// "Similar to" is the assertion, not a compliment: the geometry, the one-page fit, the
// paper palette, the ink rule and the four cell kinds must be the LENS MAP's, imported
// rather than ported — a second copy of "how big is a cell" is how a one-page promise
// stops being one. Node has no renderer, so what is proven here is everything except how
// the paper looks: that the page exists in BOTH print paths, that it lands between the
// blocks table and the analysis sheets, that the fourth option is parsed as untrusted and
// defaults ON, that the fill comes from the analysis payload's own groups when they are
// there and from ONE accent when they are not, that a vacated block is marked and never
// dropped, and that nothing on the sheet does arithmetic on a kilogram.
{
  const yard = code(YARD);
  const model = code(YARD_MODEL);
  const dialog = code(DIALOG);
  const pdf = code(PDF);

  // A yard shaped like the fixture's: 24 selected blocks (one of them vacated), plus
  // other piles, over the app's own geometry.
  const SELECTED = ['A-1A', 'B-1B', 'D-1A', 'A-2B', 'C-2A', 'D-2B', 'A-3C'];
  const VACATED = 'A-3C';
  const OTHERS = ['A-7A', 'B-8A', 'C-7A', 'D-8A'];
  const OCCUPIED = [...SELECTED.filter((l) => l !== VACATED), ...OTHERS];

  /** A price section shaped like `fn_blend_analysis`'s, with three natural groups. */
  function priceAnalysis(): BlendAnalysis {
    const mk = (loc: string) => ({ batchId: loc, blockLoc: loc, batchCode: `X-${loc}`, kg: 1000, phpKg: 40 });
    const group = (index: number, label: 'low' | 'mid' | 'high', locs: string[]) => ({
      index,
      label,
      rangeMin: 36,
      rangeMax: 50,
      blockCount: locs.length,
      kg: locs.length * 1000,
      kgSharePct: 100 / 3,
      blockSharePct: 100 / 3,
      kgWeightedPhpKg: 40,
      valuePhp: locs.length * 40000,
      blocks: locs.map(mk),
    });
    return {
      ...SAMPLE_ANALYSIS,
      price: {
        ...SAMPLE_ANALYSIS.price!,
        natural: {
          ...SAMPLE_ANALYSIS.price!.natural,
          groupCount: 3,
          groups: [
            group(0, 'low', ['A-1A', 'B-1B']),
            group(1, 'mid', ['D-1A', 'A-2B']),
            group(2, 'high', ['C-2A', 'D-2B', 'A-3C']),
          ],
        },
      },
    } as BlendAnalysis;
  }

  check('the page exists in BOTH print paths, and in NEITHER as a second implementation', () => {
    // HTML: one section, built by the ONE builder and threaded through the document.
    assert.ok(/export function buildBlendYardMapPage\(/.test(yard), 'there is no HTML map builder');
    assert.ok(/buildBlendYardMapPage\(yardMap\)/.test(dialog), 'the dialog never builds the map sheet');
    assert.ok(/yardMapHtml\?: string \| null/.test(dialog), 'the print document takes no map sheet');
    // PDF: drawn natively, on its own added page, from the SAME model object.
    assert.ok(/function drawYardMapPage\(/.test(pdf), 'the PDF has no map page');
    assert.ok(/if \(yardMap\) drawYardMapPage\(/.test(pdf), 'the PDF never draws the map');
    // ONE page, added once — the same discipline `analysisHeading` keeps.
    const draw = pdf.slice(
      pdf.indexOf('function drawYardMapPage'),
      pdf.indexOf('export function downloadBlendPdf'),
    );
    assert.ok(draw.length > 0, 'the map drawing slice is empty — the bound moved');
    assert.equal(
      (draw.match(/doc\.addPage\(\)/g) ?? []).length,
      1,
      'the PDF map page adds more than one sheet',
    );
    assert.ok(
      /yardMap\?: BlendYardMapModel \| null/.test(pdf),
      'the PDF builds its own map model instead of taking the screen’s',
    );
    // ONE model, TWO documents.
    assert.equal(
      (dialog.match(/buildBlendYardMapModel\(/g) ?? []).length,
      1,
      'the dialog builds the map model more than once — the two documents could disagree',
    );
    assert.ok(
      !/buildBlendYardMapModel/.test(pdf),
      'the PDF builds its own map model — it must take the one the screen built',
    );
  });

  check('it lands DIRECTLY after Selected Blocks and BEFORE the analysis sheets', () => {
    const doc = read(DIALOG);
    const blocks = doc.indexOf('<h2>Selected Blocks</h2>');
    const map = doc.indexOf('${yardHtml}');
    const analysisAt = doc.indexOf('${analysisHtml}');
    assert.ok(blocks > 0 && map > 0 && analysisAt > 0, 'one of the three sections is gone');
    assert.ok(blocks < map, 'the map prints before the blocks table it describes');
    assert.ok(map < analysisAt, 'the map prints after the analysis sheets');
    // The PDF orders them the same way, by call order.
    assert.ok(
      pdf.indexOf('drawYardMapPage(doc, marginX, yardMap)') <
        pdf.indexOf('appendAnalysisPages(doc, marginX, analysis)'),
      'the PDF draws the map after the analysis pages',
    );
  });

  check('ONE landscape page, structurally — and its CSS rides independently', () => {
    assert.ok(/\.ymap \{[^}]*break-before: page/.test(yard), 'the map does not start a page');
    assert.ok(/\.ymap \{[^}]*break-inside: avoid/.test(yard), 'the map may split across sheets');
    assert.ok(/page-break-inside: avoid/.test(yard), 'the map has no legacy break-inside fallback');
    // It must NOT wear `.apage`: that stylesheet rides only when there ARE analysis
    // sheets, and the map may be the only extra sheet a reader ticked.
    assert.ok(!/class="apage/.test(yard), 'the map borrows the analysis page class');
    assert.ok(
      /const yardCss = yardHtml === '' \? '' : BLEND_YARD_MAP_PRINT_CSS;/.test(dialog),
      'the map CSS is not gated on the map being present',
    );
    // And the margin is ONE number, read by the @page rule and by the solve.
    assert.equal(BLEND_PRINT_MARGIN_MM, 10);
    assert.ok(
      /margin: \$\{BLEND_PRINT_MARGIN_MM\}mm/.test(dialog),
      'the @page rule states its own margin instead of reading the constant',
    );
    assert.ok(
      /return blendYardMapSolve\(model, BLEND_PRINT_MARGIN_MM\);/.test(yard),
      'the map solves against a margin the document does not print at',
    );
    // ⚠️ THE CHROME BUDGET IS THE SHEET'S OWN, and BOTH paths read it. At the lens
    // sheet's 40 px this page laid out 46.59 px over one A4 landscape sheet and its
    // legend printed on a second one, which `break-inside: avoid` cannot fix.
    assert.ok(
      /function blendYardMapReservedPx\(/.test(yard),
      'the map no longer budgets its own heading, legend and footnote',
    );
    assert.ok(
      /solveYardMapFit\(model\.map, marginMm, blendYardMapReservedPx\(model\.note !== ''\)\)/.test(yard),
      'the solve does not take the sheet’s own reserve',
    );
    assert.ok(
      /blendYardMapSolve\(model, marginMm\)/.test(pdf),
      'the PDF page does not share the sheet’s chrome budget',
    );
    // The LENS callers pass no reserve, so their pages are unchanged.
    assert.ok(
      /reservedHeightPx: number = YARD_MAP_RESERVED_PX/.test(code(YARD_MODEL)),
      'the reserve override has no lens-preserving default',
    );
  });

  check('the GEOMETRY, the FIT, the PALETTE and the INK are IMPORTED, never restated', () => {
    assert.ok(
      /from '\.\.\/blocking\/lens\/lens-yard-map-model'/.test(yard),
      'the blend map does not read the lens map model',
    );
    for (const fn of ['buildBlendYardMapCells', 'lensYardMapPaint', 'solveYardMapFit', 'lensYardMapLines']) {
      assert.ok(yard.includes(fn), `the blend map does not reuse ${fn}`);
    }
    assert.ok(/printFillRgbAtStop/.test(yard), 'the blend map does not read the PRINT palette');
    assert.ok(/resolveBandRampStop/.test(yard), 'the blend map decides a band stop itself');
    // It must not reach for the SCREEN ramp (the lens map's own rule — solid at screen
    // saturation is what put white ink on half the paper).
    assert.ok(!/LENS_RAMP_RGB|rampRgbAtStop/.test(yard), 'the blend map paints the SCREEN ramp solid');
    assert.ok(!/lens-band-|lens-age-|lens-cat-/.test(yard), 'the blend map spells a ramp class');
    // No second copy of the geometry or the paper box.
    assert.ok(!/WAREHOUSES/.test(yard), 'the blend map restates the yard geometry');
    assert.ok(!/fitCellGrid|a4LandscapeBox|A4_|PX_PER_MM/.test(yard), 'the blend map re-derives the fit');
    // The slot count must appear in NEITHER — scoped to the map's own drawing block in
    // the PDF, because that file's table styles legitimately carry a grey `238` channel.
    const pdfDraw = pdf.slice(
      pdf.indexOf('function drawYardMapPage'),
      pdf.indexOf('export function downloadBlendPdf'),
    );
    for (const [rel, body] of [[YARD, yard], [`${PDF} (map)`, pdfDraw]] as const) {
      assert.ok(body.length > 0, `${rel} is empty — the bound moved`);
      assert.ok(
        !/\b(220|238|240)\b/.test(body.replace(/\d+px|\d+pt|\d+mm/g, ' ')),
        `${rel} hardcodes a slot count — the geometry has exactly one declaration`,
      );
    }
    // The PDF draws with the shared solve too, and converts units rather than re-solving.
    assert.ok(
      !/fitCellGrid|fitMonoLabelPt|a4LandscapeBox/.test(pdf),
      'the PDF page re-solves the grid itself',
    );
    assert.ok(/PT_PER_PX/.test(pdf), 'the PDF page does not convert the solve’s px to points');
  });

  check('EVERY slot is drawn — the count comes out of `WAREHOUSES`', () => {
    const standard = Object.entries(WAREHOUSES)
      .filter(([k]) => k.length === 1)
      .reduce((a, [, w]) => a + w.cols * w.rows.length, 0);
    const m = buildBlendYardMapModel({
      occupiedLocs: OCCUPIED,
      selectedLocs: SELECTED,
      analysis: null,
      priceGroupsOn: false,
    });
    assert.equal(m.map.slotCount, standard, 'the map does not draw every standard slot');
    // PCA/PCB are opt-in INDEPENDENTLY, exactly as on the lens map.
    const withPca = buildBlendYardMapModel({
      occupiedLocs: [...OCCUPIED, 'PCA-15A'],
      selectedLocs: SELECTED,
      analysis: null,
      priceGroupsOn: false,
    });
    assert.ok(withPca.map.sections.some((s) => s.key === 'PCA'), 'PCA absent with stock in it');
    assert.ok(!withPca.map.sections.some((s) => s.key === 'PCB'), 'PCB drawn with nothing in it');
  });

  check('⚠️ a SELECTED block the yard no longer holds is FILLED and MARKED, never dropped', () => {
    const m = buildBlendYardMapModel({
      occupiedLocs: OCCUPIED,
      selectedLocs: SELECTED,
      analysis: null,
      priceGroupsOn: false,
    });
    assert.deepEqual([...m.goneLocs], [VACATED], 'the vacated block is not reported');
    const cell = m.map.sections
      .flatMap((s) => s.cells.flat())
      .find((c) => c.loc === VACATED);
    assert.ok(cell, 'the vacated block is not on the map at all');
    assert.equal(cell!.occupied, true, 'the vacated block reads as an empty slot');
    assert.equal(cell!.mixed, true, 'the vacated block carries no marker');
    const paint = lensYardMapPaint(cell!, m.ramp, blendYardMapStops(m));
    assert.equal(paint.kind, 'banded', 'the vacated block lost its selection fill');
    assert.equal(paint.outline, paint.ink, 'the marker is not the ink that is legible on the fill');
    // The legend NAMES it, and the sheet says which blocks they were.
    const legend = blendYardMapLegend(m).map((r) => r.text);
    assert.ok(
      legend.some((t) => t.includes('no longer occupied')),
      'the legend never explains the dashed cells',
    );
    const html = buildBlendYardMapPage(m);
    assert.ok(html.includes(VACATED), 'the sheet does not name the vacated block');
    assert.ok(/dashed/.test(html), 'no cell on the sheet is dashed');
    // A block still in the yard is NOT marked.
    const kept = m.map.sections.flatMap((s) => s.cells.flat()).find((c) => c.loc === 'A-1A');
    assert.equal(kept!.mixed, false, 'a block that is still there was marked as vacated');
  });

  check('an occupied block that is NOT in the blend is plain grey — never the dash', () => {
    const m = buildBlendYardMapModel({
      occupiedLocs: OCCUPIED,
      selectedLocs: SELECTED,
      analysis: null,
      priceGroupsOn: false,
    });
    const other = m.map.sections.flatMap((s) => s.cells.flat()).find((c) => c.loc === 'A-7A');
    const paint = lensYardMapPaint(other!, m.ramp, blendYardMapStops(m));
    // `muted`, NOT `nodata`: "not selected" and "we could not place it" are different
    // answers, and only the second draws a dash.
    assert.equal(paint.kind, 'muted', 'an unselected pile reads as a no-data cell');
    assert.equal(paint.bg, LENS_YARD_MAP_MUTED_BG);
    assert.equal(paint.outline, null, 'an unselected pile is dashed');
    // And an empty slot is white.
    const empty = m.map.sections.flatMap((s) => s.cells.flat()).find((c) => c.loc === 'A-19A');
    assert.equal(lensYardMapPaint(empty!, m.ramp, blendYardMapStops(m)).kind, 'empty');
  });

  check('⚠️ the fill is the PAYLOAD’s price groups when the page is ON — NOTHING is grouped here', () => {
    const m = buildBlendYardMapModel({
      occupiedLocs: OCCUPIED,
      selectedLocs: SELECTED,
      analysis: priceAnalysis(),
      priceGroupsOn: true,
    });
    assert.equal(m.byPriceGroup, true, 'the map ignored the price groups it was handed');
    assert.equal(m.bandCount, 3);
    // THREE legend entries, LOW first — the words come from `groupWord`, the one definition.
    assert.deepEqual(
      m.bands.map((b) => b.label),
      [groupWord('low', 3), groupWord('mid', 3), groupWord('high', 3)],
    );
    // low / average / high → the cost ramp's stops 0 / 3 / 6, the SAME mapping the tables
    // use (`rampStop(index, 3)` positional over seven stops).
    const stops = blendYardMapStops(m);
    assert.deepEqual([stops.get(0), stops.get(1), stops.get(2)], [0, 3, 6]);
    // And a block wears its OWN group's fill, read off `groups[].blocks[]`.
    const high = m.map.sections.flatMap((s) => s.cells.flat()).find((c) => c.loc === 'C-2A');
    assert.equal(high!.band, 2, 'a block is not in the group the payload put it in');
    assert.equal(
      lensYardMapPaint(high!, m.ramp, stops).bg,
      `rgb(${LENS_PRINT_FILL_RGB.cost[6]})`,
      'the dearest group is not the PRINT palette’s stop 6',
    );
  });

  check('with the price page OFF (or no payload) it is ONE accent and says only `Selected block`', () => {
    for (const [why, input] of [
      ['page off', { analysis: priceAnalysis(), priceGroupsOn: false }],
      ['no payload', { analysis: null, priceGroupsOn: true }],
    ] as const) {
      const m = buildBlendYardMapModel({
        occupiedLocs: OCCUPIED,
        selectedLocs: SELECTED,
        ...input,
      });
      assert.equal(m.byPriceGroup, false, `${why}: the map still coloured by price group`);
      assert.equal(m.bandCount, 1);
      assert.deepEqual(m.bands.map((b) => b.label), ['Selected block'], `${why}: wrong legend`);
      // The accent is stated, not positional — a single band at position 0 would otherwise
      // wear the ramp's CHEAPEST stop and read as a price claim.
      assert.equal(blendYardMapStops(m).get(0), BLEND_YARD_MAP_ACCENT_STOP);
      assert.equal(BLEND_YARD_MAP_ACCENT_STOP, 3, 'the accent is no longer the ramp’s middle stop');
      const cell = m.map.sections.flatMap((s) => s.cells.flat()).find((c) => c.loc === 'A-1A');
      assert.equal(
        lensYardMapPaint(cell!, m.ramp, blendYardMapStops(m)).bg,
        `rgb(${LENS_PRINT_FILL_RGB.cost[BLEND_YARD_MAP_ACCENT_STOP]})`,
      );
    }
  });

  check('the map is PRICE-FREE, so its checkbox is NOT gated and a denied reader keeps it', () => {
    // No ₱ glyph, no cost vocabulary, in either the module or the model it reads.
    for (const [rel, body] of [[YARD, yard], [YARD_MODEL, model]] as const) {
      assert.ok(!/₱/.test(body), `${rel} carries a peso glyph`);
      assert.ok(!/phpKg|valuePhp|kgWeighted/.test(body), `${rel} reads a money figure`);
    }
    // The emitted SHEET carries none either, on a payload that has prices in it.
    const html = buildBlendYardMapPage(
      buildBlendYardMapModel({
        occupiedLocs: OCCUPIED,
        selectedLocs: SELECTED,
        analysis: priceAnalysis(),
        priceGroupsOn: true,
      }),
    );
    assert.ok(!/₱|PHP|\bpeso\b/i.test(html), 'the printed yard map carries money');
    // The checkbox list filters ONLY the price row; the map row survives for every reader.
    assert.ok(
      /filter\(\(id\) => id !== 'price' \|\| canViewPrices\)/.test(code(SECTIONS)),
      'the include-pages row filter changed shape',
    );
    // And the count keeps the map for a denied reader.
    const all = { price: true, quality: true, age: true, yardMap: true };
    assert.equal(includedPageCount(all, true), 4);
    assert.equal(includedPageCount(all, false), 3, 'a denied reader lost the yard map too');
    assert.equal(
      includedPageCount({ price: true, quality: false, age: false, yardMap: true }, false),
      1,
      'the map alone does not count as a page',
    );
    // The map alone must NOT trigger the analysis round-trip.
    assert.equal(
      wantsAnalysis({ price: false, quality: false, age: false, yardMap: true }, true),
      false,
      'ticking only the yard map still fetches the analysis',
    );
  });

  check('the `+N` on the Print button is the INCLUDE count, from the one definition', () => {
    assert.ok(
      /const printPageCount = includedPageCount\(analysisOptions, showPrices\);/.test(dialog),
      'the button count is not the shared include count',
    );
    assert.ok(/\+\{printPageCount\}/.test(dialog), 'the button no longer shows the count');
    assert.ok(/pageCount=\{printPageCount\}/.test(dialog), 'the popover shows a different count');
    // And the PRICE-GROUP decision reads the same gate the document does.
    assert.ok(
      /const priceGroupsOn = analysisPageIds\.includes\('price'\);/.test(dialog),
      'the map decides its colouring from something other than the analysis gate',
    );
  });

  check('the SHEET computes nothing: no reduce, no running total, no percentage', () => {
    for (const [rel, body] of [[YARD, yard]] as const) {
      assert.ok(!/\breduce\s*\(/.test(body), `${rel} folds something`);
      assert.ok(!/[^+]\+=[^=]/.test(body), `${rel} keeps a running total`);
      assert.ok(!/\*\s*100\b/.test(body), `${rel} builds a percentage`);
      assert.ok(!/\/\s*(total|totalKg|blockCount|\w+\.length)\b/.test(body), `${rel} divides by a total`);
    }
  });

  check('the CAPTION says which half is today and which half is the saved day', () => {
    const live = buildBlendYardMapModel({
      occupiedLocs: OCCUPIED,
      selectedLocs: SELECTED,
      analysis: null,
      priceGroupsOn: false,
    });
    assert.equal(live.caption, 'Yard occupancy as of today');
    const savedMap = buildBlendYardMapModel({
      occupiedLocs: OCCUPIED,
      selectedLocs: SELECTED,
      analysis: null,
      priceGroupsOn: false,
      asSavedDate: '2026-09-21',
    });
    assert.equal(
      savedMap.caption,
      'Yard occupancy as of today · selection as saved 2026-09-21',
    );
    // The date is the SNAPSHOT's, never the print clock.
    assert.ok(
      /blendComputedDate\(saved\.proposal\.computed_at\)/.test(dialog),
      'the caption date is not the saved version’s own computed_at',
    );
    assert.ok(buildBlendYardMapPage(savedMap).includes('2026-09-21'));
  });

  check('the grid supplies the WHOLE yard, and the fixture can stage the vacated case', () => {
    const grid = code(GRID);
    assert.ok(/const occupiedLocs = useMemo\(\(\) => Object\.keys\(data\), \[data\]\);/.test(grid),
      'the grid does not derive the occupancy from its own payload');
    assert.ok(/occupiedLocs=\{occupiedLocs\}/.test(grid), 'the grid does not hand the dialog the yard');
    const fixture = code(FIXTURE);
    assert.ok(/VACATED_LOC/.test(fixture), 'the rig cannot stage a block the yard no longer holds');
    assert.ok(/OTHER_OCCUPIED_LOCS/.test(fixture), 'the rig has no other piles, so the map has no grey');
    assert.ok(/params\.get\('pca'\) === '1'/.test(fixture), 'the rig has no ?pca= switch for the worst fit');
    assert.ok(/occupiedLocs=\{occupiedLocs\}/.test(fixture), 'the rig never passes an occupancy');
  });

  check('CONTEXT.md documents the map page, the colour rule, the caption and the option', () => {
    const doc = read(CONTEXT);
    for (const phrase of [
      '_shared/blend-yard-map-print.ts',
      'Yard occupancy as of today',
      'no longer occupied',
      'Selected block',
      'THE YARD MAP PAGE IN THE BLEND PRINT',
      'BLEND_PRINT_MARGIN_MM',
    ]) {
      assert.ok(doc.includes(phrase), `CONTEXT.md does not mention "${phrase}"`);
    }
  });
}

console.log(`\n${passed} assertions passed.`);
