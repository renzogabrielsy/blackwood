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
  LENS_RAMP_CLASS_PREFIX,
  LENS_RAMP_STOPS,
  rampClass,
} from '../app/(app)/inventory/blocking/lens/lens-ramp';
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
const ALL_LENS_FILES = [
  PANEL, AGE_PANEL, SETTINGS, AGE_SETTINGS, FRAME, TYPES, STORE, REGISTRY,
  RAMP, SHARED, ROWS, BAR, CUSTOMIZE, BANNER,
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
    assert.ok(!/sort\s*\(/.test(body), 'the age panel sorts blocks to find an extreme');
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

  check('a non-object, an array and null all parse to the shipped defaults', () => {
    for (const junk of [null, undefined, 42, 'nope', ['a'], true]) {
      const p = parsePriceLensSettings(junk);
      assert.deepEqual(p.edgeOffsets, [-1, 0]);
      assert.equal(p.basis, 'this_month');
      assert.equal(p.unit, 'kg');
    }
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

  check('TWO lenses are registered — Price FIRST, Age SECOND — and their ids are the `?lens=` values', () => {
    assert.equal(PRICE_LENS_ID, 'price');
    assert.equal(AGE_LENS_ID, 'age');
    const reg = code(REGISTRY);
    assert.ok(
      /BLOCKING_LENSES[^=]*=\s*\[PRICE_LENS,\s*AGE_LENS\]/.test(reg),
      'the registry is not exactly [PRICE_LENS, AGE_LENS] — order is TAB order, and Price is a price-viewer\'s default',
    );
    assert.ok(reg.includes("from './age-lens-panel'"), 'the age lens is not imported from its own panel file');
  });

  check('each lens declares its OWN ramp, and the two differ', () => {
    assert.equal(PRICE_LENS_RAMP, 'cost');
    assert.equal(AGE_LENS_RAMP, 'age');
    assert.notEqual(PRICE_LENS_RAMP, AGE_LENS_RAMP, 'both lenses paint on the same scale');
    assert.ok(/ramp:\s*PRICE_LENS_RAMP/.test(code(PANEL)), 'PRICE_LENS does not declare its ramp');
    assert.ok(/ramp:\s*AGE_LENS_RAMP/.test(code(AGE_PANEL)), 'AGE_LENS does not declare its ramp');
    // The frame and the grid must know nothing about either scale.
    assert.ok(!/lens-band|lens-age/.test(code(FRAME)), 'the frame hardcodes a ramp class');
    assert.ok(!/lens-band-|lens-age-/.test(code(GRID)), 'the grid hardcodes a ramp class');
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

console.log(`\n${passed} assertions passed.`);
