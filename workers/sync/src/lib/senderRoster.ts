/**
 * senderRoster.ts — WHO SENT IT IS A ROSTER, NOT AN IDENTITY (2026-08-29, L-045).
 *
 * ── THE INCIDENT ──────────────────────────────────────────────────────────────
 * MC was out of the office. Ivy (`edilloivymae306ictc@gmail.com`) sent the **Daily
 * Production Report** on his behalf on 2026-08-28 00:38 and 2026-08-29 00:24 (threads
 * `1a045ce449758d18`, `1a04ae728f2a6b82`) — correct subject, correct workbook, ~1.2 MB
 * attachment, sitting unlabelled in the inbox. The worker's search was
 *
 *     from:mccontinedo.ictc@gmail.com subject:"Daily Production Report" after:… -label:…
 *
 * so both were INVISIBLE. That one workbook carries production runs, downtime,
 * electricity AND trucks, so three streams went stale together and the run raised three
 * `stale_stream` findings while the reports it was asking for were already in the mailbox.
 * Renzo: *"sync has to take into account that sometimes Ivy sends reports for MC when MC
 * is not in the office and vice versa."*
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────
 * **The SUBJECT (plus `has:attachment` and the extractor's own structural validation)
 * identifies the report. The SENDER never does.** A `from:` clause narrows the search to
 * the office; it must never be the thing that decides whether a report exists.
 *
 * This is the same class of mistake as L-039 (`"Aug. 2026"` vs a generated
 * `"August 2026"`), L-040b (`batch_code` inside a natural key) and L-042
 * (`FEEDING # 1` vs `FEEDING AREA 1`): **a human-varying attribute — spelling, casing,
 * WHICH COLLEAGUE PRESSED SEND — must never be an identity key.** Every one of those
 * failed the same way, silently, by not recognising something that was right there.
 *
 * ── WHAT THIS FILE IS, AND IS NOT ─────────────────────────────────────────────
 * It is the ONE list of the ICTC mailboxes a daily report may legitimately arrive from,
 * and the ONE way to render that list as a Gmail `from:` clause. Both writers of a
 * sender-scoped query use it (`workflows/mailClerk.ts` and `reports/flecon/index.ts`), so
 * the two can never drift.
 *
 * It is NOT an authorisation check and NOT a provenance record:
 *   - it never rewrites, normalises or "corrects" who sent something. The manifest keeps
 *     the ACTUAL sender (`MailClerkManifest.emailMeta[].sender`), so a report Ivy sent for
 *     MC reads as Ivy — a roster widens what we LOOK for, it must never launder a fact;
 *   - it is not a guard. A wrong workbook from a roster address is caught where it always
 *     was: the subject predicate, the attachment-name predicate on the query
 *     (`MailQuery.attachmentMatches`, L-044) and the extractor's structural validation,
 *     all unchanged by this file.
 *
 * ── ADDING SOMEONE ────────────────────────────────────────────────────────────
 * Add the address here and nowhere else. Every entry below already appeared in this
 * repository before this file existed (see each `source`) — an address is never invented,
 * and a colleague who has never been documented as sending an ICTC report does not get a
 * line here just because a wider net feels safer.
 */

/** One mailbox that may legitimately send an ICTC daily report. */
export interface RosterMember {
  /** The mailbox address, lower-case. */
  address: string;
  /** The person, so a log line or a manifest reads in English. */
  person: string;
  /**
   * What this address is KNOWN to send. **Documentation, never a filter** — the whole
   * point of the roster is that any member may cover for any other.
   */
  knownFor: string;
  /** Where the address already appeared in the repo before the roster existed. */
  source: string;
}

/**
 * THE roster. Order is fixed and meaningful only in that it makes the generated query
 * string deterministic (and therefore testable).
 */
export const ICTC_SENDER_ROSTER: readonly RosterMember[] = [
  {
    address: "mccontinedo.ictc@gmail.com",
    person: "MC Continedo",
    knownFor: "Daily Production Report (runs + downtime + electricity + trucks)",
    source: "mailClerk `production_mc` query; specs/SHARED.md §1.2; specs/production.md §2",
  },
  {
    address: "edilloivymae306ictc@gmail.com",
    person: "Ivy Mae Edillo",
    knownFor: "WASTE PRODUCTION REPORT, FLECON BAGGED — and MC's report when he is out",
    source: "mailClerk `production_waste` + `flecon` queries; specs/flecon.md §2",
  },
  {
    address: "czarinaloumaximoictc@gmail.com",
    person: "Czarina Lou Maximo",
    knownFor: "RAW CHARCOAL PURCHASES -Daily (the price file)",
    source: "mailClerk `deliveries_czarina` query; specs/deliveries.md §1.3",
  },
  {
    address: "angelicagustilo26.ictc@gmail.com",
    person: "Angelica Gustilo",
    knownFor: "QC workbooks (Bagged 6x50, Prepared Charcoal 3x50) — not ingested yet",
    source: "AI_INGESTION_AGENT.md ingestion table; handoffs/2026-05-26-…md",
  },
] as const;

/** The roster as bare addresses, in declaration order. */
export const ICTC_SENDER_ADDRESSES: readonly string[] = ICTC_SENDER_ROSTER.map(
  (m) => m.address
);

/**
 * Render a Gmail `from:` clause covering the whole roster:
 * `from:(a@x OR b@x OR …)` — or `from:a@x` for a single address, which is the form
 * Gmail and every prior version of these queries already used.
 *
 * Deterministic (declaration order), so a test can assert the exact query string.
 * Throws on an empty list rather than emitting `from:()`, which Gmail would either
 * reject or — worse — quietly treat as no constraint at all.
 */
export function rosterFrom(
  addresses: readonly string[] = ICTC_SENDER_ADDRESSES
): string {
  const clean = addresses.map((a) => String(a ?? "").trim()).filter(Boolean);
  if (!clean.length) {
    throw new Error("rosterFrom: refusing to build a `from:` clause from an empty roster");
  }
  return clean.length === 1 ? `from:${clean[0]}` : `from:(${clean.join(" OR ")})`;
}

/**
 * The roster member behind a raw envelope sender (`"Ivy Mae <ivy@…>"` or a bare address),
 * or null when the sender is off-roster. Used for READING a fetched email — never for
 * deciding whether to fetch one.
 */
export function rosterMemberFor(sender: string | null | undefined): RosterMember | null {
  const raw = String(sender ?? "").toLowerCase();
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/);
  const address = (angle ? angle[1] : raw).trim();
  return ICTC_SENDER_ROSTER.find((m) => m.address === address) ?? null;
}
