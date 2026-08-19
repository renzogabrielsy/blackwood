/**
 * mailClerkSlowSearch.test.ts — A SLOW GMAIL SEARCH IS A FINDING, NOT SILENCE
 * (BUG-026, 2026-08-19).
 *
 * WHY THIS EXISTS. On 2026-08-19 the RC DELIVERIES IMAP search took 58 s where it had
 * taken 4–7 s on every earlier run that day, on the identical build. Nothing was broken —
 * Gmail was slow. But from the panel a slow run and a hung run are the same picture, so
 * the run was read as hung, Stopped, and restarted 57 seconds later, which put two IMAP
 * sessions on one account and made the replacement run slower still.
 *
 * The budget therefore SPEAKS and never ABORTS. Three things are proved:
 *   1. A search past the budget emits a warn beat WHILE it is still running, and another
 *      naming the elapsed time when it lands.
 *   2. The overrun is carried out of the run in `manifest.slowSearches`, and through
 *      `reconciliation.gmail_slow_searches` becomes a real `gmail_slow_search` finding —
 *      so the Excel report and the panel record that the DAY was slow.
 *   3. A normal run's manifest is byte-identical to what it always was: `slowSearches` is
 *      ABSENT, not `[]`.
 *
 * No mailbox, no socket: the Gmail session comes from the broker's test factory.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  runMailClerk,
  mailQueries,
  GMAIL_SEARCH_BUDGET_MS,
  type MailClerkProgress,
} from "../../src/workflows/mailClerk.js";
import {
  _configureGmailSessionForTest,
  _resetGmailSessionForTest,
} from "../../src/lib/gmailSession.js";
import type { GmailClient } from "../../src/lib/gmail.js";
import { flattenRunFindings } from "../../src/reports/excel/findingsBridge.js";
import type { AppSyncRunResult } from "../../src/reports/excel/findingsBridge.js";

interface Beat {
  label: string;
  detail?: string;
  level?: string;
}

/** A client whose every search takes `delayMs`. */
function useClient(delayMs: number): void {
  const empty = { ok: true, query: "q", emailCount: 0, emails: [] };
  const slow = async (): Promise<unknown> => {
    await new Promise((r) => setTimeout(r, delayMs));
    return empty;
  };
  _configureGmailSessionForTest({
    factory: () =>
      ({
        usable: true,
        connect: async () => undefined,
        close: async () => undefined,
        searchLatestAttachment: slow,
        search: slow,
        markProcessed: async () => true,
      }) as unknown as GmailClient,
  });
}

function recorder(): { beats: Beat[]; onProgress: MailClerkProgress } {
  const beats: Beat[] = [];
  return {
    beats,
    onProgress: async (_stage, label, _pct, detail, level) => {
      beats.push({ label, detail, level });
    },
  };
}

beforeEach(() => {
  _resetGmailSessionForTest();
});

describe("Gmail search budget (BUG-026)", () => {
  it("names the slow search, records it, and still returns the reports", async () => {
    useClient(60);
    const { beats, onProgress } = recorder();

    const manifest = await runMailClerk(
      { runId: "run-A", since: "2026/08/01", dryRun: true, searchBudgetMs: 20 },
      onProgress,
    );

    // NOT aborted — every query still ran and the manifest is complete.
    expect(Object.keys(manifest.reports).sort()).toEqual(mailQueries().map((q) => q.key).sort());

    // Every query blew the 20 ms budget.
    expect(manifest.slowSearches).toBeDefined();
    expect(manifest.slowSearches).toHaveLength(mailQueries().length);
    const rcIn = manifest.slowSearches!.find((s) => s.key === "deliveries")!;
    expect(rcIn.label).toBe("RC DELIVERIES");
    expect(rcIn.budget_ms).toBe(20);
    expect(rcIn.elapsed_ms).toBeGreaterThanOrEqual(20);
    // It names the query it was running, {since} already substituted.
    expect(rcIn.query).toContain("RC DELIVERIES");
    expect(rcIn.query).toContain("2026/08/01");

    // (1) The mid-flight beat — the sentence the operator needed at 03:30 on the 19th.
    const midFlight = beats.filter((b) => /Gmail is slow today/.test(b.label));
    expect(midFlight.length).toBeGreaterThanOrEqual(1);
    expect(midFlight[0].level).toBe("warn");
    expect(midFlight[0].label).toMatch(/RC DELIVERIES/);
    expect(midFlight[0].label).toMatch(/Nothing is wrong/);

    // (2) …and the settled one, naming what it actually cost.
    const landed = beats.filter((b) => /slower than usual/.test(b.label));
    expect(landed.length).toBe(mailQueries().length);
    expect(landed[0].level).toBe("warn");
  });

  it("a normal run carries NO slowSearches key at all (not an empty array)", async () => {
    useClient(0);
    const { beats, onProgress } = recorder();
    const manifest = await runMailClerk(
      { runId: "run-A", since: "2026/08/01", dryRun: true, searchBudgetMs: 5_000 },
      onProgress,
    );
    expect("slowSearches" in manifest).toBe(false);
    expect(beats.some((b) => /slow/i.test(b.label))).toBe(false);
  });

  it("the production budget is a reporting threshold, not a timeout", () => {
    // 45 s: past the 4–7 s these searches normally take, under the 58 s that started this,
    // and far under `lib/gmail.ts`'s 5-minute socketTimeout, which remains the ONLY thing
    // that ends a true hang.
    expect(GMAIL_SEARCH_BUDGET_MS).toBe(45_000);
    expect(GMAIL_SEARCH_BUDGET_MS).toBeLessThan(5 * 60 * 1000);
  });

  it("becomes a gmail_slow_search FINDING on the run sheet", () => {
    const result = {
      reconciliation: {
        gmail_slow_searches: [
          {
            key: "deliveries",
            label: "RC DELIVERIES",
            query: 'label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:2026/08/16',
            elapsed_ms: 58_000,
            budget_ms: 45_000,
          },
        ],
      },
    } as unknown as AppSyncRunResult;

    const findings = flattenRunFindings(result);
    const f = findings.find((x) => x.kind === "gmail_slow_search");
    expect(f).toBeDefined();
    expect(f!.key).toBe("gmail_slow_search:deliveries");
    expect(f!.section).toBe("run");
    // A weather report, not an alarm — a `high` here would out-shout the findings that
    // describe genuinely missing data.
    expect(f!.severity).toBe("attention");
    expect(f!.title).toContain("RC DELIVERIES");
    expect(f!.title).toContain("58.0 s");
    expect(f!.reason).toMatch(/NOTHING IS WRONG WITH THE SYNC/);
    // And the advice that would have prevented the second IMAP session.
    expect(f!.reason).toMatch(/stopping and restarting/i);
  });

  it("a run where the mailbox behaved raises no such finding", () => {
    expect(flattenRunFindings({ reconciliation: {} } as unknown as AppSyncRunResult)).toEqual([]);
  });
});
