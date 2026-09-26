/**
 * verify-blend-market-screen.ts — the proofs behind the ON-SCREEN market chart in the blend
 * proposal dialog (2026-09-26), the screen twin of page one's printed chart.
 *
 * Run:
 *   npx tsx scripts/verify-blend-market-screen.ts                 # static + pure + browser
 *   npx tsx scripts/verify-blend-market-screen.ts --static-only   # no browser
 *   BLEND_MARKET_BASE_URL=http://localhost:3297 npx tsx scripts/verify-blend-market-screen.ts
 *   BLEND_MARKET_SHOTS=.scratch …                                 # also write light/dark PNGs there
 *
 * The browser half drives `/dev/table-playground/blendanalysis?market=…`, which mounts the
 * REAL `BlendProposalDialog` with an in-memory `marketAdapter` (~300 ms latency). It opens
 * no database connection and holds no key.
 *
 * ============================================================================
 * WHAT IS PROVEN
 * ============================================================================
 *   ONE MODEL      the dialog hands the screen the SAME `marketSlot.model` it prints; the
 *                  screen file fetches nothing, folds nothing and re-scales nothing — it
 *                  calls `layoutBlendMarketChart` like the print and the PDF do.
 *   PRINT INTACT   the printed SVG string carries no screen-only attribute (`role` on a
 *                  text item never reaches it); `verify-blend-market-chart.ts` re-proves
 *                  the printed page itself.
 *   THE GATE       a price viewer sees four series and two axes; a price-denied reader two
 *                  volume areas, one axis, and no ₱ in the legend, the axes or the tooltip.
 *   TOOLTIP        the hovered month shows all four values (₱/kg 2 dp, tonnes, "partial")
 *                  and "no data" on a gap — never 0.
 *   STATES         loading keeps the section's exact height; an error is an inline banner
 *                  with Copy and Retry, and Retry recovers (`?market=flaky`).
 *   THEME          dark mode inks every label with a theme token — no literal black/white,
 *                  no hex colour attribute anywhere in the on-screen SVG.
 *   PHONE          at 375 px there is no horizontal page scroll and the months thin out.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  blendMarketChartSvg,
  blendMarketSlotAt,
  blendMarketTooltip,
  buildBlendMarketChartModel,
  layoutBlendMarketChart,
} from '../app/(app)/inventory/_shared/blend-market-chart';
import type { BlendMarketHistory, BlendMarketHistoryMonth } from '../app/(app)/inventory/blocking/types';

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const SCREEN = 'app/(app)/inventory/_shared/blend-market-chart-screen.tsx';
const DIALOG = 'app/(app)/inventory/_shared/blend-proposal-dialog.tsx';
const CONTEXT = 'app/(app)/inventory/blocking/CONTEXT.md';

const SHOTS = process.env.BLEND_MARKET_SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** Strip comments so a rule stated in prose can never satisfy (or trip) a code check. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─── Synthetic history (the rig's own literals) ──────────────────────────────

const ROWS: [string, number, number, number, number][] = [
  ['2025-10-01', 678_216, 42.5046, 1_655_667, 44.9159],
  ['2025-11-01', 419_767, 40.0385, 1_270_296, 44.9494],
  ['2025-12-01', 869_431, 41.2279, 1_191_762, 46.3588],
  ['2026-01-01', 829_328, 46.1226, 1_468_251, 47.5292],
  ['2026-02-01', 708_538, 48.5778, 1_864_142, 48.2562],
  ['2026-03-01', 1_112_078, 46.6957, 1_788_874, 47.5085],
  ['2026-04-01', 643_922, 45.7934, 598_205, 46.8374],
  ['2026-05-01', 805_634, 45.0054, 1_034_120, 44.9633],
  ['2026-06-01', 848_458, 43.3282, 762_000, 38.2524],
  ['2026-07-01', 762_271, 45.3704, 901_504, 37.8765],
  ['2026-08-01', 709_627, 42.7427, 824_027, 39.9698],
  ['2026-09-01', 730_306, 43.0874, 891_700, 39.8391],
];

function history(opts: { prices: boolean; gaps?: boolean }): BlendMarketHistory {
  const months: BlendMarketHistoryMonth[] = ROWS.map(([m, fedKg, fedPhp, mktKg, mktPhp]) => {
    const gapDelivery = !!opts.gaps && m === '2026-04-01';
    const gapFedPrice = !!opts.gaps && m === '2025-12-01';
    return {
      monthStart: m,
      isPartialMonth: m === '2026-09-01',
      measuredTo: m === '2026-09-01' ? '2026-09-26' : null,
      fedKg,
      fedPhpKg: opts.prices && !gapFedPrice ? fedPhp : null,
      fedPriceCoveragePct: 100,
      deliveredKg: gapDelivery ? null : mktKg,
      deliveredPhpKg: opts.prices && !gapDelivery ? mktPhp : null,
      deliveredPriceCoveragePct: gapDelivery ? null : 100,
    };
  });
  return { fromMonth: '2025-10-01', toMonth: '2026-09-01', anchorDate: '2026-09-26', months, canViewPrices: opts.prices };
}

// ─── Static ──────────────────────────────────────────────────────────────────

async function staticChecks() {
  const screen = code(read(SCREEN));
  const dialog = code(read(DIALOG));
  const ctx = read(CONTEXT);

  console.log('\n1. ONE MODEL, ONE GEOMETRY — the screen is a thin renderer');

  await check('the screen file fetches nothing and computes no statistic', () => {
    assert.ok(!/from '\.\.\/blocking\/actions'|fetchBlendMarketHistory|supabase/i.test(screen), 'the screen reads data');
    assert.ok(!/\.reduce\(/.test(screen), 'the screen folds numbers');
    assert.ok(!/\/\s*1000\b/.test(screen), 'the screen re-does the kg → tonne change');
    assert.ok(!/\b(?:sum|avg|mean|average|weighted)\w*\s*(?:=[^=>]|\()/i.test(screen), 'the screen computes a sum or an average');
    assert.ok(/layoutBlendMarketChart\(/.test(screen), 'the screen does not use the shared geometry');
    assert.ok(/blendMarketTooltip\(/.test(screen) && /blendMarketSlotAt\(/.test(screen));
  });

  await check('the dialog hands the screen THE SAME model it prints, from the ONE read', () => {
    assert.ok(/<BlendMarketChartScreen[\s\S]*?model=\{marketSlot\?\.kind === 'chart' \? marketSlot\.model : null\}/.test(dialog));
    assert.equal((dialog.match(/fetchBlendMarketHistory\)\(/g) ?? []).length, 1, 'the market is fetched more than once');
    assert.ok(/buildBlendMarketSlotHtml\(\s*marketSlot/.test(dialog), 'the print no longer draws marketSlot');
    assert.ok(/onRetry=\{retryMarket\}/.test(dialog) && /marketLoadKey/.test(dialog), 'Retry does not re-run the read');
  });

  await check('the screen inks by theme token: no hex colour, no literal black/white', () => {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(screen), 'a hex colour in the screen renderer');
    assert.ok(!/\b(?:text|fill|stroke|bg)-(?:black|white)\b/.test(screen), 'a literal black/white class');
    assert.ok(!/BLEND_MARKET_INK/.test(screen), "the screen borrows the print's ink");
    assert.ok(/dark:stroke-blue-400/.test(screen) && /dark:stroke-orange-400/.test(screen));
  });

  await check('the plot box height class matches the exported constant', () => {
    const src = read(SCREEN);
    const px = Number(/BLEND_MARKET_SCREEN_PLOT_PX = (\d+)/.exec(src)?.[1]);
    assert.ok(src.includes(`h-[${px}px]`), `the plot box is not h-[${px}px]`);
    const tw = Number(/TOOLTIP_W = (\d+)/.exec(src)?.[1]);
    assert.ok(src.includes(`w-[${tw}px]`), `the tooltip is not w-[${tw}px]`);
  });

  await check('CONTEXT.md documents the on-screen chart and this script', () => {
    assert.ok(/blend-market-chart-screen/.test(ctx) && /verify-blend-market-screen/.test(ctx));
  });
}

// ─── Pure ────────────────────────────────────────────────────────────────────

async function pureChecks() {
  console.log('\n2. THE SHARED HELPERS — pure');

  await check('the tooltip names all four values for a price viewer, formatted, lines first', () => {
    const m = buildBlendMarketChartModel({ history: history({ prices: true }), showPrices: true, blendRawPhpKg: 43 });
    const t = blendMarketTooltip(m, 11);
    assert.equal(t.month, 'Sep 2026');
    assert.equal(t.partial, true);
    assert.deepEqual(
      t.rows.map((r) => [r.id, r.text]),
      [
        ['fedPrice', '₱43.09/kg'],
        ['deliveredPrice', '₱39.84/kg'],
        ['fedVolume', '730.3 t'],
        ['deliveredVolume', '891.7 t'],
      ],
    );
    assert.equal(blendMarketTooltip(m, 0).partial, false);
  });

  await check('a gap reads "no data" (null), never 0', () => {
    const m = buildBlendMarketChartModel({ history: history({ prices: true, gaps: true }), showPrices: true });
    const apr = blendMarketTooltip(m, 6);
    assert.equal(apr.rows.find((r) => r.id === 'deliveredVolume')?.text, null);
    assert.equal(apr.rows.find((r) => r.id === 'deliveredPrice')?.text, null);
    assert.equal(apr.rows.find((r) => r.id === 'fedVolume')?.text, '643.9 t');
    assert.equal(blendMarketTooltip(m, 2).rows.find((r) => r.id === 'fedPrice')?.text, null);
  });

  await check('a price-denied tooltip has only the two volumes and no ₱', () => {
    const m = buildBlendMarketChartModel({ history: history({ prices: false }), showPrices: true, blendRawPhpKg: 43 });
    const t = blendMarketTooltip(m, 5);
    assert.deepEqual(t.rows.map((r) => r.id), ['fedVolume', 'deliveredVolume']);
    assert.ok(!JSON.stringify(t).includes('₱'));
  });

  await check('the hit-test maps an x to its month slot and refuses outside the plot', () => {
    const m = buildBlendMarketChartModel({ history: history({ prices: true }), showPrices: true });
    const L = layoutBlendMarketChart(m, 800, 220, 10, 0.62);
    for (const [i, x] of L.slotX.entries()) assert.equal(blendMarketSlotAt(L, x), i);
    assert.equal(blendMarketSlotAt(L, L.plot.x - 1), null);
    assert.equal(blendMarketSlotAt(L, L.plot.x + L.plot.w + 1), null);
    assert.equal(blendMarketSlotAt(L, L.plot.x + L.plot.w), 11);
  });

  await check('every label carries a role; the printed SVG carries none of it', () => {
    const m = buildBlendMarketChartModel({ history: history({ prices: true }), showPrices: true, blendRawPhpKg: 43 });
    const L = layoutBlendMarketChart(m, 1047, 320, 10);
    assert.ok(L.texts.every((t) => typeof t.role === 'string'));
    assert.ok(L.texts.filter((t) => t.role === 'month').every((t, i) => t.slot === i));
    const svg = blendMarketChartSvg(L, m.ariaLabel);
    assert.equal((svg.match(/\brole="/g) ?? []).length, 1, 'a screen-only role reached the print');
    assert.ok(svg.includes('role="img"') && !/data-role|\bslot=/.test(svg));
  });
}

// ─── Browser ─────────────────────────────────────────────────────────────────

async function browserChecks(base: string) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();

  async function open(
    query: string,
    state: 'ready' | 'loading' | 'error',
    opts: { width?: number; scheme?: 'light' | 'dark' } = {},
  ) {
    const ctx = await browser.newContext({
      viewport: { width: opts.width ?? 1400, height: 1000 },
      colorScheme: opts.scheme ?? 'light',
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/dev/table-playground/blendanalysis${query}`, { waitUntil: 'networkidle' });
    await page.waitForSelector(`[data-blend-market-screen][data-state="${state}"]`, { timeout: 10_000 });
    if (state === 'ready') await page.waitForSelector('[data-blend-market-svg]', { timeout: 5_000 });
    return { ctx, page };
  }

  const seriesCounts = (page: import('playwright').Page) =>
    page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const el of Array.from(document.querySelectorAll('[data-blend-market-svg] [data-series]'))) {
        const k = `${el.tagName.toLowerCase()}:${el.getAttribute('data-series')}`;
        out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    });

  async function hover(page: import('playwright').Page, slot: number) {
    const x = await page.evaluate((i) => {
      const hit = document.querySelector('[data-blend-market-hit]') as SVGRectElement;
      const r = hit.getBoundingClientRect();
      return { x: r.left + (r.width / 12) * (i + 0.5), y: r.top + r.height / 2 };
    }, slot);
    await page.mouse.move(x.x, x.y);
    await page.waitForSelector(`[data-blend-market-tooltip][data-slot="${slot}"]`, { timeout: 2_000 });
    return page.evaluate(() => {
      const tip = document.querySelector('[data-blend-market-tooltip]') as HTMLElement;
      return {
        month: tip.querySelector('[data-tip-month]')?.textContent ?? '',
        partial: !!tip.querySelector('[data-tip-partial]'),
        rows: Object.fromEntries(
          Array.from(tip.querySelectorAll('[data-tip-row]')).map((r) => [
            r.getAttribute('data-tip-row'),
            r.querySelector('[data-tip-value]')?.textContent ?? '',
          ]),
        ),
        text: tip.innerText,
      };
    });
  }

  try {
    console.log(`\n3. IN THE BROWSER — ${base}`);

    await check('price viewer: the chart sits in the dialog between Pricing and Selected Blocks, four series', async () => {
      const { ctx, page } = await open('?saved=1&pages=', 'ready');
      const order = await page.evaluate(() => {
        const body = (document.querySelector('[role="dialog"]') as HTMLElement).innerText;
        return {
          pricing: body.indexOf('PRICING'),
          lab: body.indexOf('BLENDED LAB STATS'),
          chart: body.indexOf('RC MARKET'),
          blocks: body.indexOf('SELECTED BLOCKS'),
        };
      });
      assert.ok(order.lab >= 0 && order.pricing > order.lab && order.chart > order.pricing, JSON.stringify(order));
      assert.ok(order.blocks > order.chart, 'the chart is not above the blocks table');
      assert.ok(await page.locator('[data-blend-market-svg]').isVisible());
      assert.equal(await page.getAttribute('[data-blend-market-screen]', 'data-prices'), '1');
      const s = await seriesCounts(page);
      for (const k of ['polygon:fedVolume', 'polygon:deliveredVolume', 'polyline:fedPrice', 'polyline:deliveredPrice', 'line:ref']) {
        assert.ok((s[k] ?? 0) >= 1, `${k} not drawn`);
      }
      assert.equal(await page.locator('[data-market-legend]').count(), 5);
      const units = await page.locator('[data-blend-market-svg] text[data-role$="Unit"]').allTextContents();
      assert.deepEqual(units.sort(), ['t / month', '₱/kg'].sort());
      assert.equal(await page.locator('[data-blend-market-svg] [data-partial="1"]').count(), 2);
      await ctx.close();
    });

    await check('the tooltip shows all four values for a hovered month (Sep 2026, partial)', async () => {
      const { ctx, page } = await open('?saved=1&pages=', 'ready');
      const t = await hover(page, 11);
      assert.equal(t.month, 'Sep 2026');
      assert.ok(t.partial, 'the partial month is not flagged');
      assert.deepEqual(t.rows, {
        fedPrice: '₱43.09/kg',
        deliveredPrice: '₱39.84/kg',
        fedVolume: '730.3 t',
        deliveredVolume: '891.7 t',
      });
      const t0 = await hover(page, 0);
      assert.equal(t0.month, 'Oct 2025');
      assert.ok(!t0.partial);
      assert.equal(t0.rows.fedPrice, '₱42.50/kg');
      await ctx.close();
    });

    await check('a gap month reads "no data" in the tooltip and breaks the series', async () => {
      const { ctx, page } = await open('?saved=1&pages=&market=gaps', 'ready');
      const t = await hover(page, 6);
      assert.equal(t.month, 'Apr 2026');
      assert.equal(t.rows.deliveredVolume, 'no data');
      assert.equal(t.rows.deliveredPrice, 'no data');
      assert.equal(t.rows.fedVolume, '643.9 t');
      assert.ok(!/\b0(?:\.0)? t\b|₱0\.00/.test(t.text), 'a gap was printed as zero');
      const s = await seriesCounts(page);
      assert.equal(s['polygon:deliveredVolume'], 2, 'the April gap was bridged');
      assert.equal(s['polyline:fedPrice'], 2, 'the December fed-price gap was bridged');
      assert.ok((await page.locator('[data-blend-market-footnote]').allTextContents()).some((f) => /never a zero/.test(f)));
      await ctx.close();
    });

    await check('price-DENIED reader: two volume areas, ONE axis, no ₱ in legend, axes or tooltip', async () => {
      const { ctx, page } = await open('?saved=1&pages=&prices=0', 'ready');
      assert.equal(await page.getAttribute('[data-blend-market-screen]', 'data-prices'), '0');
      const s = await seriesCounts(page);
      assert.ok((s['polygon:fedVolume'] ?? 0) >= 1 && (s['polygon:deliveredVolume'] ?? 0) >= 1);
      assert.equal((s['polyline:fedPrice'] ?? 0) + (s['polyline:deliveredPrice'] ?? 0) + (s['line:ref'] ?? 0), 0);
      assert.deepEqual(
        await page.locator('[data-market-legend]').evaluateAll((els) => els.map((e) => e.getAttribute('data-market-legend'))),
        ['fedVolume', 'deliveredVolume'],
      );
      assert.equal(await page.locator('[data-blend-market-svg] text[data-role="rightUnit"]').count(), 0);
      const t = await hover(page, 4);
      assert.deepEqual(Object.keys(t.rows), ['fedVolume', 'deliveredVolume']);
      const sectionText = await page.locator('[data-blend-market-screen]').innerText();
      assert.ok(!sectionText.includes('₱'), 'a ₱ reached a price-denied chart');
      await ctx.close();
    });

    await check('the legend toggles a series off and back on', async () => {
      const { ctx, page } = await open('?saved=1&pages=', 'ready');
      const btn = page.locator('[data-market-legend="fedPrice"]');
      await btn.click();
      assert.equal(await btn.getAttribute('aria-pressed'), 'false');
      assert.equal((await seriesCounts(page))['polyline:fedPrice'] ?? 0, 0);
      await btn.click();
      assert.equal(await btn.getAttribute('aria-pressed'), 'true');
      assert.ok(((await seriesCounts(page))['polyline:fedPrice'] ?? 0) >= 1);
      await ctx.close();
    });

    await check('loading keeps the SAME section height as the loaded chart (no layout jump)', async () => {
      const { ctx: c1, page: ready } = await open('?saved=1&pages=', 'ready');
      const hReady = await ready.locator('[data-blend-market-screen]').evaluate((e) => e.getBoundingClientRect().height);
      const plotReady = await ready.locator('[data-blend-market-plot]').evaluate((e) => e.getBoundingClientRect().height);
      await c1.close();
      const { ctx: c2, page: loading } = await open('?saved=1&pages=&market=stall', 'loading');
      assert.ok(await loading.locator('[data-blend-market-skeleton]').isVisible(), 'no skeleton while loading');
      const hLoading = await loading.locator('[data-blend-market-screen]').evaluate((e) => e.getBoundingClientRect().height);
      const plotLoading = await loading.locator('[data-blend-market-plot]').evaluate((e) => e.getBoundingClientRect().height);
      await c2.close();
      assert.ok(Math.abs(plotReady - plotLoading) < 0.5, `plot ${plotLoading} vs ${plotReady}`);
      assert.ok(Math.abs(hReady - hLoading) < 1, `section ${hLoading}px loading vs ${hReady}px ready`);
    });

    for (const mode of ['fail', 'throw'] as const) {
      await check(`a ${mode === 'fail' ? 'refused' : 'thrown'} read is an inline banner with Copy and Retry; the dialog carries on`, async () => {
        const { ctx, page } = await open(`?saved=1&pages=&market=${mode}`, 'error');
        const sec = page.locator('[data-blend-market-screen]');
        assert.ok((await sec.innerText()).includes('fixture:'), 'the reason is not shown');
        assert.ok(await sec.getByRole('button', { name: 'Copy' }).isVisible());
        assert.ok(await sec.getByRole('button', { name: 'Retry' }).isVisible());
        assert.ok(await page.getByText('Selected Blocks', { exact: true }).isVisible(), 'the blocks table is gone');
        // Retry re-runs the read (it goes back to loading, then — this fixture keeps failing — error).
        await sec.getByRole('button', { name: 'Retry' }).click();
        await page.waitForSelector('[data-blend-market-screen][data-state="loading"]', { timeout: 2_000 });
        await page.waitForSelector('[data-blend-market-screen][data-state="error"]', { timeout: 5_000 });
        await ctx.close();
      });
    }

    await check('Retry recovers: a refused first read, then the chart (`?market=flaky`)', async () => {
      const { ctx, page } = await open('?saved=1&pages=&market=flaky', 'error');
      await page.waitForTimeout(700); // past the rig's "first read" window
      await page.locator('[data-blend-market-screen]').getByRole('button', { name: 'Retry' }).click();
      await page.waitForSelector('[data-blend-market-screen][data-state="ready"] [data-blend-market-svg]', { timeout: 5_000 });
      await ctx.close();
    });

    await check('dark mode: every label is a theme token — none literal black/white, differs from light', async () => {
      const inks = async (scheme: 'light' | 'dark') => {
        const { ctx, page } = await open('?saved=1&pages=', 'ready', { scheme });
        if (SHOTS) {
          await hover(page, 11);
          await page.locator('[role="dialog"]').screenshot({ path: resolve(SHOTS, `blend-market-screen-${scheme}.png`) });
        }
        const r = await page.evaluate(() => {
          // (No named helper in here: tsx would wrap it in `__name`, which the page lacks.)
          const tokens: string[] = [];
          for (const cls of ['text-foreground', 'text-muted-foreground']) {
            const el = document.createElement('span');
            el.className = cls;
            document.body.appendChild(el);
            tokens.push(getComputedStyle(el).color);
            el.remove();
          }
          const texts = Array.from(document.querySelectorAll('[data-blend-market-svg] text')).map(
            (t) => getComputedStyle(t).fill,
          );
          const hexAttr = Array.from(document.querySelectorAll('[data-blend-market-svg] *')).filter((el) =>
            ['fill', 'stroke'].some((a) => /^#/.test(el.getAttribute(a) ?? '')),
          ).length;
          const dark = document.documentElement.classList.contains('dark');
          return { tokens, texts, hexAttr, dark };
        });
        await ctx.close();
        return r;
      };
      const light = await inks('light');
      const dark = await inks('dark');
      assert.ok(dark.dark && !light.dark, 'the theme did not switch');
      for (const r of [light, dark]) {
        assert.equal(r.hexAttr, 0, 'a hex colour attribute in the on-screen SVG');
        assert.ok(r.texts.length > 20);
        for (const f of r.texts) {
          assert.ok(r.tokens.includes(f), `a label inked ${f}, not a theme token (${r.tokens.join(' | ')})`);
          assert.ok(!/^rgb\((0, 0, 0|255, 255, 255)\)$/.test(f), `a label is literal ${f}`);
        }
      }
      assert.notDeepEqual(light.tokens, dark.tokens, 'the tokens did not change with the theme');
    });

    await check('375 px: no horizontal page scroll, the chart fits, the months thin out to the newest', async () => {
      const { ctx, page } = await open('?saved=1&pages=', 'ready', { width: 375 });
      const m = await page.evaluate(() => {
        const svg = document.querySelector('[data-blend-market-svg]') as SVGSVGElement;
        const box = document.querySelector('[data-blend-market-plot]') as HTMLElement;
        const months = Array.from(svg.querySelectorAll('text[data-role="month"]')).map((t) => t.textContent);
        return {
          docW: document.documentElement.scrollWidth,
          winW: window.innerWidth,
          svgW: svg.getBoundingClientRect().width,
          boxW: box.getBoundingClientRect().width,
          months,
        };
      });
      assert.ok(m.docW <= m.winW, `the page scrolls sideways: ${m.docW} > ${m.winW}`);
      assert.ok(m.svgW <= m.boxW + 0.5, `the chart overflows its box: ${m.svgW} > ${m.boxW}`);
      assert.ok(m.months.length < 12 && m.months.length >= 3, `${m.months.length} month labels at 375 px`);
      assert.equal(m.months[m.months.length - 1], "Sep '26", 'the newest month is not labelled');
      const t = await hover(page, 11);
      assert.equal(t.month, 'Sep 2026');
      const tip = await page.locator('[data-blend-market-tooltip]').evaluate((e) => e.getBoundingClientRect());
      assert.ok(tip.left >= 0 && tip.right <= m.winW, 'the tooltip leaves the screen');
      await ctx.close();
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  await staticChecks();
  await pureChecks();
  if (process.argv.includes('--static-only')) {
    console.log(`\n${passed} assertions passed (browser half skipped by flag).`);
    return;
  }
  const base = process.env.BLEND_MARKET_BASE_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${base}/dev/table-playground/blendanalysis`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(
      `\nThe browser half needs a dev server serving ${base}/dev/table-playground/blendanalysis ` +
        `(${err instanceof Error ? err.message : String(err)}). Start one with ` +
        '`env -u ANTHROPIC_API_KEY npm run dev`, set BLEND_MARKET_BASE_URL, or pass --static-only.',
    );
    process.exit(1);
  }
  await browserChecks(base);
  console.log(`\n${passed} assertions passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
