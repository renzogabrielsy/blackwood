import { describe, it, expect } from "vitest";
import {
  RUN_REPORT_TYPES,
  runWorkflowId,
  mailClerkWorkflowId,
  reportWorkflowId,
  childWorkflowIds,
} from "../../src/workflows/ids.js";

/**
 * The workflow-ID scheme is the load-bearing contract between runSync (which STARTS
 * the workflows) and /cancel + recovery + the watchdog (which ADDRESS them). If it
 * drifts, /cancel silently cancels nothing. These pin the exact strings.
 */
describe("workflow ids", () => {
  it("parent + child ids match runSync's scheme", () => {
    expect(runWorkflowId("abc")).toBe("run:abc");
    expect(mailClerkWorkflowId("abc")).toBe("mailclerk:abc");
    expect(reportWorkflowId("abc", "gsheet")).toBe("report:abc:gsheet");
  });

  it("childWorkflowIds enumerates the mail clerk + every report child", () => {
    const ids = childWorkflowIds("abc");
    expect(ids).toContain("mailclerk:abc");
    for (const rt of RUN_REPORT_TYPES) {
      expect(ids).toContain(`report:abc:${rt}`);
    }
    // mail clerk + 6 report types, no dupes.
    expect(ids.length).toBe(1 + RUN_REPORT_TYPES.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers exactly the 6 report types runSync launches", () => {
    expect([...RUN_REPORT_TYPES].sort()).toEqual(
      ["deliveries", "flecon", "gsheet", "production", "rc_movement_audit", "rc_out"].sort(),
    );
  });
});
