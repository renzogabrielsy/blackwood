import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────────
// Blackwood Table — the PARITY suite.
//
// Every gesture in here is one the ledger this module was extracted from either had, or
// silently did not have. The suite drives the REAL grid through `/dev/table-playground`,
// which mounts it on an in-memory array — no login, no Supabase, no tenant module — so it
// keeps meaning something when the first consumer migrates onto it in Stage 1D.
//
// ── THE FIXTURE'S GEOMETRY, WHICH EVERY ASSERTION BELOW COUNTS ON ───────────────
//
// COLUMNS (with the ctx-hidden `secret` column off, which is the default):
//   0 num · 1 code · 2 label · 3 qty · 4 rate · 5 note · 6 total · 7 actions
//   `num` and `actions` are `derived` (never selectable); `total` is read-only but IS
//   selectable, which is the "a run of computed totals is the most useful thing on a
//   sheet to add up" case.
//
// NAV ROWS — records interleaved with their children, drafts at the end. Every 7th
// record carries 2 children, so:
//   nav 0 = r0 · nav 1,2 = r0's children · nav 3 = r1 · nav 4 = r2 · … · nav 9 = r7 ·
//   nav 10,11 = r7's children · nav 12 = r8 …
//   120 records + 36 children = nav 0…155, then 5 drafts = nav 156…160.
// Group spacers and group HEADINGS are NOT addressable, so neither ever appears in that
// numbering — which is the whole point of them.
//
// ITEMS (what the virtualiser renders, which is a different count): 12 group headings +
// 11 spacers + 120 records + 36 children + 5 drafts = 184. That gap between 184 items and
// 120 records is exactly what `firstItemIndex` has to be decremented by.
// ─────────────────────────────────────────────────────────────────────────────────

const PLAYGROUND = '/dev/table-playground';

/**
 * Paste is the one gesture the GRID does not implement on keydown — the browser has to
 * dispatch a real `paste` event, and it only does that for the platform's own paste
 * accelerator. On macOS that is Cmd+V; Ctrl+V is not bound to anything, so it produces a
 * keydown and no clipboard event at all. (Copy is unaffected: the grid handles Ctrl/Cmd+C
 * itself, which is why a single-cell copy works here and did not in the ledger.)
 */
const PASTE = process.platform === 'darwin' ? 'Meta+v' : 'Control+v';

/** Last addressable row with a filled `label`: the drafts below it are blank. */
const LAST_FILLED_ROW = 155;
/** Last nav row of all — the fifth blank draft. */
const LAST_NAV_ROW = 160;

/** `DEFAULT_FIRST_ITEM_INDEX` — the public index base the playground seeds its pager with. */
const FIRST_ITEM_INDEX_BASE = 100_000;
/** Everything the flat array holds at load: see the ITEMS note above. */
const ITEM_COUNT = 184;
/**
 * What ONE press of `Load older` adds to that array: 10 older records, **plus** the group
 * heading the new batch brings with it, **plus** the spacer the old leading group never
 * needed. 12, not 10 — which is the whole reason the base is rebased off the array's
 * length rather than off the number of records fetched.
 */
const PREPENDED_ITEMS = 12;
const PREPENDED_RECORDS = 10;

const cell = (page: Page, row: number, col: number): Locator =>
    page.locator(`[data-nav-row="${row}"] [data-col="${col}"]`);

const readout = (page: Page, id: string) => page.getByTestId(id);

async function open(page: Page) {
    await page.goto(PLAYGROUND);
    await expect(page.getByText('Blackwood Table playground')).toBeVisible();
    await expect(cell(page, 0, 2)).toHaveText('Item 0');
}

/** Click a cell the way an operator does — on the cell body, not on its edge. */
async function clickCell(page: Page, row: number, col: number) {
    await cell(page, row, col).click({ position: { x: 8, y: 8 } });
}

/**
 * Wait for the virtualised scroller to come to REST.
 *
 * The virtualiser suppresses its own upward-scroll compensation while a scroll is still in
 * progress, so a prepend that lands mid-scroll legitimately drifts by a row — real
 * behaviour, and not what the pager spec is about. An operator presses "load older" on a
 * sheet that has stopped moving; so does the suite.
 */
async function scrollSettled(page: Page) {
    const scrollTop = () =>
        page.evaluate(
            () =>
                (document.querySelector('[data-blackwood-table] > div') as HTMLElement | null)
                    ?.scrollTop ?? -1,
        );
    let last = await scrollTop();
    let quiet = 0;
    for (let i = 0; i < 25 && quiet < 3; i++) {
        await page.waitForTimeout(120);
        const now = await scrollTop();
        quiet = now === last ? quiet + 1 : 0;
        last = now;
    }
}

const active = (page: Page) => readout(page, 'active-cell');
const selection = (page: Page) => readout(page, 'selection');
const editing = (page: Page) => readout(page, 'editing');
const dirty = (page: Page) => readout(page, 'dirty');

test.describe('Blackwood Table — select ≠ edit', () => {
    test('a click SELECTS and never opens an editor', async ({ page }) => {
        await open(page);
        await clickCell(page, 0, 2);

        await expect(active(page)).toHaveText('0,2');
        await expect(editing(page)).toHaveText('idle');
        // The caret takes its 1×1 selection with it, so the tint and the ring can never
        // sit on two different cells.
        await expect(selection(page)).toHaveText('0,2,0,2');
        await expect(page.locator('input[data-table-editor]')).toHaveCount(0);
    });

    test('a click on a READ-ONLY cell still moves the caret (BUG-023)', async ({ page }) => {
        await open(page);
        // `total` is computed and never editable — but setting the active cell to null
        // there killed the entire keyboard, because the nav hook returns on its first
        // line with no active cell.
        await clickCell(page, 0, 6);
        await expect(active(page)).toHaveText('0,6');
        await expect(editing(page)).toHaveText('idle');

        // …and the sheet still answers to the keyboard from there.
        await page.keyboard.press('ArrowDown');
        await expect(active(page)).not.toHaveText('0,6');
    });

    test('a printable character types OVER the value', async ({ page }) => {
        await open(page);
        await clickCell(page, 0, 2);
        await page.keyboard.press('x');

        await expect(editing(page)).toHaveText('editing');
        await expect(page.locator('input[data-table-editor]')).toHaveValue('x');
    });

    test('Enter, F2 and double-click all open the editor PRESERVING the value', async ({ page }) => {
        await open(page);

        await clickCell(page, 0, 2);
        await page.keyboard.press('F2');
        await expect(page.locator('input[data-table-editor]')).toHaveValue('Item 0');
        await page.keyboard.press('Escape');

        await cell(page, 0, 2).dblclick({ position: { x: 8, y: 8 } });
        await expect(page.locator('input[data-table-editor]')).toHaveValue('Item 0');
        await page.keyboard.press('Escape');

        await clickCell(page, 0, 2);
        await page.keyboard.press('Enter');
        await expect(page.locator('input[data-table-editor]')).toHaveValue('Item 0');
    });

    test('Enter while editing COMMITS and moves down', async ({ page }) => {
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('z');
        await page.keyboard.type('ebra');
        await page.keyboard.press('Enter');

        await expect(editing(page)).toHaveText('idle');
        await expect(cell(page, 3, 2)).toHaveText('zebra');
        // Down one row in the same lane. nav 3 is r1, so nav 4 is r2.
        await expect(active(page)).toHaveText('4,2');
        await expect(dirty(page)).toHaveText('1');
    });
});

test.describe('Blackwood Table — movement', () => {
    test('Tab moves right, Shift+Tab back', async ({ page }) => {
        await open(page);
        await clickCell(page, 0, 2);
        await page.keyboard.press('Tab');
        await expect(active(page)).toHaveText('0,3');
        await page.keyboard.press('Shift+Tab');
        await expect(active(page)).toHaveText('0,2');
    });

    test('arrows step over the coordinates a row does not HAVE', async ({ page }) => {
        await open(page);

        // `label` exists on a child, so ArrowDown walks into r0's first sub-row.
        await clickCell(page, 0, 2);
        await page.keyboard.press('ArrowDown');
        await expect(active(page)).toHaveText('1,2');

        // `code` does NOT exist on a child, so the same key in that lane steps over BOTH
        // sub-rows and lands on the next record. That asymmetry is `occupies()` working.
        await clickCell(page, 0, 1);
        await page.keyboard.press('ArrowDown');
        await expect(active(page)).toHaveText('3,1');
    });

    test('Ctrl+Arrow jumps to the edge of the data block', async ({ page }) => {
        await open(page);

        // Right along a filled run: `actions` holds no value, so the run ends at `total`.
        await clickCell(page, 0, 1);
        await page.keyboard.press('Control+ArrowRight');
        await expect(active(page)).toHaveText('0,6');

        // Down the `label` column: every record and child is filled, the draft rows below
        // are blank, so the run ends on the last filled row.
        await clickCell(page, 0, 2);
        await page.keyboard.press('Control+ArrowDown');
        await expect(active(page)).toHaveText(`${LAST_FILLED_ROW},2`);
    });

    test('Home / End / Ctrl+Home / Ctrl+End land on real cells only', async ({ page }) => {
        await open(page);

        await clickCell(page, 0, 4);
        await page.keyboard.press('Home');
        await expect(active(page)).toHaveText('0,0');

        await page.keyboard.press('End');
        await expect(active(page)).toHaveText('0,7');

        await page.keyboard.press('Control+End');
        // The last nav row is a blank draft, which occupies neither `total` nor
        // `actions` — so the sheet's far corner is its `note` lane.
        await expect(active(page)).toHaveText(`${LAST_NAV_ROW},5`);

        await page.keyboard.press('Control+Home');
        await expect(active(page)).toHaveText('0,0');
    });

    test('PageDown moves a VIEWPORT of rows, not a fixed count', async ({ page }) => {
        await open(page);
        await clickCell(page, 0, 2);
        await page.keyboard.press('PageDown');

        const text = await active(page).textContent();
        const [row, col] = (text ?? '').split(',').map(Number);
        // A page is measured in real row heights, and the sheet mixes 32px records with
        // 26px children — so the exact landing row depends on the viewport. What is fixed
        // is that it moved a long way down and stayed in its lane.
        expect(col).toBe(2);
        expect(row).toBeGreaterThan(5);

        await page.keyboard.press('PageUp');
        const back = await active(page).textContent();
        expect(Number((back ?? '').split(',')[0])).toBeLessThan(row);
    });
});

test.describe('Blackwood Table — selection', () => {
    test('Shift+Arrow extends a range from the caret, not from (0,0)', async ({ page }) => {
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowRight');
        await expect(selection(page)).toHaveText('3,2,4,3');
    });

    test('a click-drag sweeps a rectangle', async ({ page }) => {
        await open(page);
        const from = await cell(page, 3, 2).boundingBox();
        const to = await cell(page, 5, 4).boundingBox();
        expect(from && to).toBeTruthy();

        await page.mouse.move(from!.x + 8, from!.y + 8);
        await page.mouse.down();
        await page.mouse.move(to!.x + 8, to!.y + 8, { steps: 8 });
        await page.mouse.up();

        await expect(selection(page)).toHaveText('3,2,5,4');
    });

    test('Ctrl+A covers the SELECTABLE columns only', async ({ page }) => {
        await open(page);
        await clickCell(page, 0, 2);
        await page.keyboard.press('Control+a');
        // Columns 0 (`#`) and 7 (actions) are ornaments with no arithmetic meaning, so
        // the sweep starts at `code` and ends at `total`.
        await expect(selection(page)).toHaveText(`0,1,${LAST_NAV_ROW},6`);
    });
});

test.describe('Blackwood Table — clearing and undo', () => {
    test('Delete clears the whole range and KEEPS the selection', async ({ page }) => {
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('Shift+ArrowDown');
        await expect(selection(page)).toHaveText('3,2,4,2');

        await page.keyboard.press('Delete');

        await expect(cell(page, 3, 2)).toHaveText('');
        await expect(cell(page, 4, 2)).toHaveText('');
        await expect(editing(page)).toHaveText('idle');
        // The block just blanked is still the block Escape's undo is aimed at. That is
        // what Excel does, and it is why the clear must not clear the range with it.
        await expect(selection(page)).toHaveText('3,2,4,2');
    });

    test('Escape means two things: undo the unsaved work, then deselect', async ({ page }) => {
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Delete');
        await expect(dirty(page)).toHaveText('2');

        // Stage one — put the stored values back. A cell cleared with Delete opened no
        // editor, so there is no pre-edit snapshot anywhere: without this it was
        // *unundoable*.
        await page.keyboard.press('Escape');
        await expect(cell(page, 3, 2)).toHaveText('Item 1');
        await expect(cell(page, 4, 2)).toHaveText('Item 2');
        await expect(dirty(page)).toHaveText('0');
        await expect(selection(page)).toHaveText('3,2,4,2');

        // Stage two — nothing left to undo, so it deselects.
        await page.keyboard.press('Escape');
        await expect(selection(page)).toHaveText('none');
    });

    test('Escape while EDITING reverts the editor', async ({ page }) => {
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('q');
        await page.keyboard.type('werty');
        await page.keyboard.press('Escape');

        await expect(editing(page)).toHaveText('idle');
        await expect(cell(page, 3, 2)).toHaveText('Item 1');
        // An edit that undoes itself is not an edit — the row must not stay dirty with
        // nothing to write.
        await expect(dirty(page)).toHaveText('0');
    });

    test('Ctrl+Z undoes a gesture and Ctrl+Y redoes it', async ({ page }) => {
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('n');
        await page.keyboard.type('ewvalue');
        await page.keyboard.press('Enter');
        await expect(cell(page, 3, 2)).toHaveText('newvalue');

        await page.keyboard.press('Control+z');
        await expect(cell(page, 3, 2)).toHaveText('Item 1');
        await expect(dirty(page)).toHaveText('0');

        await page.keyboard.press('Control+y');
        await expect(cell(page, 3, 2)).toHaveText('newvalue');
        await expect(dirty(page)).toHaveText('1');

        // Ctrl+Shift+Z is the other spelling of redo, and must agree with Ctrl+Y.
        await page.keyboard.press('Control+z');
        await expect(cell(page, 3, 2)).toHaveText('Item 1');
        await page.keyboard.press('Control+Shift+z');
        await expect(cell(page, 3, 2)).toHaveText('newvalue');
    });

    test('a multi-cell clear is ONE undo step', async ({ page }) => {
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Delete');
        await expect(dirty(page)).toHaveText('3');

        // A gesture, not a keystroke: three cells went blank together, so one Ctrl+Z
        // brings all three back.
        await page.keyboard.press('Control+z');
        await expect(dirty(page)).toHaveText('0');
        await expect(cell(page, 3, 2)).toHaveText('Item 1');
        await expect(cell(page, 5, 2)).toHaveText('Item 3');
    });
});

test.describe('Blackwood Table — the clipboard', () => {
    test('Ctrl+C copies a single cell as its STORED value', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await clickCell(page, 3, 3);
        await page.keyboard.press('Control+c');

        const text = await page.evaluate(() => navigator.clipboard.readText());
        // r1's qty. `clipboardValue` emits the stored number, never the rendering.
        expect(text).toBe('20');
    });

    test('Ctrl+C copies a RANGE as escaped TSV', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await clickCell(page, 3, 3);
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Control+c');

        const text = await page.evaluate(() => navigator.clipboard.readText());
        expect(text).toBe('20\t1.75\n30\t2');
    });

    test('pasting ONE value fills the whole selected range', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await page.evaluate(() => navigator.clipboard.writeText('7777'));

        await clickCell(page, 3, 3);
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press(PASTE);

        // Sheets' habit: a selection that is a whole-number multiple of the block TILES
        // it, which makes the 1×1 "fill the range" case fall out for free.
        await expect(cell(page, 3, 3)).toHaveText('7777');
        await expect(cell(page, 4, 3)).toHaveText('7777');
        await expect(cell(page, 5, 3)).toHaveText('7777');
        await expect(dirty(page)).toHaveText('3');
    });

    test('pasting a BLOCK lands it from the anchor', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await page.evaluate(() => navigator.clipboard.writeText('111\t222\n333\t444'));

        await clickCell(page, 3, 3);
        await page.keyboard.press(PASTE);

        await expect(cell(page, 3, 3)).toHaveText('111');
        await expect(cell(page, 3, 4)).toHaveText('222');
        await expect(cell(page, 4, 3)).toHaveText('333');
        await expect(cell(page, 4, 4)).toHaveText('444');
    });

    test('a paste STEPS OVER the child rows under a record (BUG-024)', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await page.evaluate(() => navigator.clipboard.writeText('7001\n7002\n7003'));

        // nav 0 is r0; nav 1 and 2 are its sub-rows, which occupy `qty` too. Mapping the
        // block positionally would write 7002 and 7003 into them and report success.
        await clickCell(page, 0, 3);
        await page.keyboard.press(PASTE);

        await expect(cell(page, 0, 3)).toHaveText('7001');
        await expect(cell(page, 1, 3)).toHaveText('1');
        await expect(cell(page, 2, 3)).toHaveText('2');
        await expect(cell(page, 3, 3)).toHaveText('7002');
        await expect(cell(page, 4, 3)).toHaveText('7003');
    });

    test('a paste anchored on a CHILD row never reaches a record', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await page.evaluate(() => navigator.clipboard.writeText('8001\n8002'));

        await clickCell(page, 1, 3);
        await page.keyboard.press(PASTE);

        await expect(cell(page, 1, 3)).toHaveText('8001');
        await expect(cell(page, 2, 3)).toHaveText('8002');
        // The record above and the record below are untouched: a child is not a small
        // parent, so a block anchored on one fills children only.
        await expect(cell(page, 0, 3)).toHaveText('10');
        await expect(cell(page, 3, 3)).toHaveText('20');
    });

    test('a numeric column strips the rendering a spreadsheet pasted with it', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await page.evaluate(() => navigator.clipboard.writeText('1,234'));

        await clickCell(page, 3, 3);
        await page.keyboard.press(PASTE);
        await expect(cell(page, 3, 3)).toHaveText('1234');
    });
});

test.describe('Blackwood Table — the sheet itself', () => {
    test('a hidden column is ABSENT from the coordinate space, never blank', async ({ page }) => {
        await open(page);
        // `secret` sits between `note` and `total`. Hidden, `total` IS column 6.
        await clickCell(page, 0, 2);
        await page.keyboard.press('End');
        await expect(active(page)).toHaveText('0,7');

        await page.getByTestId('toggle-secret').check();
        await clickCell(page, 0, 2);
        await page.keyboard.press('End');
        // One more column exists now, so the row's far edge moved by exactly one.
        await expect(active(page)).toHaveText('0,8');
    });

    test('the blank-row pool grows on demand', async ({ page }) => {
        await open(page);
        // 120 records + 36 children + 5 drafts ⇒ the last nav row is 160.
        await clickCell(page, 0, 2);
        await page.keyboard.press('Control+End');
        await expect(active(page)).toHaveText(`${LAST_NAV_ROW},5`);

        // Back to the top before touching the DOM again: the sheet is virtualised, so the
        // rows down at the far end are the only ones rendered right now.
        await page.keyboard.press('Control+Home');
        await expect(active(page)).toHaveText('0,0');

        await page.getByTestId('add-rows').click();
        // The control is chrome and lives OUTSIDE the grid wrapper, so it holds focus
        // after the click and a keystroke aimed at it is correctly not a grid gesture.
        await clickCell(page, 0, 2);
        await page.keyboard.press('Control+End');
        await expect(active(page)).toHaveText(`${LAST_NAV_ROW + 20},5`);
    });

    test('a group spacer is a real row that the caret can never land on', async ({ page }) => {
        await open(page);
        // r9 is nav 13 and r10 is nav 14, with a blank spacer rendered between them —
        // so the coordinate space is byte-identical with and without spacers.
        await clickCell(page, 13, 2);
        await expect(cell(page, 13, 2)).toHaveText('Item 9');
        await page.keyboard.press('ArrowDown');
        await expect(active(page)).toHaveText('14,2');
        await expect(cell(page, 14, 2)).toHaveText('Item 10');
    });

    test('a chrome row renders INSIDE the body and tiles the lanes', async ({ page }) => {
        await open(page);

        const heading = page.locator('[data-group-heading="g0"]');
        await expect(heading).toHaveText('g0');

        // It is a BODY row. `summaryRows` can only reach the footer, so this is the seam
        // that exists — a heading interleaved with the data, not pinned under it.
        expect(await heading.evaluate((el) => el.closest('tbody') !== null)).toBe(true);
        expect(await heading.evaluate((el) => el.closest('tfoot') !== null)).toBe(false);

        // Two cells tile all eight columns: the pinned block, then everything right of it.
        // A lane of span 0 would have to render NO cell — `colSpan={0}` is "to the end of
        // the column group" in HTML, the opposite of nothing.
        const row = page.locator('tr', { has: page.locator('[data-group-heading="g0"]') });
        await expect(heading).toHaveAttribute('colspan', '6');
        await expect(row.locator('th')).toHaveAttribute('colspan', '2');
        expect(await row.locator('td, th').count()).toBe(2);

        // The cell over the pinned block is OPAQUE — any alpha and the scrolling rows bleed
        // through it, which is the frozen-panes rule, not a style preference.
        const pinned = row.locator('th');
        expect(await pinned.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
            'rgba(0, 0, 0, 0)',
        );
        expect(await pinned.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none');

        // Hiding a column moves the heading with the column table, because its spans are
        // read off the columns actually rendered rather than hard-coded.
        await page.getByTestId('toggle-secret').check();
        await expect(page.locator('[data-group-heading="g0"]')).toHaveAttribute('colspan', '7');
    });

    test('the caret can never land on a chrome row', async ({ page }) => {
        await open(page);

        // r9 is nav 13 and r10 is nav 14, with a spacer AND a group heading rendered
        // between them — the coordinate space is byte-identical with and without either.
        await clickCell(page, 13, 2);
        await expect(cell(page, 13, 2)).toHaveText('Item 9');
        await expect(page.locator('[data-group-heading="g1"]')).toHaveCount(1);

        await page.keyboard.press('ArrowDown');
        await expect(active(page)).toHaveText('14,2');
        await expect(cell(page, 14, 2)).toHaveText('Item 10');

        await page.keyboard.press('ArrowUp');
        await expect(active(page)).toHaveText('13,2');

        // Tab walks the same gap in reading order and skips it too: off the end of r9,
        // straight onto the first cell of r10.
        await page.keyboard.press('End');
        await expect(active(page)).toHaveText('13,7');
        await page.keyboard.press('Tab');
        await expect(active(page)).toHaveText('14,0');

        // And clicking it moves nothing: a chrome cell carries no `data-col`, so the row's
        // one dispatcher finds no column and the caret stays where it was.
        await page.locator('[data-group-heading="g1"]').click({ position: { x: 8, y: 8 } });
        await expect(active(page)).toHaveText('14,0');
    });

    test('a resize handle reports a new width', async ({ page }) => {
        await open(page);
        const before = await cell(page, 0, 2).boundingBox();
        const handle = page.locator('[data-resize-handle="label"]');
        const box = await handle.boundingBox();
        expect(box).toBeTruthy();

        await page.mouse.move(box!.x + 1, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + 61, box!.y + box!.height / 2, { steps: 6 });
        await page.mouse.up();

        const after = await cell(page, 0, 2).boundingBox();
        expect(after!.width).toBeGreaterThan(before!.width + 40);
    });
});

test.describe('Blackwood Table — the bidirectional pager', () => {
    test('a prepend rebases by the ITEMS added, not by the records fetched', async ({ page }) => {
        await open(page);
        await expect(page.getByTestId('item-count')).toHaveText(String(ITEM_COUNT));
        await expect(page.getByTestId('first-item-index')).toHaveText(String(FIRST_ITEM_INDEX_BASE));

        await page.getByTestId('load-older').click();

        await expect(page.getByTestId('older-count')).toHaveText(String(PREPENDED_RECORDS));
        await expect(page.getByTestId('item-count')).toHaveText(String(ITEM_COUNT + PREPENDED_ITEMS));
        // 12, not 10. Rebasing by the record count would leave the base two too high and
        // every public index — and the viewport with it — two rows out.
        await expect(page.getByTestId('first-item-index')).toHaveText(
            String(FIRST_ITEM_INDEX_BASE - PREPENDED_ITEMS),
        );

        // The page really did land ABOVE: r0 is now the eleventh addressable row, and the
        // sheet's first corner is the oldest row fetched.
        await clickCell(page, PREPENDED_RECORDS, 2);
        await expect(cell(page, PREPENDED_RECORDS, 2)).toHaveText('Item 0');
        await page.keyboard.press('Control+Home');
        await expect(active(page)).toHaveText('0,0');
        await expect(cell(page, 0, 2)).toHaveText('Older 0');

        // A second page composes with the first.
        await page.getByTestId('load-older').click();
        await expect(page.getByTestId('first-item-index')).toHaveText(
            String(FIRST_ITEM_INDEX_BASE - PREPENDED_ITEMS * 2),
        );
    });

    test('prepending older rows does not move the viewport', async ({ page }) => {
        await open(page);

        // Somewhere in the middle, so there is content above the fold for a prepend to
        // push against. The caret-follow scrolls the active row into view, so whatever it
        // lands on is on screen.
        await clickCell(page, 0, 2);
        await page.keyboard.press('PageDown');
        await page.keyboard.press('PageDown');
        await scrollSettled(page);

        const anchorRow = Number((await active(page).textContent())!.split(',')[0]);
        const label = (await cell(page, anchorRow, 2).textContent())!;
        expect(label).toMatch(/^(Item|sub) /);

        // Located by TEXT, deliberately: `data-nav-row` shifts by 10 across the prepend,
        // which is exactly the index space `firstItemIndex` exists to hold still.
        const anchor = page.getByText(label, { exact: true }).first();
        const before = await anchor.boundingBox();
        expect(before).toBeTruthy();

        await page.getByTestId('load-older').click();
        await expect(page.getByTestId('older-count')).toHaveText(String(PREPENDED_RECORDS));
        await scrollSettled(page);

        const after = await anchor.boundingBox();
        expect(after).toBeTruthy();
        // The row is still exactly where the operator left it. Without the rebase it drops
        // by the whole height of the page inserted above it — 380px here.
        expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);

        // …and a second page is the same non-event.
        await page.getByTestId('load-older').click();
        await expect(page.getByTestId('older-count')).toHaveText(String(PREPENDED_RECORDS * 2));
        await scrollSettled(page);
        expect(Math.abs((await anchor.boundingBox())!.y - before!.y)).toBeLessThan(2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────
// THE PLATFORM PASS (2026-08-19) — the four things that were in the module and
// reachable only through a prop most consumers had not supplied. Renzo: *"every part of
// the app that uses the table should also universally use the following features as
// well: the right click menu and the hover summary."*
// ─────────────────────────────────────────────────────────────────────────────────

/** The `<div>` inside a cell that carries every state class — tint, ring, box. */
const inner = (page: Page, row: number, col: number): Locator =>
    cell(page, row, col).locator('> div').first();

const classesOf = async (page: Page, row: number, col: number): Promise<string> =>
    (await inner(page, row, col).getAttribute('class')) ?? '';

/** Which sides of the selection box this cell paints. */
async function boxOf(page: Page, row: number, col: number) {
    const c = await classesOf(page, row, col);
    return {
        top: c.includes('border-t-primary'),
        right: c.includes('border-r-primary'),
        bottom: c.includes('border-b-primary'),
        left: c.includes('border-l-primary'),
    };
}

test.describe('Blackwood Table — the selection is ONE box', () => {
    test('a swept rectangle paints its perimeter and NOTHING inside it', async ({ page }) => {
        await open(page);
        // Rows 3..5 x columns 2..4, the same rectangle the drag spec sweeps.
        await clickCell(page, 3, 2);
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowRight');
        await expect(selection(page)).toHaveText('3,2,5,4');

        // Corners carry two sides each.
        expect(await boxOf(page, 3, 2)).toEqual({ top: true, right: false, bottom: false, left: true });
        expect(await boxOf(page, 3, 4)).toEqual({ top: true, right: true, bottom: false, left: false });
        expect(await boxOf(page, 5, 2)).toEqual({ top: false, right: false, bottom: true, left: true });
        expect(await boxOf(page, 5, 4)).toEqual({ top: false, right: true, bottom: true, left: false });

        // Sides carry one.
        expect(await boxOf(page, 3, 3)).toEqual({ top: true, right: false, bottom: false, left: false });
        expect(await boxOf(page, 4, 2)).toEqual({ top: false, right: false, bottom: false, left: true });

        // THE WHOLE POINT: the middle of the rectangle has no border at all — it is one
        // box, not nine. It still carries the tint, which is what it always had.
        expect(await boxOf(page, 4, 3)).toEqual({ top: false, right: false, bottom: false, left: false });
        expect(await classesOf(page, 4, 3)).toContain('bg-primary/10');

        // And the cell just outside it carries neither.
        expect(await boxOf(page, 6, 3)).toEqual({ top: false, right: false, bottom: false, left: false });
        expect(await classesOf(page, 6, 3)).not.toContain('bg-primary/10');
    });

    test('a single click paints NO box — the caret ring is the whole answer', async ({ page }) => {
        await open(page);
        await clickCell(page, 2, 3);
        await expect(selection(page)).toHaveText('2,3,2,3');

        // A plain click seeds a 1x1 selection, so this is the sheet's DEFAULT state: a
        // second rectangle a pixel inside the ring would be on screen at all times.
        expect(await boxOf(page, 2, 3)).toEqual({ top: false, right: false, bottom: false, left: false });
        const c = await classesOf(page, 2, 3);
        expect(c).toContain('ring-2');
        expect(c).toContain('ring-primary');

        // Every cell always RESERVES the gutter, so nothing shifts by a pixel when a
        // sweep reaches it — the shimmer along the perimeter of every drag.
        expect(c).toContain('border-t-transparent');
        // nav 3 is a RECORD (nav 1 and 2 are r0's children, which have no rate cell).
        expect(await classesOf(page, 3, 4)).toContain('border-l-transparent');
    });

    test('a cell CLIPS: no spill into the neighbour, no wrap onto a second line', async ({ page }) => {
        await open(page);
        const c = await classesOf(page, 0, 2);
        expect(c).toContain('overflow-hidden');
        expect(c).toContain('whitespace-nowrap');

        // MEASURED, not asserted on a class name. `label` renders a BARE STRING — the
        // shape that used to spill, because nothing in the cell was clipping it — so type
        // a value far too long for the column and check the painted layer still ends
        // inside its own `<td>`. That is what was actually broken on the QC sheet (a
        // `yyyy-MM-dd` in a 62px column painted over its neighbour) and no class name
        // proves it on its own.
        await clickCell(page, 0, 2);
        await page.keyboard.type('WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW');
        await page.keyboard.press('Enter');
        await expect(editing(page)).toHaveText('idle');

        // The content OVERFLOWS — so the clip is doing real work rather than passing
        // because the value happened to fit.
        const overflowing = await inner(page, 0, 2).evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(overflowing).toBe(true);

        const td = await cell(page, 0, 2).boundingBox();
        const layer = await inner(page, 0, 2).boundingBox();
        expect(layer!.x + layer!.width).toBeLessThanOrEqual(td!.x + td!.width + 1);
        // One line, always: the row height is declared by its family and a wrapped line
        // has nowhere to go.
        expect(layer!.height).toBeLessThanOrEqual(32);
    });
});

test.describe('Blackwood Table — the summary pill is universal', () => {
    test('the TABLE publishes SUM / COUNT to the status bar with no consumer wiring', async ({ page }) => {
        await open(page);
        // Nothing selected: the pill shows no cell section at all.
        await expect(page.getByTestId('bar-count')).toHaveText('0');

        // QTY on rows 0..2. Every 7th record carries children, so nav 0 = r0, nav 1,2 are
        // its two sub-rows with qty 1 and 2 — 10 + 1 + 2 = 13, and the pill has to total
        // what is actually THERE rather than what the consumer's own array says.
        await clickCell(page, 0, 3);
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowDown');
        await expect(selection(page)).toHaveText('0,3,2,3');

        await expect(page.getByTestId('bar-count')).toHaveText('3');
        await expect(page.getByTestId('bar-sum')).toHaveText('13');
        await expect(page.getByTestId('bar-calc')).toHaveText('SUM');

        // The REAL pill — the one in the corner of the app — reads the same numbers, and
        // nothing in the playground feeds it.
        const bar = page.locator('[data-floating-status-bar]');
        await expect(bar).toContainText('3 cells');
        await expect(bar).toContainText('13');

        // A column whose declared calc type is AVERAGE recommends AVERAGE, so the pill is
        // right about a rate lane without anyone telling it.
        await clickCell(page, 0, 4);
        await page.keyboard.press('Shift+ArrowDown');
        await expect(page.getByTestId('bar-calc')).toHaveText('AVERAGE');
    });

    test('the pill empties when the selection is cleared', async ({ page }) => {
        await open(page);
        await clickCell(page, 0, 3);
        await page.keyboard.press('Shift+ArrowDown');
        await expect(page.getByTestId('bar-count')).toHaveText('2');

        await page.keyboard.press('Escape');
        await expect(selection(page)).toHaveText('none');
        await expect(page.getByTestId('bar-count')).toHaveText('0');
        await expect(page.getByTestId('bar-sum')).toHaveText('none');
    });
});

test.describe('Blackwood Table — the built-in right-click menu', () => {
    const menu = (page: Page) => page.locator('[data-table-context-menu]');

    test('right-click opens a menu on a grid that supplied no items of its own', async ({ page }) => {
        await open(page);
        await cell(page, 3, 2).click({ button: 'right', position: { x: 8, y: 8 } });

        await expect(menu(page)).toBeVisible();
        for (const label of ['Copy', 'Copy with headers', 'Copy row', 'Select row', 'Select column']) {
            await expect(menu(page).getByText(label, { exact: true })).toBeVisible();
        }
        // The right-click also parks the caret, so the menu always acts on a known cell.
        await expect(active(page)).toHaveText('3,2');

        // Escape closes it.
        await page.keyboard.press('Escape');
        await expect(menu(page)).toHaveCount(0);
    });

    test('Copy from the menu puts the STORED value on the clipboard', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await clickCell(page, 3, 2);
        await cell(page, 3, 2).click({ button: 'right', position: { x: 8, y: 8 } });
        await menu(page).getByText('Copy', { exact: true }).click();

        await expect(menu(page)).toHaveCount(0);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Item 1');

        // The menu handed the caret back — a menu item has already unmounted when focus
        // would be restored to it, so without this the next keystroke goes nowhere.
        await page.keyboard.press('ArrowDown');
        await expect(active(page)).toHaveText('4,2');
    });

    test('Copy with headers prefixes the columns\' own labels', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('Shift+ArrowRight');
        await cell(page, 3, 2).click({ button: 'right', position: { x: 8, y: 8 } });
        await menu(page).getByText('Copy with headers', { exact: true }).click();

        // The plain `label`, never `labelNode` — a clipboard carries text.
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('LABEL\tQTY\nItem 1\t20');
    });

    test('Select column from the menu sweeps the whole column', async ({ page }) => {
        await open(page);
        await cell(page, 3, 3).click({ button: 'right', position: { x: 8, y: 8 } });
        await menu(page).getByText('Select column', { exact: true }).click();
        await expect(selection(page)).toHaveText(`0,3,${LAST_NAV_ROW},3`);
    });

    test('a READ-ONLY cell is offered no action that could change it', async ({ page }) => {
        await open(page);
        // `total` (column 6) is `cellKind: 'readonly'` — selectable, never editable.
        await cell(page, 3, 6).click({ button: 'right', position: { x: 8, y: 8 } });
        await expect(menu(page)).toBeVisible();
        await expect(menu(page).getByText('Copy', { exact: true })).toBeVisible();
        for (const label of ['Clear contents', 'Paste', 'Fill down']) {
            await expect(menu(page).getByText(label, { exact: true })).toHaveCount(0);
        }
        await page.keyboard.press('Escape');

        // An EDITABLE cell is offered all three.
        await cell(page, 3, 2).click({ button: 'right', position: { x: 8, y: 8 } });
        for (const label of ['Clear contents', 'Paste', 'Fill down']) {
            await expect(menu(page).getByText(label, { exact: true })).toBeVisible();
        }
    });

    test('Fill down copies the top row of the selection over the rest, as ONE undo', async ({ page }) => {
        await open(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowDown');
        await expect(cell(page, 4, 2)).toHaveText('Item 2');

        await cell(page, 3, 2).click({ button: 'right', position: { x: 8, y: 8 } });
        await menu(page).getByText('Fill down', { exact: true }).click();

        await expect(cell(page, 4, 2)).toHaveText('Item 1');
        await expect(cell(page, 5, 2)).toHaveText('Item 1');
        // The source row is untouched, and the whole fill is ONE gesture.
        await expect(cell(page, 3, 2)).toHaveText('Item 1');
        await expect(dirty(page)).toHaveText('2');

        await page.keyboard.press('Control+z');
        await expect(cell(page, 4, 2)).toHaveText('Item 2');
        await expect(cell(page, 5, 2)).toHaveText('Item 3');
        await expect(dirty(page)).toHaveText('0');
    });
});

test.describe('Blackwood Table — resize, wrapped headers, tinted cells', () => {
    test('a column resizes with NO consumer that persists widths', async ({ page }) => {
        await open(page);
        // The state nine of the ten migrated grids were in: no `onSettingsChange` at all,
        // and therefore — until now — no resize handle rendered anywhere on the sheet.
        await page.getByTestId('toggle-managed-widths').uncheck();

        const before = await cell(page, 0, 2).boundingBox();
        const handle = page.locator('[data-resize-handle="label"]');
        await expect(handle).toHaveCount(1);
        const box = await handle.boundingBox();

        await page.mouse.move(box!.x + 1, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + 61, box!.y + box!.height / 2, { steps: 6 });
        await page.mouse.up();

        const after = await cell(page, 0, 2).boundingBox();
        expect(after!.width).toBeGreaterThan(before!.width + 40);
    });

    test('a header may WRAP instead of truncating', async ({ page }) => {
        await open(page);
        const wrapped = page.getByTestId('wrapped-header');
        const plain = page.locator('th[data-col-key="label"] button').first();

        // The wrapping label is TALLER than a single-line one — it took a second line
        // rather than becoming `NOTE - THE LONG FORM THAT...`.
        const a = await wrapped.boundingBox();
        const b = await plain.boundingBox();
        expect(a!.height).toBeGreaterThan(b!.height);

        // `label` is still the plain string every text reader uses.
        await expect(page.locator('th[data-col-key="note"]')).toHaveAttribute('title', 'NOTE');
    });

    test('cellClass tints a WHOLE cell, and a selected one still reads as selected', async ({ page }) => {
        await open(page);
        // Off by default: a column that declares nothing pays nothing.
        expect(await classesOf(page, 3, 4)).not.toContain('bg-destructive/20');

        await page.getByTestId('toggle-tint').check();
        // The fixture's rate is `1.5 + i * 0.25`, and the column tints above 2 — so r1
        // (nav 3, rate 1.75) stays plain and r3 (nav 5, rate 2.25) is painted. The tint is
        // on the CELL, not on a pill inside it, which is exactly what could not be said
        // before this seam existed.
        expect(await classesOf(page, 3, 4)).not.toContain('bg-destructive/20');
        expect(await classesOf(page, 5, 4)).toContain('bg-destructive/20');

        // SELECTED WINS. The consumer's tint is merged UNDER the cached string, so the
        // operator can never lose the state they navigate by, however loud the paint.
        await clickCell(page, 5, 4);
        await page.keyboard.press('Shift+ArrowDown');
        expect(await classesOf(page, 5, 4)).toContain('bg-primary/10');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────
// The 2026-08-20 pass: one rectangle, a row copy that is the record, a universal sort
// and filter, a header that opens something, and a table that fills its container.
// ─────────────────────────────────────────────────────────────────────────────────

test.describe('Blackwood Table — a selection is exactly ONE rectangle', () => {
    test('the anchor keeps NO ring inside a swept range, and keeps it on a plain click', async ({ page }) => {
        await open(page);

        // A plain click: 1×1, no box, so the ring is the whole answer — byte-identical
        // with the behaviour before the perimeter existed.
        await clickCell(page, 3, 2);
        expect(await classesOf(page, 3, 2)).toContain('ring-2');

        // Sweep 3×3. The perimeter is drawn, so the anchor's own ring would be a SECOND
        // rectangle a pixel inside it — "not intended behavior".
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowRight');
        await expect(selection(page)).toHaveText('3,2,5,4');

        expect(await classesOf(page, 3, 2)).not.toContain('ring-2');
        // …and it is still visibly part of the selection, and still on the box's own
        // top-left corner. Losing the ring may not cost the tint or the perimeter.
        expect(await classesOf(page, 3, 2)).toContain('bg-primary/10');
        expect(await boxOf(page, 3, 2)).toEqual({ top: true, right: false, bottom: false, left: true });

        // Collapsing back to one cell brings the ring back.
        await clickCell(page, 4, 3);
        await expect(selection(page)).toHaveText('4,3,4,3');
        expect(await classesOf(page, 4, 3)).toContain('ring-2');
    });
});

test.describe('Blackwood Table — Copy row is the RECORD', () => {
    const menu = (page: Page) => page.locator('[data-table-context-menu]');

    test('a column that opted out of a row copy is absent from it, and present in a sweep', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await open(page);

        // `#` (the row ordinal) and the actions column both declare `rowCopy: false`:
        // neither is part of the record, and both landed in every pasted row.
        await cell(page, 3, 2).click({ button: 'right', position: { x: 8, y: 8 } });
        await menu(page).getByText('Copy row', { exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
            'R-001\tItem 1\t20\t1.75\tnote 1\t35',
        );

        // SIX fields out of EIGHT columns — the two that opted out are absent, not blank,
        // so a paste into a spreadsheet lands under the right headers.
        const payload = await page.evaluate(() => navigator.clipboard.readText());
        expect(payload.split('\t')).toHaveLength(6);
        await expect(page.locator('thead th')).toHaveCount(8);

        // A SWEPT rectangle is untouched by the rule — the operator asked for those
        // columns by dragging over them, and the copy carries exactly what was swept.
        // (That `tsvOf` never consults `rowCopy` at all is pinned in
        // `scripts/verify-table-core.ts`, where the column list can be read directly.)
        await clickCell(page, 3, 1);
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Control+c');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('R-001\tItem 1');
    });
});

test.describe('Blackwood Table — the universal sort and filter', () => {
    /** The affordances, by the attributes `HeaderCell` stamps on them. */
    const sortBtn = (page: Page, key: string) => page.locator(`[data-sort-toggle="${key}"]`);
    const filterBtn = (page: Page, key: string) => page.locator(`[data-filter-toggle="${key}"]`);

    async function enableViewTools(page: Page) {
        await page.getByTestId('toggle-view-tools').check();
        await expect(sortBtn(page, 'qty')).toHaveCount(1);
    }

    test('the ENDLESS scope offers neither by default — the window is the server\'s keyset', async ({ page }) => {
        await open(page);
        // Not merely hidden: no control is rendered at all. A client-side sort here would
        // reorder the loaded rows only, and `hasOlder`/`hasNewer` would become claims
        // about an order that no longer exists.
        await expect(page.locator('[data-sort-toggle]')).toHaveCount(0);
        await expect(page.locator('[data-filter-toggle]')).toHaveCount(0);
        await expect(page.getByTestId('table-view-strip')).toHaveCount(0);

        // A consumer may opt in, accepting the caveat.
        await enableViewTools(page);
        await expect(page.locator('[data-sort-toggle]').first()).toBeVisible();
        // …but a `derived` column still offers nothing: a row ordinal has no order.
        await expect(sortBtn(page, 'num')).toHaveCount(0);
        await expect(filterBtn(page, 'num')).toHaveCount(0);
    });

    test('a sort cycles asc → desc → off, hides the chrome rows, and restores them exactly', async ({ page }) => {
        await open(page);
        await enableViewTools(page);
        const headings = page.locator('[data-group-heading]');
        expect(await headings.count()).toBeGreaterThan(0);

        // ASC over a column that is already ascending: the row order is unchanged, and the
        // group headings are gone — a heading is a claim about a RUN, and a sort owns the run.
        await sortBtn(page, 'qty').click();
        await expect(page.getByTestId('table-view-sort')).toBeVisible();
        await expect(headings).toHaveCount(0);
        await expect(cell(page, 0, 2)).toHaveText('Item 0');

        // DESC.
        await sortBtn(page, 'qty').click();
        await expect(cell(page, 0, 2)).toHaveText('Item 119');
        await expect(cell(page, 0, 3)).toHaveText('1200');

        // OFF — and the consumer's own flatten comes back byte for byte, headings included.
        await sortBtn(page, 'qty').click();
        await expect(page.getByTestId('table-view-strip')).toHaveCount(0);
        await expect(cell(page, 0, 2)).toHaveText('Item 0');
        expect(await headings.count()).toBeGreaterThan(0);
    });

    test('a filter REMOVES rows and says how many, and Clear puts them all back', async ({ page }) => {
        await open(page);
        await enableViewTools(page);

        await filterBtn(page, 'code').click();
        // A text column offers no bounds — there is no number to bound.
        await expect(page.getByTestId('filter-min')).toHaveCount(0);
        await page.getByTestId('filter-text').fill('R-11');
        await page.getByTestId('filter-done').click();

        // `R-110`…`R-119`. `R-011` does NOT contain `R-11`, which is the point of a
        // contains rather than a fuzzy match.
        await expect(page.getByTestId('table-view-count')).toContainText('10');
        await expect(page.getByTestId('table-view-count')).toContainText('120');
        await expect(cell(page, 0, 1)).toHaveText('R-110');

        await page.getByTestId('table-view-clear').click();
        await expect(page.getByTestId('table-view-strip')).toHaveCount(0);
        await expect(cell(page, 0, 1)).toHaveText('R-000');
    });

    test('a numeric column also filters by BOUNDS, and they AND with the text box', async ({ page }) => {
        await open(page);
        await enableViewTools(page);

        await filterBtn(page, 'qty').click();
        await page.getByTestId('filter-min').fill('1190');
        await page.getByTestId('filter-done').click();

        // qty is `(i + 1) * 10`, so ≥ 1190 is Item 118 and Item 119.
        await expect(page.getByTestId('table-view-count')).toContainText('2');
        await expect(cell(page, 0, 2)).toHaveText('Item 118');

        // A second column's filter ANDs with the first.
        await filterBtn(page, 'label').click();
        await page.getByTestId('filter-text').fill('119');
        await page.getByTestId('filter-done').click();
        await expect(page.getByTestId('table-view-count')).toContainText('1');
        await expect(cell(page, 0, 2)).toHaveText('Item 119');
    });

    test('changing the view DROPS the selection rather than leaving it on other rows', async ({ page }) => {
        await open(page);
        await enableViewTools(page);
        await clickCell(page, 3, 2);
        await page.keyboard.press('Shift+ArrowDown');
        await expect(selection(page)).toHaveText('3,2,4,2');

        // The rectangle is in NAV-ROW coordinates, and a sort is exactly the operation
        // that changes which row each coordinate names.
        await sortBtn(page, 'qty').click();
        await expect(selection(page)).toHaveText('none');
        await expect(active(page)).toHaveText('none');
    });
});

test.describe('Blackwood Table — a header that opens something, and a header with two lines', () => {
    test('onHeaderClick replaces the sweep, and the sort caret stays separately clickable', async ({ page }) => {
        await open(page);
        await page.getByTestId('toggle-view-tools').check();

        // A column WITHOUT the override still sweeps, which is the unchanged default.
        await page.locator('th[data-col-key="label"] button').first().click();
        await expect(selection(page)).toHaveText(`0,2,${LAST_NAV_ROW},2`);
        await expect(page.getByTestId('header-clicked')).toHaveText('none');

        // The caret on the OVERRIDDEN column sorts, and does NOT fire the override — two
        // buttons in one cell, each keeping its own gesture.
        await page.locator('[data-sort-toggle="total"]').click();
        await expect(page.getByTestId('table-view-sort')).toContainText('TOTAL');
        await expect(page.getByTestId('header-clicked')).toHaveText('none');

        // The LABEL runs the override — and does not sweep 400 cells behind the drawer it
        // would have opened.
        await page.locator('th[data-col-key="total"] button').first().click();
        await expect(page.getByTestId('header-clicked')).toHaveText('total');
        await expect(selection(page)).toHaveText('none');
    });

    test('subLabel renders a real second line, and the header grows to hold it', async ({ page }) => {
        await open(page);
        const sub = page.locator('th[data-col-key="code"] [data-sub-label]');
        await expect(sub).toHaveText('reference');

        // Two lines, measured — not a `title` nobody sees. The comparison is against a
        // header with neither a sub-label nor `headerWrap`.
        const withSub = await page.locator('th[data-col-key="code"] button').first().boundingBox();
        const plain = await page.locator('th[data-col-key="qty"] button').first().boundingBox();
        expect(withSub!.height).toBeGreaterThan(plain!.height);

        // It is independent of `headerWrap` — this column does not set it.
        await expect(page.locator('th[data-col-key="code"]')).toHaveAttribute('title', 'CODE');
    });
});

test.describe('Blackwood Table — sizing', () => {
    const headerWidth = async (page: Page, key: string) =>
        (await page.locator(`th[data-col-key="${key}"]`).boundingBox())!.width;

    test('content STRETCHES the columns (the shipped default); fill renders them as declared', async ({ page }) => {
        await open(page);

        // `'content'` is `width: 100%` + `<col width>`, and under `table-layout: fixed` a
        // table wider than its columns scales ALL of them — which is what moved the sticky
        // offsets out from under the frozen block. Left exactly as it shipped.
        expect(await headerWidth(page, 'num')).toBeGreaterThan(50);

        await page.getByTestId('toggle-fill').check();

        // Under fill the slack goes to the scrolling columns INSIDE the resolution, so a
        // `resizable: false` pinned column renders at exactly its declared 48px — the
        // rendered width and the sticky arithmetic are now one number.
        await expect
            .poll(async () => Math.round(await headerWidth(page, 'num')))
            .toBe(48);
        expect(await headerWidth(page, 'label')).toBeGreaterThan(180);

        // And the table fits: nothing left for `table-fixed` to scale into.
        const overflow = await page.evaluate(() => {
            const s = document.querySelector('[data-blackwood-table] > div') as HTMLElement | null;
            return s ? s.scrollWidth - s.clientWidth : -1;
        });
        expect(overflow).toBeLessThanOrEqual(1);
    });
});
