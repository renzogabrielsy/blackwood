/**
 * productFingerprint.ts — THE definition of a product grade's content fingerprint and of
 * a product movement's row hash.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A FINGERPRINT AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * A product grade IS a tab in Renzo's Google Sheet, and a tab name is typed by a person.
 * So the sync has to answer a question no name can answer: *is this new tab genuinely a
 * new product, or the same product under a new name?* Answering it by name similarity is
 * exactly the mistake the Cenapro supplier subgroups refuse to make — a guess dressed as
 * a fact. So the answer is taken from CONTENT: the part of a tab that cannot change once
 * it has been written down, namely its opening balances and its first ten ledger rows.
 * Two tabs with the same fingerprint are the same product; nothing else counts as
 * evidence of a rename (see reports/products/classify.ts for the two-rung ladder).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE DEFINITION, PROVEN — NOT TWO THAT LOOK ALIKE
 * ─────────────────────────────────────────────────────────────────────────────
 * This module is THE implementation. `public.fn_product_grade_fingerprint(jsonb)` is a
 * SQL CHECK COPY of the same canonical string, so the two can be PROVEN equal rather
 * than assumed equal — the discipline `lib/sync/portable-hash.ts` established against
 * `node:crypto`. The three hexes asserted in test/products-fingerprint.test.ts were read
 * out of the live database, not out of this file.
 *
 * The canonical string (LF-joined):
 *     v1
 *     O|<STAGE>=<flecs>              one per opening, sorted by stage in BYTE order
 *     R|<date>|<STAGE>|<flec>|<kg>   one per ledger row, IN SHEET ORDER
 *
 * Two details are load-bearing:
 *  - Openings are sorted by BYTE order on both sides (`collate "C"` in SQL, the default
 *    JS string comparison here). A database collation that ignores spaces would put
 *    `OLD PROD` in a different place than JS does, and the two hashes would silently
 *    diverge on exactly one grade.
 *  - A NULL kg contributes an EMPTY field, never "0". The NULL != 0 rule reaches even
 *    here: one real row (6X50, 2025-10-03) records no kg, and hashing it as zero would
 *    make "not recorded" and "zero kilos" the same fact.
 *
 * NO PESO ANYWHERE. This feature has no price data at all, so unlike findings.ts there is
 * nothing to strip — the absence is structural, not filtered.
 */
import { createHash } from "node:crypto";

/** One opening balance as it enters the fingerprint. */
export interface FingerprintOpening {
  stage: string;
  flecs: number;
}

/** One ledger row as it enters the fingerprint. Deliberately terse keys — this object is
 *  serialised into the RPC payload and re-read by the SQL check function. */
export interface FingerprintRow {
  /** ISO date, YYYY-MM-DD. */
  d: string;
  /** Canonical stage. */
  s: string;
  /** Signed flec delta. */
  f: number;
  /** Signed kg delta, or null when the row states none. */
  kg: number | null;
}

/** The exact jsonb payload `fn_product_grade_fingerprint` consumes. */
export interface FingerprintPayload {
  v: 1;
  openings: FingerprintOpening[];
  rows: FingerprintRow[];
}

/** How many ledger rows the fingerprint reads. The first rows of a tab are the ones that
 *  never move again; later rows are appended daily and would make the fingerprint change
 *  every day, which would make it useless as identity. */
export const FINGERPRINT_ROW_COUNT = 10;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Render one number the way jsonb's text output renders it (and therefore the way the
 *  SQL check function sees it). A JS number never serialises a trailing zero, so
 *  `String(n)` and jsonb's `->>` agree for every value this worker can emit. */
function numText(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "" : String(n);
}

/**
 * Build the payload the RPC stores AND the fingerprint hashes. Openings are sorted here,
 * once, so every consumer (the hash, the SQL copy, a human reading the jsonb) sees the
 * same order.
 */
export function buildFingerprintPayload(
  openings: readonly FingerprintOpening[],
  rows: readonly FingerprintRow[],
): FingerprintPayload {
  return {
    v: 1,
    openings: [...openings]
      .map((o) => ({ stage: o.stage, flecs: o.flecs }))
      .sort((a, b) => (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0)),
    rows: rows.slice(0, FINGERPRINT_ROW_COUNT).map((r) => ({ d: r.d, s: r.s, f: r.f, kg: r.kg })),
  };
}

/** The canonical string. Exported so a failing differential test can print BOTH sides. */
export function fingerprintCanonicalString(payload: FingerprintPayload): string {
  const lines: string[] = [`v${payload.v ?? 1}`];
  for (const o of payload.openings) lines.push(`O|${o.stage}=${numText(o.flecs)}`);
  for (const r of payload.rows) {
    lines.push(`R|${r.d ?? ""}|${r.s ?? ""}|${numText(r.f)}|${numText(r.kg)}`);
  }
  return lines.join("\n");
}

/** THE fingerprint: sha256 hex of the canonical string. */
export function productGradeFingerprint(payload: FingerprintPayload): string {
  return sha256Hex(fingerprintCanonicalString(payload));
}

/**
 * THE row hash — the replace-by-grade idempotency key.
 *
 * `date | stage | flec | kg | remarks | source_row`.
 *
 * TWO THINGS ARE IN IT FOR A REASON, AND ONE IS DELIBERATELY OUT.
 *
 * IN — the source row number. The sheet legitimately carries byte-identical movements on
 * the same day (8X50 books `PROD -1 / -550 / RESIKO FROM SUNDRY` more than once across its
 * life), and without the row number those would collapse into one hash, one row would be
 * dropped, and the balance would be wrong. It is stable because the ledger is append-only
 * in practice; if a row is ever inserted in the middle, every hash below it changes and
 * the replace rewrites them — loud and correct, never a quiet duplicate.
 *
 * OUT — THE GRADE CODE, and this was a MEASURED correction rather than a preference. With
 * the grade code in the hash, every row hash changes the moment a tab is renamed. Two
 * things follow, both bad: a rename rewrites the ENTIRE ledger (127 rows deleted and
 * re-inserted on Kuraray, reported to the operator as movement when nothing moved), and —
 * far worse — rung 2 of the rename ladder becomes structurally incapable of firing, since
 * the hashes it compares are computed under two different codes and can never overlap. The
 * hash does not need the code: `product_movements` is UNIQUE on `(grade_id, row_hash)`, so
 * the grade already scopes it. Two different products sharing a row hash is fine and
 * cannot collide; a renamed product NOT sharing its own is the bug.
 */
export function productRowHash(args: {
  date: string;
  stage: string;
  flecDelta: number;
  kgDelta: number | null;
  remarks: string | null;
  sourceRow: number;
}): string {
  return sha256Hex(
    [
      args.date,
      args.stage,
      numText(args.flecDelta),
      numText(args.kgDelta),
      args.remarks ?? "",
      String(args.sourceRow),
    ].join("|"),
  );
}

/** Canonicalise a sheet tab name (or a stage name) the way the DB CHECK constraints
 *  require: upper, trimmed, runs of whitespace collapsed to one space. ONE definition,
 *  used for grade codes and stage names alike. */
export function canonicalProductToken(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}
