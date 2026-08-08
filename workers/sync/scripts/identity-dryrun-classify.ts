/**
 * identity-dryrun-classify.ts — a WRITE-FREE classify driver, used by
 * `delivery-identity-dryrun.ts` to run the FROZEN `classifyCase` contract for both
 * writers of `deliveries` against a captured DB window and real workbooks.
 *
 * It exists as its own file because the dry run must compare the NEW identity against
 * the OLD one, and the only honest way to get the OLD one is to run the OLD CODE. The
 * orchestrator copies this exact file into a pristine `git worktree` at HEAD and runs it
 * there, so both sides execute the same driver over the same inputs. That means this file
 * MUST only use the frozen `classifyCase(workbookPaths, dbWindow, opts)` signature and
 * MUST NOT import anything added by the identity change.
 *
 * It touches no database, no Gmail, no Storage and writes exactly one JSON file.
 *
 * Usage:
 *   npx tsx scripts/identity-dryrun-classify.ts <dbwindow.json> <out.json> \
 *       <deliveriesSince> <gsheetSince> <deliveriesWorkbook|-> <gsheetWorkbook|->
 */
import { readFileSync, writeFileSync } from "node:fs";

import { classifyCase as classifyDeliveriesCase } from "../src/reports/deliveries/index.js";
import { classifyCase as classifyGsheetCase } from "../src/reports/gsheet/index.js";

async function main(): Promise<void> {
  const [dbWindowPath, outPath, delSince, gsSince, delWb, gsWb] = process.argv.slice(2);
  if (!dbWindowPath || !outPath) {
    throw new Error("usage: identity-dryrun-classify.ts <dbwindow.json> <out.json> <delSince> <gsSince> <delWb|-> <gsWb|->");
  }
  const dbWindow = JSON.parse(readFileSync(dbWindowPath, "utf8")) as Record<string, unknown>;

  const deliveries = await classifyDeliveriesCase(
    delWb && delWb !== "-" ? { primary: delWb } : {},
    { deliveries: dbWindow.deliveries, batch_codes: dbWindow.batch_codes } as never,
    { since: delSince } as never,
  );

  const gsheet = await classifyGsheetCase(
    gsWb && gsWb !== "-" ? { primary: gsWb } : {},
    {
      deliveries: dbWindow.deliveries,
      rc_out: dbWindow.rc_out,
      batch_lookup: dbWindow.batch_lookup,
    } as never,
    { since: gsSince } as never,
  );

  writeFileSync(outPath, JSON.stringify({ deliveries, gsheet }, null, 2));
  process.stdout.write(`wrote ${outPath}\n`);
}

main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n");
  process.exit(1);
});
