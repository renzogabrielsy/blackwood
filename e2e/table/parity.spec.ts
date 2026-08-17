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
// Group spacers are NOT addressable, so they never appear in that numbering — which is
// the whole point of them.
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
