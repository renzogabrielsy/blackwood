/**
 * verify-blocking-lens-ui.ts — the proofs behind the BLOCKING LENS **UI**.
 *
 * Run: npx tsx scripts/verify-blocking-lens-ui.ts
 *
 * ============================================================================
 * WHAT THIS SCRIPT IS FOR, AND WHAT IT IS DELIBERATELY NOT FOR
 * ============================================================================
 * `scripts/verify-blocking-price-lens.ts` proves the DATA layer against the live
 * database (49 assertions). This one proves the things a data-layer test cannot
 * see and a type-checker will not catch — the properties that would rot SILENTLY,
 * because nothing crashes when they break and the screen still renders something:
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
 *                 Production user a substitute lens.
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
  PRICE_LENS_RAMP_STOPS,
  priceBandLabel,
  removeEdgeOffset,
  serializePriceLensSettings,
} from '../app/(app)/inventory/blocking/lens/price-lens-settings';
import { resolveLensCellClass } from '../app/(app)/inventory/blocking/lens/types';

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
const FRAME = `${LENS_DIR}/lens-panel.tsx`;
const REGISTRY = `${LENS_DIR}/registry.ts`;
const SETTINGS = `${LENS_DIR}/price-lens-settings.ts`;
const STORE = `${LENS_DIR}/use-lens-settings.ts`;
const TYPES = `${LENS_DIR}/types.ts`;
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
  for (const rel of [PANEL, SETTINGS, FRAME, TYPES, STORE, REGISTRY]) {
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

  check('R is SQL\'s: no Math.floor / Math.ceil anywhere in the lens files', () => {
    for (const rel of [PANEL, SETTINGS, FRAME, TYPES, STORE, REGISTRY]) {
      const body = code(rel);
      assert.ok(!/Math\.(floor|ceil)\s*\(/.test(body), `${rel} rounds a price itself — R = floor(market)+1 lives in SQL`);
    }
    assert.ok(code(PANEL).includes('roundedUpPhp'), 'the panel does not echo the R the server returned');
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

  check('the Price lens itself gates on `caps.canViewPrices`', () => {
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

  check('a lens the reader may not be offered is CLOSED, not substituted', () => {
    assert.ok(
      /if\s*\(lensId\s*&&\s*!activeLens\)/.test(grid),
      'nothing closes a lens that stopped resolving (flip Prices off → tints would stay)',
    );
    const reg = code(REGISTRY);
    assert.ok(
      /return found\.canShow\(caps\)\s*\?\s*found\s*:\s*null;/.test(reg),
      'resolveLens does not refuse a lens this reader may not see',
    );
    assert.ok(
      !/BLOCKING_LENSES\[0\]/.test(reg),
      'resolveLens falls back to the first lens — a Production user on ?lens=price would get a substitute',
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

  check('opening a lens resets the status filter AND clears the supplier', () => {
    const at = grid.indexOf('const openLens');
    assert.ok(at > 0, 'openLens is gone');
    const body = grid.slice(at, at + 400);
    assert.ok(body.includes("setStatusFilter('ALL')"), 'openLens does not reset the status spotlight');
    assert.ok(body.includes('onSupplierFilterChange?.(null)'), 'openLens does not clear the supplier spotlight');
  });

  check('a status/lab chip closes the lens', () => {
    const at = grid.indexOf('const handleToggleStatus');
    const body = grid.slice(at, at + 400);
    assert.ok(body.includes('closeLens()'), 'clicking a status chip leaves the lens painting the grid');
  });

  check('choosing a supplier closes the lens', () => {
    const at = grid.indexOf('const handleSupplierSelect');
    const body = grid.slice(at, at + 400);
    assert.ok(body.includes('closeLens()'), 'picking a supplier leaves the lens painting the grid');
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
console.log('\n7. THE FRAME — registry shape, Escape, and the classifier seam');
// ===========================================================================

{
  check('the registry is a list of definitions with the five required fields', () => {
    const reg = code(REGISTRY);
    assert.ok(/export const BLOCKING_LENSES:\s*readonly BlockingLensDefinition\[\]/.test(reg),
      'BLOCKING_LENSES is gone or lost its type');
    assert.ok(reg.includes('export function visibleLenses'), 'visibleLenses is gone');
    assert.ok(reg.includes('export function resolveLens'), 'resolveLens is gone');
    const t = code(TYPES);
    for (const field of ['id:', 'label:', 'icon:', 'canShow:', 'Panel:']) {
      assert.ok(t.includes(field), `BlockingLensDefinition lost \`${field}\``);
    }
  });

  check('the one registered lens today is Price, and its id is the `?lens=` value', () => {
    assert.equal(PRICE_LENS_ID, 'price');
    assert.ok(code(REGISTRY).includes('[PRICE_LENS]'), 'the registry no longer holds exactly the price lens');
  });

  check('a lens definition carries a hook-free COMPONENT, so switching mounts/unmounts', () => {
    const t = code(TYPES);
    assert.ok(t.includes('Panel: ComponentType<BlockingLensPanelProps>'), 'Panel is not a component type');
    assert.ok(!/useController|useLens\b/.test(t), 'a hook on the definition would break the rules of hooks on a lens switch');
    assert.ok(code(FRAME).includes('key={active.id}'), 'the frame does not key the body by lens id');
  });

  check('no dead tab strip: it renders only once there is more than one lens', () => {
    assert.ok(/\{lenses\.length > 1 && \(/.test(code(FRAME)), 'the tab strip is not gated on a real choice');
    assert.ok(!/disabled.*Supplier|Age.*disabled/.test(code(FRAME)), 'a disabled placeholder tab appeared');
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
  check('errors go through `errorToast()` — never a raw sonner toast.error', () => {
    for (const rel of [PANEL, FRAME, STORE, REGISTRY, SETTINGS]) {
      const body = code(rel);
      assert.ok(!/toast\.error\s*\(/.test(body), `${rel} calls sonner's toast.error directly`);
    }
    assert.ok(code(PANEL).includes('errorToast('), 'the panel never reaches for errorToast');
  });

  check('an inline refusal carries a Copy button (the error rule, as a banner)', () => {
    const body = code(PANEL);
    assert.ok(body.includes('function RefusalBanner'), 'the inline refusal banner is gone');
    assert.ok(body.includes('navigator.clipboard.writeText'), 'the banner cannot be copied');
  });

  check('a stale reply cannot overwrite a fresh one (the request token)', () => {
    const body = code(PANEL);
    assert.ok(body.includes('tokenRef'), 'the race guard is gone');
    assert.ok(/if \(tokenRef\.current !== token\) return;/.test(body), 'a late reply is no longer discarded');
    assert.ok(body.includes('LENS_DEBOUNCE_MS'), 'the debounce constant is gone');
    assert.ok(/const LENS_DEBOUNCE_MS = 250;/.test(body), 'the debounce is not ~250ms');
  });

  check('a refusal keeps the previous tint — the grid never flashes back to plain', () => {
    const body = code(PANEL);
    const at = body.indexOf('setLensRefusal(res.message)');
    assert.ok(at > 0, 'the refusal is not recorded');
    const around = body.slice(Math.max(0, at - 400), at + 200);
    assert.ok(!around.includes('setLens(null)'), 'a refusal blanks the lens the reader is looking at');
  });

  check('CONTEXT.md documents the lens UI and how to register a second one', () => {
    const doc = read(CONTEXT);
    for (const phrase of [
      'Price lens — UI',
      'lens/registry.ts',
      'lens/types.ts',
      'lens/lens-panel.tsx',
      'lens/price-lens-panel.tsx',
      'lens/price-lens-settings.ts',
      'lens/use-lens-settings.ts',
      '`?lens=',
      'blocking_lens_',
      '.lens-band-',
      'REGISTERING A SECOND LENS',
    ]) {
      assert.ok(doc.includes(phrase), `CONTEXT.md does not mention "${phrase}"`);
    }
  });
}

console.log(`\n${passed} assertions passed.`);
