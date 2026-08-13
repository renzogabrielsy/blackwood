// Per-customer required doc sets + the readiness computer. The config mirrors
// scripts/trello-shipments/customer-requirements.json (the CLI's source of truth);
// it is embedded here (not imported across the scripts/ boundary) so the app is
// self-contained and Next bundling stays predictable. Keep the two in sync when
// Renzo prunes/confirms a customer set. Labels MUST match classify.ts::docType().

import { docType, resolveCustomer } from "./classify";
import type { Readiness } from "./types";

interface CustomerRequirement {
  confirmed: boolean;
  docs: string[];
}

interface RequirementConfig {
  aliases: Record<string, string>;
  requirements: Record<string, CustomerRequirement>;
}

/**
 * The CUSTOMER SEND-OUT set per buyer — the docs that go to the customer, NOT
 * every internal/process doc. Seeded 2026-07-22 from completed-shipment history +
 * Renzo's 260512 KURARAY email. Both sets are confirmed. Customer resolved from
 * the card title via `aliases` (MH -> MAEHATA, KC -> KURARAY).
 */
export const REQUIREMENTS: RequirementConfig = {
  aliases: {
    KURARAY: "KURARAY",
    KC: "KURARAY",
    MAEHATA: "MAEHATA",
    MH: "MAEHATA",
  },
  requirements: {
    KURARAY: {
      confirmed: true,
      docs: ["Certificate of Origin", "Commercial Invoice", "Packing List", "Halal Certificate", "Fumigation", "BL / Non-Nego", "CoA"],
    },
    MAEHATA: {
      confirmed: true,
      docs: ["Certificate of Origin", "Commercial Invoice", "Packing List", "Fumigation", "BL / Non-Nego", "CoA", "Record of Weight"],
    },
  },
};

/**
 * Pure readiness verdict for a shipment card. Port of report.py::readiness_lines()
 * as structured data: resolve the customer, classify every attachment to its
 * doc-type, then diff the customer's required set against what's present.
 */
export function readiness(cardTitle: string, attachmentNames: string[]): Readiness {
  const { aliases, requirements } = REQUIREMENTS;
  const customer = resolveCustomer(cardTitle, aliases);
  const presentSet = new Set(
    attachmentNames.map((n) => docType(n)).filter((d): d is string => d !== null)
  );

  if (!customer || !(customer in requirements)) {
    return {
      customer,
      hasRequirementSet: false,
      confirmed: false,
      required: [],
      present: [],
      missing: [],
      complete: false,
    };
  }

  const req = requirements[customer];
  const required = req.docs;
  const present = required.filter((d) => presentSet.has(d));
  const missing = required.filter((d) => !presentSet.has(d));

  return {
    customer,
    hasRequirementSet: true,
    confirmed: req.confirmed,
    required,
    present,
    missing,
    complete: missing.length === 0,
  };
}

/** Why an attachment is NOT part of the customer send-out set. */
export type SendOutExclusionReason =
  /** Its docType() isn't in the customer's required set (internal/process doc). */
  | "not-in-set"
  /** It IS a required doc type, but it's a Trello LINK attachment — no file to ship. */
  | "not-a-file";

/** One attachment picked for the send-out set, tagged with the doc it satisfies. */
export interface SendOutPick<T> {
  item: T;
  docType: string;
}

/**
 * The deliverable plan for a shipment's customer send-out set: which attachments
 * go in, which stay behind, and which required docs have no shippable FILE.
 */
export interface SendOutSetPlan<T> {
  /** The card's readiness verdict, scored over EVERY attachment name (link or file). */
  readiness: Readiness;
  /** The attachments that make up the set. */
  selected: SendOutPick<T>[];
  /** Everything else on the card, with the reason it was left out. */
  excluded: { item: T; docType: string | null; reason: SendOutExclusionReason }[];
  /**
   * Required doc types with NO shippable file in `selected` — the honest gap in the
   * ZIP. Strictly broader than `readiness.missing`: a required doc attached only as
   * a Trello LINK counts as present for readiness but cannot be shipped, so it
   * lands here. This is the list the download must never hide.
   */
  absent: string[];
  /** Required doc types actually covered by a shippable file. */
  presentCount: number;
  /** Size of the customer's required set (0 when there is no set). */
  totalCount: number;
  /** True only when every required doc has a shippable file. */
  complete: boolean;
}

/**
 * Plan a shipment card's CUSTOMER SEND-OUT set — the subset of attachments that go
 * to the buyer, as opposed to the internal/process docs (Letter of Commitment,
 * Export Declaration, Authority To Load, Mate's Receipt, PCA clearance, van/seal
 * photos, proforma samples…) that stay with ICTC.
 *
 * Selection rule: an attachment is IN when `docType(name)` is one of the resolved
 * customer's required labels. Same predicate the readiness card renders from, so
 * the chips and the ZIP can never disagree about what "the set" means.
 *
 * TWO attachments classifying to the SAME doc type are BOTH included — a revision
 * and its original, or a duplicated upload, are indistinguishable from the filename
 * alone, and dropping one would silently withhold the copy the buyer needed. The
 * ZIP route's existing " (2)" dedup suffix keeps their names distinct.
 *
 * Pure + client-safe. `isFile` marks which items can actually be downloaded (Trello
 * link attachments carry no `bytes`); readiness is still scored over ALL names so
 * this plan's numbers can be compared against the card's own N/M.
 */
export function planSendOutSet<T>(
  cardTitle: string,
  items: T[],
  nameOf: (item: T) => string,
  isFile: (item: T) => boolean = () => true
): SendOutSetPlan<T> {
  const verdict = readiness(
    cardTitle,
    items.map((i) => nameOf(i))
  );

  if (!verdict.hasRequirementSet) {
    return {
      readiness: verdict,
      selected: [],
      excluded: items.map((item) => ({ item, docType: docType(nameOf(item)), reason: "not-in-set" })),
      absent: [],
      presentCount: 0,
      totalCount: 0,
      complete: false,
    };
  }

  const requiredSet = new Set(verdict.required);
  const selected: SendOutPick<T>[] = [];
  const excluded: SendOutSetPlan<T>["excluded"] = [];

  for (const item of items) {
    const dt = docType(nameOf(item));
    if (dt !== null && requiredSet.has(dt)) {
      if (isFile(item)) selected.push({ item, docType: dt });
      else excluded.push({ item, docType: dt, reason: "not-a-file" });
    } else {
      excluded.push({ item, docType: dt, reason: "not-in-set" });
    }
  }

  const shippable = new Set(selected.map((s) => s.docType));
  const absent = verdict.required.filter((d) => !shippable.has(d));

  return {
    readiness: verdict,
    selected,
    excluded,
    absent,
    presentCount: verdict.required.length - absent.length,
    totalCount: verdict.required.length,
    complete: absent.length === 0,
  };
}

/**
 * The download filename for a send-out set. Leads with the shipment number (or the
 * card title when the title carries no derivable YYMMDD — same honesty rule the
 * canonical renamer follows) and NAMES THE CUSTOMER, so the file is never mistaken
 * for the all-attachments ZIP. A partial set says so IN THE FILENAME: a 5-of-7 set
 * must never arrive looking like a complete one.
 */
export function sendOutZipBaseName(
  cardTitle: string,
  prefix: string | null,
  customer: string,
  presentCount: number,
  totalCount: number
): string {
  const lead = prefix ?? cardTitle.trim();
  const partial = presentCount < totalCount ? ` (PARTIAL ${presentCount} of ${totalCount})` : "";
  return `${lead} ${customer} SEND-OUT SET${partial}`;
}
