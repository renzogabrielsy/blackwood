/**
 * verify-blend-market-chart.ts — the proofs behind PAGE ONE'S MARKET CHART on the blend
 * proposal printout / PDF (2026-09-26).
 *
 * Run:
 *   npx tsx scripts/verify-blend-market-chart.ts                 # static + pure + browser
 *   npx tsx scripts/verify-blend-market-chart.ts --static-only   # no browser
 *   BLEND_MARKET_BASE_URL=http://localhost:3291 npx tsx scripts/verify-blend-market-chart.ts
 *   BLEND_MARKET_DUMP=/some/dir …                                # also write the PDFs + PNGs there
 *
 * The browser half drives `/dev/table-playground/blendanalysis?market=…`, which mounts the
 * REAL `BlendProposalDialog` with an in-memory `marketAdapter` (~300 ms latency; `gaps`,
 * `fail`, `throw` and `stall` modes). It clicks the REAL Print button, captures the HTML
 * document the dialog hands to the hidden print iframe (window.print is stubbed — headless
 * Chromium fires `afterprint` on a no-op print and the iframe would be torn down under us),
 * then lays that document out as print media at A4 landscape and MEASURES page one.
 * It opens no database connection and holds no key.
 *
 * ============================================================================
 * WHAT IS PROVEN
 * ============================================================================
 *   ONE DEFINITION  the action reads `view_analytics_cost_monthly.delivered_php_kg_fed_covered`
 *                   (the DELIVERED basis — never the shrinkage-adjusted actual price) and
 *                   `view_analytics_rcin_monthly.market_avg_price`; no average is formed
 *                   in TypeScript and the chart file folds nothing.
 *   THE GATE        both ₱ series are nulled SERVER-side; a price-denied reader gets the
 *                   two volume areas, ONE axis, and no ₱ anywhere in the chart.
 *   NULL ≠ 0        a month with no figure breaks the line / area — never drawn at zero.
 *   PARTIAL         the current month is marked (hollow point + "partial" tick label).
 *   ONE PAGE        page one (head + chart) is exactly one A4-landscape page, measured.
 *   DEGRADES        a refused / thrown / unfinished read prints a note in the chart's place.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BLEND_MARKET_CHART_TITLE,
  BLEND_MARKET_LOADING_REASON,
  BLEND_MARKET_SVG_WIDTH_PX,
  BLEND_MARKET_UNAVAILABLE_HEADLINE,
  blendMarketChartSvg,
  blendMarketPlotHeightPx,
  blendRemarkLineCount,
  buildBlendMarketChartModel,
  buildBlendMarketSlotHtml,
  layoutBlendMarketChart,
} from '../app/(app)/inventory/_shared/blend-market-chart';
import { buildBlendPdf } from '../app/(app)/inventory/_shared/blend-proposal-pdf';
import type { BlendProposal } from '../app/(app)/inventory/blocking/actions';
import type {
  BlendMarketHistory,
  BlendMarketHistoryMonth,
} from '../app/(app)/inventory/blocking/types';

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const CHART = 'app/(app)/inventory/_shared/blend-market-chart.ts';
const ACTIONS = 'app/(app)/inventory/blocking/actions.ts';
const DIALOG = 'app/(app)/inventory/_shared/blend-proposal-dialog.tsx';
const PDF = 'app/(app)/inventory/_shared/blend-proposal-pdf.ts';
const CONTEXT = 'app/(app)/inventory/blocking/CONTEXT.md';

const DUMP = process.env.BLEND_MARKET_DUMP ?? null;
if (DUMP) mkdirSync(DUMP, { recursive: true });

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

/** The body of `export async function <name>(` up to the next top-level `export`. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = src.indexOf('\nexport ', start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

// ─── Synthetic history (literals — the shape the action returns) ──────────────

function history(opts: { prices: boolean; gaps?: boolean }): BlendMarketHistory {
  const rows: [string, number, number, number, number][] = [
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
  const months: BlendMarketHistoryMonth[] = rows.map(([m, fedKg, fedPhp, mktKg, mktPhp]) => {
    const gapDelivery = !!opts.gaps && m === '2026-04-01';
    const gapFedPrice = !!opts.gaps && m === '2025-12-01';
    return {
      monthStart: m,
      isPartialMonth: m === '2026-09-01',
      measuredTo: m === '2026-09-01' ? '2026-09-26' : null,
      fedKg,
      fedPhpKg: opts.prices && !gapFedPrice ? fedPhp : null,
      fedPriceCoveragePct: gapFedPrice ? null : opts.gaps && m === '2026-08-01' ? 97.3 : 100,
      deliveredKg: gapDelivery ? null : mktKg,
      deliveredPhpKg: opts.prices && !gapDelivery ? mktPhp : null,
      deliveredPriceCoveragePct: gapDelivery ? null : 100,
    };
  });
  return {
    fromMonth: '2025-10-01',
    toMonth: '2026-09-01',
    anchorDate: '2026-09-26',
    months,
    canViewPrices: opts.prices,
  };
}

function proposal(prices: boolean, blockCount = 24): BlendProposal {
  const blocks = Array.from({ length: blockCount }, (_, i) => ({
    block_loc: `A-${i + 1}A`,
    batch_code: `SEPT-26-BLK${i + 1}`,
    batch_id: `b${i}`,
    status: 'STORED',
    balance: 50_000,
    mc: 11,
    ash: 3,
    bd_astm: 0.4,
    bd_jis: 0.42,
    grit: 1.2,
    vm: 18,
    fc: 78,
    php_kg: prices ? 43 : null,
  }));
  return {
    blocks,
    block_count: blocks.length,
    total_balance: 50_000 * blocks.length,
    weighted: { mc: 11, ash: 3, bd_astm: 0.4, bd_jis: 0.42, grit: 1.2, vm: 18, fc: 78 },
    raw_price_per_kg: prices ? 43 : null,
    production_loss_pct: 30,
    product_cost_per_kg: prices ? 55.9 : null,
    can_view_prices: prices,
  } as BlendProposal;
}

// ─── Static ──────────────────────────────────────────────────────────────────

async function staticChecks() {
  const chart = code(read(CHART));
  const actions = read(ACTIONS);
  const dialog = code(read(DIALOG));
  const pdf = code(read(PDF));
  const ctx = read(CONTEXT);

  console.log('\n1. ONE DEFINITION — the action reads two existing views, verbatim');

  await check('fetchBlendMarketHistory reads the COVERED delivered-basis fed price and the market price', () => {
    const body = code(fnBody(actions, 'fetchBlendMarketHistory'));
    assert.ok(/from\('view_analytics_cost_monthly'\)/.test(body));
    assert.ok(/from\('view_analytics_rcin_monthly'\)/.test(body));
    assert.ok(/delivered_php_kg_fed_covered/.test(body), 'not the covered fed price');
    assert.ok(!/actual_fed_php_kg|closed_blocks_true_php_kg/.test(body), 'reads the shrinkage-adjusted ACTUAL price');
    assert.ok(/market_avg_price/.test(body) && /market_kg/.test(body) && /fed_kg/.test(body));
    assert.ok(!/\.reduce\(/.test(body), 'the action folds numbers');
  });

  await check('both ₱ series are nulled SERVER-side behind canViewPrices (fail-closed)', () => {
    const body = code(fnBody(actions, 'fetchBlendMarketHistory'));
    assert.ok(/fedPhpKg:\s*canView\s*&&/.test(body), 'fed ₱ not gated');
    assert.ok(/deliveredPhpKg:\s*canView\s*&&/.test(body), 'deliveries ₱ not gated');
    assert.ok(/let canView = false;[\s\S]*catch\s*\{\s*canView = false;/.test(body), 'the gate does not fail closed');
  });

  console.log('\n2. NO MATHS in the chart file');

  await check('no reduce / sum / average — only a unit change and axis geometry', () => {
    assert.ok(!/\.reduce\(/.test(chart), 'the chart file folds numbers with reduce');
    assert.ok(!/\b(?:sum|avg|mean|average|weighted)\w*\s*(?:=[^=>]|\()/i.test(chart), "the chart file computes a sum or an average");
    const divisions = chart.match(/\/\s*1000\b/g) ?? [];
    assert.equal(divisions.length, 1, 'more than the ONE kg → tonne unit change');
  });

  console.log('\n3. THE WIRING');

  await check('both documents draw the SAME slot; a failure becomes a note, never a missing page', () => {
    assert.ok(/buildBlendMarketSlotHtml\(/.test(dialog), 'the printout does not build the slot');
    assert.ok(/marketChartHtml,\s*\)/.test(dialog), 'the printout is not handed the chart');
    assert.ok(/marketSlot,\s*\)/.test(dialog), 'the PDF is not handed the slot');
    assert.ok(/status: 'error'/.test(dialog) && /kind: 'unavailable'/.test(dialog));
    assert.ok(/BLEND_MARKET_LOADING_REASON/.test(dialog), 'a Print that beats the reply has no note');
    assert.ok(/drawMarketChartPdf\(/.test(pdf) && /layoutBlendMarketChart\(/.test(pdf), 'the PDF re-derives the geometry');
  });

  await check('CONTEXT.md documents the chart, its action and this script', () => {
    assert.ok(/fetchBlendMarketHistory/.test(ctx) && /verify-blend-market-chart/.test(ctx));
  });
}

// ─── Pure ────────────────────────────────────────────────────────────────────

async function pureChecks() {
  console.log('\n4. THE MODEL — pure');

  await check('a price viewer gets two lines, two areas, TWO axes and the definitions', () => {
    const m = buildBlendMarketChartModel({ history: history({ prices: true }), showPrices: true, blendRawPhpKg: 43 });
    assert.deepEqual(m.lines.map((l) => l.id).sort(), ['deliveredPrice', 'fedPrice']);
    assert.deepEqual(m.areas.map((a) => a.id).sort(), ['deliveredVolume', 'fedVolume']);
    assert.ok(m.rightAxis !== null, 'no second axis');
    assert.equal(m.leftAxis.unit, '₱/kg');
    assert.equal(m.rightAxis?.unit, 't / month');
    assert.equal(m.leftAxis.ticks.length, m.rightAxis?.ticks.length, 'the two axes do not share guides');
    assert.equal(m.ticks[0], "Oct '25");
    assert.equal(m.ticks[11], "Sep '26");
    assert.ok(/not the shrinkage-adjusted actual price/.test(m.subtitle));
    // Blue fed-price line, orange deliveries line, purple fed area, green deliveries area.
    const byId = Object.fromEntries([...m.lines, ...m.areas].map((s) => [s.id, s]));
    assert.equal(byId.fedPrice.stroke, '#1d4ed8');
    assert.equal(byId.deliveredPrice.stroke, '#c2410c');
    assert.equal(byId.fedVolume.fill, '#a855f7');
    assert.equal(byId.deliveredVolume.fill, '#22c55e');
    // Tonnes are the view's kg ÷ 1000 — a unit change, not an aggregate.
    assert.equal(byId.fedVolume.values[0], 678.216);
  });

  await check('a price-DENIED reader: volume areas only, ONE axis, no ₱ anywhere', () => {
    for (const [h, show] of [
      [history({ prices: false }), true],
      [history({ prices: true }), false],
    ] as const) {
      const m = buildBlendMarketChartModel({ history: h, showPrices: show, blendRawPhpKg: 43 });
      assert.equal(m.lines.length, 0);
      assert.equal(m.rightAxis, null);
      assert.equal(m.refLine, null);
      assert.equal(m.leftAxis.unit, 't / month');
      const svg = blendMarketChartSvg(layoutBlendMarketChart(m, 1047, 300, 10), m.ariaLabel);
      const html = buildBlendMarketSlotHtml({ kind: 'chart', model: m }, 300);
      assert.ok(!svg.includes('₱') && !html.includes('₱'), 'a ₱ reached a price-denied chart');
      assert.ok(!/fedPrice|deliveredPrice/.test(svg));
    }
  });

  await check('NULL is a GAP: the area splits into two runs, the line breaks, nothing is drawn at 0', () => {
    const m = buildBlendMarketChartModel({ history: history({ prices: true, gaps: true }), showPrices: true });
    const L = layoutBlendMarketChart(m, 1047, 300, 10);
    const delivered = L.areas.find((a) => a.id === 'deliveredVolume');
    assert.equal(delivered?.polygons.length, 2, 'the April gap was bridged');
    const fedLine = L.lines.find((l) => l.id === 'fedPrice');
    assert.equal(fedLine?.runs.length, 2, 'the December fed-price gap was bridged');
    assert.equal(fedLine?.dots.length, 11);
    // No point sits ON the baseline except the area polygons' own closing corners.
    for (const ln of L.lines) for (const d of ln.dots) assert.ok(d.y < L.baselineY - 0.5, 'a line point at zero');
    assert.ok(m.footnotes.some((f) => /never a zero/.test(f)));
    assert.ok(m.footnotes.some((f) => /Aug 2026: 97\.3% of fed kg traceable to a delivery price/.test(f)));
  });

  await check('the partial month is marked: hollow point + "partial" tick + a footnote', () => {
    const m = buildBlendMarketChartModel({ history: history({ prices: true }), showPrices: true });
    const L = layoutBlendMarketChart(m, 1047, 300, 10);
    for (const ln of L.lines) {
      assert.equal(ln.dots.filter((d) => d.hollow).length, 1);
      assert.equal(ln.dots[ln.dots.length - 1].hollow, true, 'the hollow point is not September');
    }
    assert.ok(L.texts.some((t) => t.text === 'partial'));
    assert.ok(m.footnotes.some((f) => /Sep 2026 is the current month, measured to 2026-09-26/.test(f)));
    const svg = blendMarketChartSvg(L, m.ariaLabel);
    assert.equal((svg.match(/data-partial="1"/g) ?? []).length, 2);
  });

  await check('the remark estimate and the plot height are sane', () => {
    assert.equal(blendRemarkLineCount(''), 0);
    assert.equal(blendRemarkLineCount('one line'), 1);
    assert.equal(blendRemarkLineCount(`a\n${'x'.repeat(361)}`), 4);
    const base = blendMarketPlotHeightPx({ hasPricing: false, remarkText: '', footnoteCount: 1 });
    const priced = blendMarketPlotHeightPx({ hasPricing: true, remarkText: 'x', footnoteCount: 3 });
    assert.ok(priced < base && priced >= 170, `${priced} vs ${base}`);
  });

  console.log('\n5. THE jsPDF FILE — pure');

  const pagesOf = (doc: { getNumberOfPages(): number }) => doc.getNumberOfPages();
  await check('a chart puts the blocks table on sheet 2; no chart keeps the old layout', () => {
    const p = proposal(true, 4);
    const without = buildBlendPdf(p, true, new Date('2026-09-26T10:00:00+08:00'));
    const withChart = buildBlendPdf(p, true, new Date('2026-09-26T10:00:00+08:00'), null, null, null, null, {
      kind: 'chart',
      model: buildBlendMarketChartModel({ history: history({ prices: true }), showPrices: true, blendRawPhpKg: 43 }),
    });
    assert.equal(pagesOf(without), 1, 'a 4-block blend no longer fits one page without a chart');
    assert.equal(pagesOf(withChart), 2, 'the chart did not give page one to itself');
    if (DUMP) writeFileSync(resolve(DUMP, 'jspdf-price.pdf'), Buffer.from(withChart.output('arraybuffer')));
  });

  await check('a price-denied PDF and an UNAVAILABLE slot both build; the note says why', () => {
    const denied = buildBlendPdf(proposal(false, 24), true, new Date(), null, null, null, null, {
      kind: 'chart',
      model: buildBlendMarketChartModel({ history: history({ prices: false, gaps: true }), showPrices: true }),
    });
    const text = denied.output();
    assert.ok(!/PHP \d/.test(text), 'a PHP figure reached a price-denied PDF');
    if (DUMP) writeFileSync(resolve(DUMP, 'jspdf-denied.pdf'), Buffer.from(denied.output('arraybuffer')));
    const na = buildBlendPdf(proposal(true, 4), true, new Date(), null, null, null, null, {
      kind: 'unavailable',
      reason: BLEND_MARKET_LOADING_REASON,
    });
    assert.equal(pagesOf(na), 2);
    assert.ok(na.output().includes(BLEND_MARKET_UNAVAILABLE_HEADLINE));
  });
}

// ─── Browser ─────────────────────────────────────────────────────────────────

interface PageOneMetrics {
  hasP1: boolean;
  p1Height: number;
  p1ScrollHeight: number;
  chart: 'chart' | 'unavailable' | null;
  prices: string | null;
  svgW: number;
  svgH: number;
  /** The SVG's own coordinate height — compared with the box to prove the chart is not shrunk. */
  vbH: number;
  series: Record<string, number>;
  partialDots: number;
  hasPartialTick: boolean;
  rightAxis: boolean;
  text: string;
  pdfPages: number;
}

async function browserChecks(base: string) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // Capture the document the dialog prints: stub the hidden iframe's print() the moment
  // the iframe is attached, and keep its HTML on the parent window.
  await ctx.addInitScript(() => {
    const orig = HTMLBodyElement.prototype.appendChild;
    HTMLBodyElement.prototype.appendChild = function <T extends Node>(this: HTMLBodyElement, node: T): T {
      const out = orig.call(this, node) as T;
      if (node instanceof HTMLIFrameElement && node.contentWindow) {
        const frame = node;
        const win = frame.contentWindow as Window & { print: () => void };
        win.print = () => {
          (window as unknown as { __printedHtml?: string }).__printedHtml =
            '<!DOCTYPE html>\n' + (frame.contentDocument?.documentElement.outerHTML ?? '');
        };
      }
      return out;
    };
  });
  const page = await ctx.newPage();
  const printPage = await ctx.newPage();

  async function printed(query: string, waitState: 'ready' | 'error' | 'loading'): Promise<string> {
    await page.goto(`${base}/dev/table-playground/blendanalysis${query}`, { waitUntil: 'networkidle' });
    await page.waitForSelector(`[data-blend-print][data-blend-market-state="${waitState}"]`, { timeout: 8000 });
    await page.evaluate(() => {
      (window as unknown as { __printedHtml?: string }).__printedHtml = undefined;
    });
    await page.click('[data-blend-print]');
    await page.waitForFunction(() => !!(window as unknown as { __printedHtml?: string }).__printedHtml, undefined, {
      timeout: 5000,
    });
    return page.evaluate(() => (window as unknown as { __printedHtml: string }).__printedHtml);
  }

  async function measure(html: string, tag: string): Promise<PageOneMetrics> {
    await printPage.setViewportSize({ width: 1047, height: 718 });
    await printPage.emulateMedia({ media: 'print' });
    await printPage.setContent(html, { waitUntil: 'load' });
    const m = await printPage.evaluate(() => {
      const p1 = document.querySelector('.p1') as HTMLElement | null;
      const sec = document.querySelector('[data-blend-market-chart]') as HTMLElement | null;
      const svg = document.querySelector('.mchart-svg') as SVGSVGElement | null;
      const r = svg?.getBoundingClientRect();
      const series: Record<string, number> = {};
      for (const el of Array.from(document.querySelectorAll('.mchart-svg [data-series]'))) {
        const k = `${el.tagName.toLowerCase()}:${el.getAttribute('data-series')}`;
        series[k] = (series[k] ?? 0) + 1;
      }
      const texts = Array.from(document.querySelectorAll('.mchart-svg text')).map((t) => t.textContent ?? '');
      return {
        hasP1: !!p1,
        p1Height: p1?.getBoundingClientRect().height ?? 0,
        p1ScrollHeight: p1?.scrollHeight ?? 0,
        chart: sec ? (sec.getAttribute('data-blend-market-chart') === '1' ? 'chart' : 'unavailable') : null,
        prices: sec?.getAttribute('data-prices') ?? null,
        svgW: r?.width ?? 0,
        svgH: r?.height ?? 0,
        vbH: Number((svg?.getAttribute('viewBox') ?? '0 0 0 0').split(' ')[3]),
        series,
        partialDots: document.querySelectorAll('.mchart-svg [data-partial="1"]').length,
        hasPartialTick: texts.includes('partial'),
        rightAxis: texts.includes('t / month') && texts.includes('₱/kg'),
        text: p1?.innerText ?? '',
      };
    });
    const pdf = await printPage.pdf({ preferCSSPageSize: true, printBackground: true });
    const pdfPages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    if (DUMP) {
      writeFileSync(resolve(DUMP, `${tag}.pdf`), pdf);
      writeFileSync(resolve(DUMP, `${tag}.html`), html);
      await printPage.screenshot({ path: resolve(DUMP, `${tag}-p1.png`), clip: { x: 0, y: 0, width: 1047, height: 718 } });
    }
    return { ...m, chart: m.chart as PageOneMetrics['chart'], pdfPages };
  }

  const MM = 96 / 25.4;
  const assertOnePage = (m: PageOneMetrics) => {
    assert.ok(m.hasP1, 'page one is not wrapped');
    assert.ok(Math.abs(m.p1Height - 189 * MM) < 2, `page one is ${m.p1Height}px, not 189 mm`);
    assert.ok(m.p1ScrollHeight <= Math.ceil(m.p1Height) + 1, `page one overflows: ${m.p1ScrollHeight} > ${m.p1Height}`);
    // `?pages=` (none) → page one + the 24-block table = exactly two sheets. A page one
    // that spilled would push a third.
    assert.equal(m.pdfPages, 2, `expected 2 printed sheets, got ${m.pdfPages}`);
  };

  try {
    console.log(`\n6. IN THE BROWSER — ${base}`);

    await check('price viewer (saved): the chart is on page one, all four series, two axes, ONE page', async () => {
      const html = await printed('?saved=1&pages=&slow=300', 'ready');
      const m = await measure(html, 'print-price');
      assertOnePage(m);
      assert.equal(m.chart, 'chart');
      assert.equal(m.prices, '1');
      for (const k of ['polygon:fedVolume', 'polygon:deliveredVolume', 'polyline:fedPrice', 'polyline:deliveredPrice']) {
        assert.ok((m.series[k] ?? 0) >= 1, `${k} not drawn`);
      }
      assert.ok(m.rightAxis, 'the dual axis is missing');
      assert.equal(m.partialDots, 2, 'the partial month is not marked on both lines');
      assert.ok(m.hasPartialTick);
      const lower = m.text.toLowerCase();
      const title = BLEND_MARKET_CHART_TITLE.toLowerCase();
      assert.ok(lower.includes(title), 'the chart title is not on page one');
      // Width-bound at (near) full scale — the labels print at their designed size.
      const scale = Math.min(m.svgW / BLEND_MARKET_SVG_WIDTH_PX, m.svgH / m.vbH);
      assert.ok(scale >= 0.95, `the chart is drawn at ${scale.toFixed(3)}× — its labels shrank`);
      assert.ok(m.svgH - m.vbH * scale <= 30, `${(m.svgH - m.vbH * scale).toFixed(0)}px of dead space around the plot`);
      assert.ok(m.svgH >= 170, `chart is only ${m.svgH}px tall`);
      // The chart sits BELOW the lab stats.
      assert.ok(lower.indexOf('blended lab stats') < lower.indexOf(title), 'the chart is not below the lab stats');
    });

    await check('price-DENIED reader: two volume areas, ONE axis, no ₱ on page one, ONE page', async () => {
      const html = await printed('?saved=1&pages=&prices=0', 'ready');
      const m = await measure(html, 'print-denied');
      assertOnePage(m);
      assert.equal(m.chart, 'chart');
      assert.equal(m.prices, '0');
      assert.ok((m.series['polygon:fedVolume'] ?? 0) >= 1 && (m.series['polygon:deliveredVolume'] ?? 0) >= 1);
      assert.equal(m.series['polyline:fedPrice'] ?? 0, 0);
      assert.equal(m.series['polyline:deliveredPrice'] ?? 0, 0);
      assert.ok(!m.rightAxis, 'a second axis on a price-denied chart');
      assert.ok(!m.text.includes('₱'), 'a ₱ reached a price-denied page one');
      assert.ok(m.hasPartialTick, 'the partial month is not marked for a volume-only chart');
    });

    await check('a NULL month renders as a gap (two area runs, a broken line), coverage footnoted', async () => {
      const html = await printed('?saved=1&pages=&market=gaps', 'ready');
      const m = await measure(html, 'print-gaps');
      assertOnePage(m);
      assert.equal(m.series['polygon:deliveredVolume'], 2, 'the April delivery gap was bridged');
      assert.equal(m.series['polyline:fedPrice'], 2, 'the December fed-price gap was bridged');
      assert.ok(/Aug 2026: 97\.3% of fed kg traceable to a delivery price/.test(m.text));
    });

    for (const mode of ['fail', 'throw'] as const) {
      await check(`a ${mode === 'fail' ? 'refused' : 'thrown'} read degrades to the note; the print still works`, async () => {
        const html = await printed(`?saved=1&pages=&market=${mode}`, 'error');
        const m = await measure(html, `print-${mode}`);
        assertOnePage(m);
        assert.equal(m.chart, 'unavailable');
        assert.ok(m.text.includes(BLEND_MARKET_UNAVAILABLE_HEADLINE), 'no unavailable note');
        assert.ok(m.text.includes('fixture:'), 'the reason is not printed');
        assert.equal(Object.keys(m.series).length, 0);
      });
    }

    await check('a Print that beats the reply prints the "still loading" note', async () => {
      const html = await printed('?pages=&market=stall', 'loading');
      const m = await measure(html, 'print-loading');
      assertOnePage(m);
      assert.equal(m.chart, 'unavailable');
      assert.ok(m.text.includes('still loading'));
    });

    await check('a live (unsaved) blend with the real shape is one page too', async () => {
      const html = await printed('?pages=', 'ready');
      assertOnePage(await measure(html, 'print-live'));
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
