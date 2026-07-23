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
