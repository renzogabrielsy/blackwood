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
  BLEND_ANALYSIS_PAGE_ORDER,
  BLEND_ANALYSIS_SETTINGS_MODULE,
  DEFAULT_BLEND_ANALYSIS_OPTIONS,
  parseBlendAnalysisOptions,
  serializeBlendAnalysisOptions,
  wantsAnalysis,
} from '../app/(app)/inventory/_shared/blend-analysis-options';
import {
  groupWord,
  monthName,
  naturalMethodNote,
  qualityDecimals,
  snapshotGapNote,
  unmeasuredNote,
  vsMarketCaption,
  vsMarketUnavailableNote,
  fmtDays,
  fmtKg,
  fmtQuality,
  fmtSharePct,
} from '../app/(app)/inventory/_shared/blend-analysis-text';
import {
  LENS_RAMP_RGB,
  LENS_RAMP_STOPS,
  rampRgb,
  rampStop,
} from '../app/(app)/inventory/blocking/lens/lens-ramp';
import {
  BLEND_ANALYSIS_DEFAULT_AGE_EDGES,
  BLEND_ANALYSIS_DEFAULT_PRICE_EDGES,
  BLEND_ANALYSIS_QUALITY_METRICS,
} from '../app/(app)/inventory/blocking/types';
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
const LENS_PRINT = `${LENS}/lens-summary-print.tsx`;
const PRICE_PANEL = `${LENS}/price-lens-panel.tsx`;
const AGE_PANEL = `${LENS}/age-lens-panel.tsx`;
const GLOBALS = 'app/globals.css';
const CONTEXT = 'app/(app)/inventory/blocking/CONTEXT.md';
const FIXTURE = 'app/dev/table-playground/blendanalysis/blendanalysis-fixture.tsx';
const FIXTURE_PAGE = 'app/dev/table-playground/blendanalysis/page.tsx';

/** Every file this script reasons about. A missing one is a failure, not a pass. */
const ALL_FILES = [
  OPTIONS, TEXT, SECTIONS, PRINT, HOOK, DIALOG, PDF, LENS_PRINT, PRICE_PANEL, AGE_PANEL,
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
    const all = { price: true, quality: true, age: true };
    assert.deepEqual(analysisPages(all, true), ['price', 'quality', 'age']);
    // A denied reader loses the price page WHATEVER the stored option says.
    assert.deepEqual(analysisPages(all, false), ['quality', 'age']);
    assert.deepEqual(analysisPages({ price: true, quality: false, age: false }, false), []);
    assert.equal(wantsAnalysis({ price: true, quality: false, age: false }, false), false);
    assert.equal(wantsAnalysis({ price: true, quality: false, age: false }, true), true);
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
  check('the default is all three pages ON', () => {
    assert.deepEqual(DEFAULT_BLEND_ANALYSIS_OPTIONS, { price: true, quality: true, age: true });
    assert.deepEqual(BLEND_ANALYSIS_PAGE_ORDER, ['price', 'quality', 'age']);
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
    assert.deepEqual(parsed, { price: false, quality: true, age: true });
  });

  check('junk of every shape parses to the shipped defaults', () => {
    for (const junk of [null, undefined, 0, '', 'price', [], [1, 2], true, NaN]) {
      assert.deepEqual(parseBlendAnalysisOptions(junk), DEFAULT_BLEND_ANALYSIS_OPTIONS);
    }
  });

  check('serialize OMITS defaults, so turning everything back on is a REMOVAL', () => {
    assert.deepEqual(serializeBlendAnalysisOptions(DEFAULT_BLEND_ANALYSIS_OPTIONS), {});
    assert.deepEqual(serializeBlendAnalysisOptions({ price: false, quality: true, age: false }), {
      price: false,
      age: false,
    });
  });

  check('parse ∘ serialize is the identity on every one of the eight states', () => {
    for (const price of [true, false]) {
      for (const quality of [true, false]) {
        for (const age of [true, false]) {
          const o = { price, quality, age };
          assert.deepEqual(parseBlendAnalysisOptions(serializeBlendAnalysisOptions(o)), o);
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
    assert.ok(
      /analysisPageCount = analysisPages\(analysisOptions, showPrices\)\.length/.test(body),
      'the button count is derived some other way than the gate',
    );
    assert.ok(/data-blend-print/.test(body), 'the print button lost its test hook');
    assert.ok(/\+\{analysisPageCount\}/.test(body), 'the print button does not show the count');
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

  check('the method note names both cut lines and the fit, in plain language', () => {
    const note = naturalMethodNote({
      subject: 'prices',
      groupCount: 3,
      cuts,
      gvf: 0.9761,
      formatCut: (v) => `₱${v.toFixed(2)}`,
    });
    assert.ok(note.includes('₱38.97'), `the first cut line is missing: ${note}`);
    assert.ok(note.includes('₱44.50'), `the second cut line is missing: ${note}`);
    assert.ok(note.includes('3 groups'), 'the group count is not stated');
    assert.ok(note.includes('Fit 97.6%'), `the fit is not stated: ${note}`);
  });

  check('TWO groups say "two groups"; ONE group says so honestly and claims no fit', () => {
    const two = naturalMethodNote({
      subject: 'prices',
      groupCount: 2,
      cuts: [cuts[0]],
      gvf: 0.81,
      formatCut: (v) => `₱${v.toFixed(2)}`,
    });
    assert.ok(two.includes('two groups') && two.includes('cut line at'), two);
    assert.ok(!two.includes('cut lines at'), 'a single cut line is described in the plural');

    // A blend whose blocks all cost the same has NO variance, so `gvf` is NULL — and a
    // "Fit 0.0%" would be a lie about a population there is nothing to explain in.
    const one = naturalMethodNote({
      subject: 'prices',
      groupCount: 1,
      cuts: [],
      gvf: null,
      formatCut: (v) => String(v),
    });
    assert.ok(one.startsWith('All one group'), one);
    assert.ok(!one.includes('Fit'), 'a degenerate split claims a fit');
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

  check('the market caption says ROUNDS UP for a measured basis and IS THE LINE for a typed one', () => {
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
    assert.ok(measured.includes('September 2026 deliveries'), measured);
    assert.ok(measured.includes('rounds up to ₱40'), measured);

    const typed = vsMarketCaption({
      marketPhpKg: 41,
      marketBasis: 'given',
      marketBasisMonth: null,
      roundedUpPhp: 41,
      edgeOffsets: [-1, 0],
      bands: [],
      unmeasured: { blockCount: 0, kg: 0, blocks: [] },
      overall: { blockCount: 0, kg: 0, kgWeightedPhpKg: null, valuePhp: 0 },
    });
    assert.ok(typed.includes('(typed)'), typed);
    assert.ok(typed.includes('₱41 and up is above market'), typed);
    assert.ok(!typed.includes('rounds up'), 'a typed price is described as rounding up');
    assert.equal(monthName('2026-09-01'), 'September 2026');
  });

  check('a market that cannot be measured is EXPLAINED, and never treated as ₱0', () => {
    const note = vsMarketUnavailableNote({
      reason: 'no_market_price',
      message: 'No market price for this month.',
      marketBasis: 'as_of_month',
      marketBasisMonth: '2026-09-01',
    });
    assert.ok(note.includes('September 2026'), note);
    assert.ok(note.includes('₱0 would put every block above market'), note);
    for (const f of [SECTIONS, PRINT]) {
      assert.ok(
        code(f).includes('vsMarketUnavailable'),
        `${f} ignores the reason and would render an empty table`,
      );
    }
  });

  check('an unmeasured block is explained, and NULL reads as an em dash everywhere', () => {
    const note = unmeasuredNote(
      { blockCount: 2, kg: 30_115, noValueCount: 1, noWeightCount: 1, blocks: [] },
      'reading',
    );
    assert.ok(note.includes('2 blocks'), note);
    assert.ok(note.includes('In no group'), note);
    assert.ok(note.includes('nothing in the pile to weight it with'), note);
    assert.equal(fmtSharePct(null), '—');
    assert.equal(fmtDays(null), '—');
    assert.equal(fmtQuality('ash', null), '—');
    assert.equal(fmtKg(74_590.4), '74,590');
    // And a snapshot gap is reconciled by SHOWING BOTH, never by picking a winner.
    const gap = snapshotGapNote({ snapshot: '2.13', measured: '3.13', excluded: 'blocks with no reading' });
    assert.ok(gap.includes('2.13') && gap.includes('3.13'), gap);
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

  check('each page starts on its own sheet, and a heading never ends one', () => {
    const css = code(PRINT);
    assert.ok(/\.apage \{ break-before: page; page-break-before: always; \}/.test(css));
    assert.ok(/\.apage h2 \{[\s\S]*?break-after: avoid;/.test(css), 'an h2 can be orphaned');
    assert.ok(/\.apage h3 \{[\s\S]*?break-after: avoid;/.test(css), 'an h3 can be orphaned');
    assert.ok(/\.apage \.anote \{[\s\S]*?break-after: avoid;/.test(css), 'a caption can be orphaned');
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
  check('all fourteen hues match `globals.css` exactly', () => {
    const css = read(GLOBALS);
    for (const [ramp, prefix] of [
      ['cost', 'lens-band'],
      ['age', 'lens-age'],
    ] as const) {
      for (let i = 0; i < LENS_RAMP_STOPS; i++) {
        const m = new RegExp(`\\.${prefix}-${i} \\{ --lens-hue: ([\\d ]+); \\}`).exec(css);
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
    assert.ok(code(PRICE_PANEL).includes('unpricedRows'), 'the price lens does not list its unpriced blocks');
    assert.ok(code(AGE_PANEL).includes('undatedRows'), 'the age lens does not list its undated blocks');
  });

  check('the sheet is handed PREFORMATTED strings — it formats no figure of its own', () => {
    const body = code(LENS_PRINT);
    assert.ok(!/toFixed\(/.test(body), 'the sheet formats a number itself');
    assert.ok(!/toLocaleString\(/.test(body), 'the sheet formats a number itself');
    assert.ok(!/formatLens/.test(body), 'the sheet reaches for a formatter instead of taking a string');
    // The widths ARE the published shares — the same property the on-screen bar has.
    assert.ok(/sharePct: b\.sharePct/.test(body), 'the bar re-derives its widths');
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
      'avg of priced',
    ]) {
      assert.ok(doc.includes(phrase), `CONTEXT.md does not mention "${phrase}"`);
    }
  });
}

console.log(`\n${passed} assertions passed.`);
