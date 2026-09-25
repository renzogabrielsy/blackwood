/**
 * verify-blend-live-stats-ui.ts — the proofs behind the BLEND ACTION BAR's two 2026-09-25
 * features: the LIVE STATS strip (the running blend while picking) and the
 * **Save to v{N}** door (overwrite a saved version in place) beside **Save as v{N+1}**.
 *
 * Run:
 *   npx tsx scripts/verify-blend-live-stats-ui.ts                 # static + browser
 *   npx tsx scripts/verify-blend-live-stats-ui.ts --static-only   # no browser
 *   BLEND_STATS_BASE_URL=http://localhost:3217 npx tsx scripts/verify-blend-live-stats-ui.ts
 *
 * The browser half drives `/dev/table-playground/blendstats`, which mounts the REAL
 * `BlendActionBar` + `useBlendLiveStats` with an in-memory fetcher (~300 ms latency, and
 * per-selection slow / failing / hanging modes). It needs a dev server; it opens no
 * database connection and holds no key. The real page needs sign-in, which is exactly
 * why the fixture exists.
 *
 * ============================================================================
 * WHAT IS PROVEN
 * ============================================================================
 *   NO MATHS      the strip's figures are `buildBlendProposal`'s (→ `fn_blend_proposal`),
 *                 the modal's own definition. No `reduce`, no ×1.30, no weighting in the
 *                 two new files; the only subtraction is `makeBlendDelta`.
 *   THE GUARD     a reply is painted only when it answers the selection on screen NOW —
 *                 by SIGNATURE, never by a counter. Proven in the browser with a slow
 *                 first reply that lands AFTER a newer one.
 *   FIRST FRAME   the first read after enable fires immediately (a debounce-only read is
 *                 the 2026-09-21 lens stall); later reads are debounced.
 *   THE GATE      the ₱ tiles hang off the grid's EFFECTIVE flag and are ABSENT (not an
 *                 em dash) when it is false.
 *   ERRORS        inline, persistent, with Copy + Retry; the last good numbers survive.
 *                 A read that never answers trips the watchdog.
 *   THE DOORS     Save to v{from} and Save as v{N+1} exist in a Modify session and only
 *                 there; the overwrite carries the revision token loaded with the version.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  acceptBlendReply,
  blendSelectionSignature,
  blendSignatureLocs,
} from '../app/(app)/inventory/blocking/blend-live-stats';

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const STATS = 'app/(app)/inventory/blocking/blend-live-stats.tsx';
const BAR = 'app/(app)/inventory/blocking/blend-action-bar.tsx';
const GRID = 'app/(app)/inventory/blocking/blocking-grid.tsx';
const DIALOG = 'app/(app)/inventory/_shared/blend-proposal-dialog.tsx';
const LIST = 'app/(app)/inventory/_shared/blend-proposals-dialog.tsx';
const CONTEXT = 'app/(app)/inventory/blocking/CONTEXT.md';

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

async function staticChecks() {
  const stats = read(STATS);
  const bar = read(BAR);
  const grid = read(GRID);
  const dialog = read(DIALOG);
  const list = read(LIST);
  const ctx = read(CONTEXT);

  console.log('\n1. THE SIGNATURE — pure');

  await check('order-insensitive, trimmed, de-duplicated; empty selection is ""', () => {
    assert.equal(blendSelectionSignature(['B-2A', 'A-1A']), blendSelectionSignature(['A-1A', 'B-2A']));
    assert.equal(blendSelectionSignature([' A-1A ', 'A-1A', '']), 'A-1A');
    assert.equal(blendSelectionSignature([]), '');
    assert.deepEqual(blendSignatureLocs(blendSelectionSignature(['C-3A', 'A-1A'])), ['A-1A', 'C-3A']);
    assert.deepEqual(blendSignatureLocs(''), []);
  });

  await check('a reply is accepted ONLY for the selection on screen now', () => {
    const a = blendSelectionSignature(['A-1A']);
    const ab = blendSelectionSignature(['A-1A', 'A-2A']);
    assert.equal(acceptBlendReply(ab, a), false, 'a stale reply was accepted');
    assert.equal(acceptBlendReply(ab, ab), true);
    assert.equal(acceptBlendReply('', ''), false, 'a reply with nothing selected was accepted');
  });

  console.log('\n2. NO MATHS in the two new files');

  await check('no reduce, no ×1.30, no weighting — only makeBlendDelta subtracts', () => {
    for (const [rel, src] of [
      [STATS, code(stats)],
      [BAR, code(bar)],
    ] as const) {
      assert.ok(!/\.reduce\(/.test(src), `${rel} folds numbers with reduce`);
      assert.ok(!/1\.3\b|\* ?1\.30/.test(src), `${rel} re-derives the ×1.30 markup`);
      assert.ok(!/total_balance\s*\*|\*\s*[a-z_.]*balance/i.test(src), `${rel} weights by balance`);
    }
    assert.ok(/makeBlendDelta\(/.test(stats), 'the Modify delta does not go through makeBlendDelta');
    assert.ok(/from '@\/lib\/blocking\/blend-diff'/.test(stats), 'the delta helpers are not the shared ones');
  });

  await check('the grid feeds the hook the ONE blend definition (buildBlendProposal)', () => {
    assert.ok(
      /useBlendLiveStats\(\{\s*enabled: blendMode,\s*selection: blendSelection,\s*fetcher: buildBlendProposal,/.test(
        grid,
      ),
      'the grid does not wire useBlendLiveStats to buildBlendProposal',
    );
  });

  console.log('\n3. THE REQUEST — signature guard, first frame, watchdog');

  await check('replies are guarded by SIGNATURE, never a counter', () => {
    const src = code(stats);
    assert.ok(/acceptBlendReply\(latestSignatureRef\.current, replySignature\)/.test(src), 'no signature guard');
    assert.ok(!/requestIdRef|seqRef|counterRef|\+\+[a-zA-Z]*Ref\.current/.test(src), 'a monotonic counter guards replies');
  });

  await check('the first read after enable fires on its own frame; later reads debounce', () => {
    const src = code(stats);
    assert.ok(/if \(firedKeyRef\.current === null \|\| isRetry\) \{\s*fire\(\);/.test(src), 'first read is not immediate');
    assert.ok(/setTimeout\(fire, debounceMs\)/.test(src), 'later reads are not debounced');
    assert.ok(/BLEND_LIVE_STATS_DEBOUNCE_MS = 250/.test(src), 'debounce is not ~250 ms');
  });

  await check('an outstanding read trips a watchdog', () => {
    assert.ok(/setStalledKey\(requestKey\)/.test(stats) && /watchdogMs/.test(stats), 'no watchdog');
  });

  await check('the hook lives in the GRID, not the bar (a bar remount cannot orphan a read)', () => {
    assert.ok(!/useBlendLiveStats\(/.test(code(bar)), 'the bar owns the request');
    assert.ok(/useBlendLiveStats\(/.test(grid), 'the grid does not own the request');
  });

  console.log('\n4. THE GATE, THE BAR, THE ERRORS');

  await check('the ₱ tiles hang off the EFFECTIVE flag and are omitted, not dashed', () => {
    assert.ok(/const canViewPrices = serverCanViewPrices && showPrices;/.test(grid), 'effective flag missing');
    assert.ok(/<BlendActionBar[\s\S]*?canViewPrices=\{canViewPrices\}/.test(grid), 'bar not given the effective flag');
    assert.ok(/const showPrices = canViewPrices && \(value\?\.can_view_prices \?\? false\);/.test(stats));
    assert.ok(/\{showPrices && \(\s*<>\s*<StatCell\s*stat="raw_price"/.test(stats), 'the ₱ tiles are not conditional');
  });

  await check('the bar is shown for the WHOLE blend session (hint when nothing is picked)', () => {
    assert.ok(/\{blendMode && \(\s*<BlendActionBar/.test(grid), 'the bar is gated on more than blendMode');
    assert.ok(/Pick blocks to see the running blend/.test(stats), 'no empty-selection hint');
  });

  await check('no raw toast.error; the inline error has Copy + Retry', () => {
    for (const [rel, src] of [
      [STATS, stats],
      [BAR, bar],
      [GRID, grid],
    ] as const) {
      assert.ok(!/toast\.error\(/.test(code(src)), `${rel} calls toast.error directly`);
    }
    assert.ok(/data-blend-live-error/.test(stats) && /Copy/.test(stats) && /data-blend-live-retry/.test(stats));
  });

  await check('the glass floating-bar pattern and the fade-up entrance', () => {
    assert.ok(/animate-fade-up/.test(bar));
    assert.ok(/bg-background\/95[\s\S]*backdrop-blur supports-backdrop-filter:bg-background\/60/.test(bar));
  });

  console.log('\n5. SAVE TO v{N} (overwrite) BESIDE SAVE AS v{N+1} (append)');

  await check('both doors in the Modify session; the overwrite targets the version being modified', () => {
    assert.ok(
      /mode="overwrite"\s*versionNo=\{editing\.fromVersionNo\}/.test(bar),
      'Save to v{N} does not target fromVersionNo',
    );
    assert.ok(
      /mode="append"\s*versionNo=\{editing\.expectedVersionNo \+ 1\}/.test(bar),
      'Save as v{N+1} is not the next version',
    );
    assert.ok(/\{editing && \(\s*<>\s*<SaveVersionPopover\s*mode="overwrite"/.test(bar), 'doors not gated on editing');
  });

  await check('the overwrite sends the revision token LOADED with the version', () => {
    assert.ok(/fromRevisionNo: savedProposal\.revision_no,/.test(grid), 'Modify does not capture revision_no');
    assert.ok(/overwriteBlendProposalVersion\(\{[\s\S]*?expectedRevisionNo: editing\.fromRevisionNo,/.test(grid));
    assert.ok(/versionNo,\s*expectedRevisionNo/.test(grid) && /const versionNo = editing\.fromVersionNo;/.test(grid));
  });

  await check('overwrite outcomes: unchanged stays, success reloads + navigates, refusals errorToast', () => {
    const body = grid.slice(grid.indexOf('const handleOverwriteVersion'), grid.indexOf('const handleSaveAsNewFromEdit'));
    assert.ok(/Identical to v\$\{versionNo\} — nothing saved/.test(body));
    assert.ok(/await loadProposals\(\);[\s\S]*proposalLinkRef\.current\?\.\(editing\.proposalId, versionNo\)/.test(body));
    assert.ok(/errorToast\(`Could not save to v\$\{versionNo\}`, \{ description: describeOverwriteRefusal/.test(body));
    assert.ok(/res\.reason === 'stale'/.test(bar) && /Someone else changed v\$\{versionNo\}/.test(bar));
  });

  await check('the popover copy is honest about both doors', () => {
    assert.ok(!/is never changed/.test(bar) && !/is never changed/.test(grid), 'stale "vN-1 is never changed" copy');
    assert.ok(/recalculated as of\s+today, and the previous contents are kept in the archive/.test(bar));
    assert.ok(/the versions already saved stay exactly as they are/.test(bar));
  });

  console.log('\n6. THE RAIL AND THE VIEWER SAY WHEN A VERSION WAS EDITED');

  await check('the rail shows asOfAt and "edited {date} by {name}"; the header too; the list marks it', () => {
    assert.ok(/blendComputedDate\(chosen\.asOfAt\)/.test(dialog), 'the rail date is not asOfAt');
    assert.ok(/edited \{blendComputedDate\(chosen\.revisedAt\)/.test(dialog), 'no edited line on the rail');
    assert.ok(/saved\.proposal\.revision_no > 1/.test(dialog), 'the header does not mark an edited version');
    assert.ok(/currentVersionRevisionNo \?\? 1\) > 1/.test(list), 'the list does not mark an edited version');
  });

  await check('CONTEXT.md documents the live stats and the Save-to-vN door', () => {
    assert.ok(/Live blend stats/i.test(ctx) && /Save to v/.test(ctx) && /verify-blend-live-stats-ui/.test(ctx));
  });
}

// ─── Browser half ─────────────────────────────────────────────────────────────

async function browserChecks(base: string) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const url = (q = '') => `${base}/dev/table-playground/blendstats${q}`;
  const tile = (stat: string) => page.locator(`[data-blend-live-stat="${stat}"] > div`).nth(1);

  try {
    console.log(`\n7. IN THE BROWSER — ${base}`);

    await check('hidden when blend mode is off; visible with the empty hint when on', async () => {
      await page.goto(url(), { waitUntil: 'networkidle' });
      assert.equal(await page.locator('[data-blend-action-bar]').count(), 0, 'bar shown with blend mode off');
      await page.click('[data-fixture-blend-toggle]');
      await page.waitForSelector('[data-blend-action-bar]');
      await page.waitForSelector('[data-blend-live-stats="empty"]');
      assert.equal(await page.locator('[data-fixture-calls="0"]').count(), 1, 'a read fired with nothing picked');
      assert.equal(await page.locator('[data-blend-save-version], [data-blend-overwrite-version]').count(), 0);
    });

    await check('the first pick reads immediately; the figures are the reply\'s', async () => {
      await page.click('[data-fixture-block="A-1A"]');
      await page.waitForSelector('[data-blend-live-stats="current"]', { timeout: 3000 });
      assert.equal((await tile('blocks').innerText()).trim(), '1');
      assert.equal((await tile('balance').innerText()).trim(), '12,345');
      assert.equal((await tile('bd_astm').innerText()).trim(), '0.410', 'BD is not 3 dp');
      assert.equal((await tile('mc').innerText()).trim(), '10.50', 'lab is not 2 dp');
      assert.ok((await tile('raw_price').innerText()).includes('40.25'), '₱ tile missing for a price reader');
    });

    await check('while updating, the last numbers stay on screen (dimmed), then move', async () => {
      await page.click('[data-fixture-block="A-3A"]');
      await page.waitForSelector('[data-blend-live-stats="updating"]', { timeout: 1000 });
      assert.equal((await tile('blocks').innerText()).trim(), '1', 'the previous figures were wiped while updating');
      await page.waitForSelector('[data-blend-live-stats="current"]', { timeout: 3000 });
      assert.equal((await tile('blocks').innerText()).trim(), '2');
    });

    await check('a STALE reply that lands after a newer one is discarded (signature guard)', async () => {
      await page.goto(url('?slow=A-2A'), { waitUntil: 'networkidle' });
      await page.click('[data-fixture-blend-toggle]');
      await page.click('[data-fixture-block="A-2A"]'); // fires NOW, answers at ~1.5 s
      await page.waitForTimeout(80);
      await page.click('[data-fixture-block="A-3A"]'); // debounced, answers at ~0.65 s
      await page.waitForSelector('[data-blend-live-stats="current"]', { timeout: 3000 });
      assert.equal((await tile('blocks').innerText()).trim(), '2');
      await page.waitForFunction(
        () => (document.querySelector('[data-fixture-log]')?.textContent ?? '').split('\n').includes('resolve A-2A'),
        undefined,
        { timeout: 4000 },
      );
      await page.waitForTimeout(100);
      assert.equal((await tile('blocks').innerText()).trim(), '2', 'the stale 1-block reply overwrote the 2-block selection');
      assert.equal(await page.locator('[data-blend-live-stats="current"]').count(), 1);
    });

    await check('₱ tiles are ABSENT for a reader who cannot see prices', async () => {
      await page.goto(url('?prices=0'), { waitUntil: 'networkidle' });
      await page.click('[data-fixture-blend-toggle]');
      await page.click('[data-fixture-block="A-1A"]');
      await page.waitForSelector('[data-blend-live-stats="current"]', { timeout: 3000 });
      assert.equal(await page.locator('[data-blend-live-stat="raw_price"], [data-blend-live-stat="product_cost"]').count(), 0);
      assert.equal(await page.locator('[data-blend-live-stat="mc"]').count(), 1);
      assert.ok(!(await page.locator('[data-blend-action-bar]').innerText()).includes('₱'), 'a ₱ glyph reached the bar');
    });

    await check('a failed read shows Copy + Retry and keeps the last good numbers', async () => {
      await page.goto(url('?fail=A-9A'), { waitUntil: 'networkidle' });
      await page.click('[data-fixture-blend-toggle]');
      await page.click('[data-fixture-block="A-1A"]');
      await page.waitForSelector('[data-blend-live-stats="current"]', { timeout: 3000 });
      await page.click('[data-fixture-block="A-9A"]');
      await page.waitForSelector('[data-blend-live-error]', { timeout: 3000 });
      const err = await page.locator('[data-blend-live-error]').innerText();
      assert.ok(/fixture: A-9A refused/.test(err) && /Copy/.test(err) && /Retry/.test(err), err);
      assert.equal((await tile('blocks').innerText()).trim(), '1', 'the error wiped the last good numbers');
      const before = Number(await page.locator('[data-fixture-calls]').getAttribute('data-fixture-calls'));
      await page.click('[data-blend-live-retry]');
      await page.waitForFunction(
        (n) => Number(document.querySelector('[data-fixture-calls]')?.getAttribute('data-fixture-calls')) > n,
        before,
        { timeout: 2000 },
      );
    });

    await check('a read that never answers trips the watchdog', async () => {
      await page.goto(url('?hang=A-8A&watchdog=800'), { waitUntil: 'networkidle' });
      await page.click('[data-fixture-blend-toggle]');
      await page.click('[data-fixture-block="A-8A"]');
      await page.waitForSelector('[data-blend-live-error]', { timeout: 3000 });
      assert.ok(/has not answered/.test(await page.locator('[data-blend-live-error]').innerText()));
    });

    await check('a Modify session offers Save to v2 AND Save as v5, with deltas vs v2', async () => {
      await page.goto(url('?modify=1'), { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-blend-overwrite-version="2"]');
      assert.equal(await page.locator('[data-blend-save-version="5"]').count(), 1);
      await page.waitForSelector('[data-blend-live-stats="current"]', { timeout: 3000 });
      assert.equal((await page.locator('[data-blend-live-delta="blocks"]').innerText()).trim(), '0');
      await page.click('[data-fixture-block="A-3A"]');
      await page.waitForFunction(
        () => document.querySelector('[data-blend-live-delta="blocks"]')?.textContent?.trim() === '+1',
        undefined,
        { timeout: 3000 },
      );
      await page.click('[data-blend-overwrite-version="2"]');
      const pop = page.locator('[data-blend-overwrite-explainer]');
      await pop.waitFor();
      assert.ok(/recalculated as of today/.test(await pop.innerText()));
      await page.keyboard.press('Escape');
    });

    await check('the bar never forces a horizontal page scroll at 375 px (the strip scrolls)', async () => {
      await page.setViewportSize({ width: 375, height: 740 });
      await page.goto(url('?modify=1'), { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-blend-live-stats="current"]', { timeout: 3000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
      const barW = await page.locator('[data-blend-action-bar]').evaluate((el) => el.getBoundingClientRect().width);
      assert.ok(barW <= 375 - 32 + 1, `bar is ${barW}px wide`);
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  await staticChecks();
  if (process.argv.includes('--static-only')) {
    console.log(`\n${passed} assertions passed (static only — browser half skipped by flag).`);
    return;
  }
  const base = process.env.BLEND_STATS_BASE_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${base}/dev/table-playground/blendstats`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(
      `\nThe browser half needs a dev server serving ${base}/dev/table-playground/blendstats ` +
        `(${err instanceof Error ? err.message : String(err)}). Start one with ` +
        '`env -u ANTHROPIC_API_KEY npm run dev`, set BLEND_STATS_BASE_URL, or pass --static-only.',
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
