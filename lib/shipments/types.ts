// Types for the Trello export-shipment adapter (Track B of the shipment-docs
// workflow). TENANT/domain code — ICTC charcoal export shipments. No ₱ anywhere
// in this domain, so nothing here is price-gated.

/** A raw Trello attachment (subset of fields we request). */
export interface TrelloAttachment {
  id: string;
  name: string;
  bytes: number | null;
  mimeType: string | null;
  url: string;
  date: string | null;
}

/** A raw Trello checklist with its items. */
export interface TrelloChecklist {
  id: string;
  name: string;
  items: { name: string; complete: boolean }[];
  done: number;
  total: number;
}

/** Canonical doc-type label emitted by `docType()` (the readiness taxonomy). */
export type DocTypeLabel = string;

/** One attachment enriched with its canonical name + doc-type classification. */
export interface ClassifiedAttachment {
  id: string;
  originalName: string;
  /** Canonical filename per the house convention (from `classify()`). */
  canonicalName: string;
  /** The `classify()` "kind" tag (e.g. "commercial invoice", "van/seal"). */
  kind: string;
  /** The `docType()` readiness label, or null when uncounted. */
  docType: DocTypeLabel | null;
  bytes: number | null;
  mimeType: string | null;
  url: string;
}

/** Per-customer readiness verdict for a shipment card. */
export interface Readiness {
  /** Resolved customer (KURARAY / MAEHATA) or null when unrecognized. */
  customer: string | null;
  /** True when we have a requirement set for this customer. */
  hasRequirementSet: boolean;
  /** Whether the customer's requirement set is confirmed (vs draft). */
  confirmed: boolean;
  /** Required doc-type labels for this customer (empty if no set). */
  required: DocTypeLabel[];
  /** Required docs present on the card. */
  present: DocTypeLabel[];
  /** Required docs still missing from the card. */
  missing: DocTypeLabel[];
  /** True when every required doc is present. */
  complete: boolean;
}

/** Summary row for the shipments LIST page (one per Trello card). */
export interface ShipmentSummary {
  cardId: string;
  title: string;
  shortUrl: string | null;
  lastActivity: string | null;
  /** 6-digit YYMMDD prefix derived from the title, or null. */
  prefix: string | null;
  attachmentCount: number;
  readiness: Readiness;
  /** Aggregate checklist progress across all checklists on the card. */
  checklist: { done: number; total: number };
}

/** Full detail payload for a single shipment card. */
export interface ShipmentDetail {
  cardId: string;
  title: string;
  shortUrl: string | null;
  lastActivity: string | null;
  prefix: string | null;
  readiness: Readiness;
  checklists: TrelloChecklist[];
  attachments: ClassifiedAttachment[];
}
