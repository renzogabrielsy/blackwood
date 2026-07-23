# WORKFLOW — Trello Export-Docs → Shipments Folder Automation

Consolidated from Renzo's brief (2026-07-22). This is the DIRECTION document for a
new automation: pull scanned export documents off the Trello export-checklist
board via the REST API, rename them to the house convention, and file them into
`/Users/renzosy/Documents/1A WORK FILES/ICTC/Shipments/` — replacing the tedious
manual compile→download→rename→file loop. Written to be executed phase-by-phase
by Opus 4.8 with Renzo in the loop.

## The situation

- **Trello** houses the export documents checklist + step/process flow. Every
  document needed for an export is scanned and attached to cards, filenames =
  whatever they were uploaded as (messy).
- **The Shipments folder** is the destination of record. Renzo currently
  downloads each attachment by hand, renames it to convention, and files it.
- **No Trello MCP connector exists** (registry checked 2026-07-22) — and none is
  needed: the plain REST API covers boards/lists/cards/checklists/attachments.

## Hard safety rules (bind every phase)

1. **NEVER delete or overwrite anything.** The scripts are append-only: no `rm`,
   no move, no rewrite of an existing file. A name collision writes a suffixed
   copy (` (2)`, ` (3)`) and flags it in the run report — a human decides.
2. **Dry-run first, always.** Every run produces a PLAN (what would download,
   to which folder, under which name) that Renzo approves before any file is
   written. Only after approval does the same plan execute.
3. **Credentials are Renzo's, never Claude's.** Renzo creates the Trello API
   key + token himself and puts them in a local env file; Claude writes code
   that READS the file but never sees, asks for, or pastes the values.
4. **Idempotent by manifest.** Each run records what it downloaded (Trello
   attachment id → local path) in a manifest JSON; re-runs skip anything already
   fetched, so running twice can never duplicate or clobber.

## Observed folder conventions (from a 2026-07-22 scan — Phase 1 formalizes this)

- **Shipment folder:** `YYMMDD [- ]CUSTOMER GRADE NVANS (MONTHS)` — e.g.
  `260512 - KC 3x50 5VANS (JUNE)`, `250714 MAEHATA 8X50 2 VANS (SEPT OCT)`.
  The YYMMDD prefix sorts chronologically.
- **Multi-departure shipments** get per-van SUBFOLDERS: `250822 MAEHATA 8X50 1 VAN`.
- **File convention (the TARGET, per the newest shipment 260512):**
  `YYMMDD DOCTYPE [REFERENCE].pdf` — e.g. `260512 COMMERCIAL INVOICE.pdf`,
  `260512 CERTIFICATE OF ORIGIN 11337-26.pdf`,
  `260512 VAN # MSBU 7321849 SEAL # FX37130692.pdf`. Older folders are looser
  (mixed case, no date prefix) — the automation adopts the 260512 style; old
  folders are NEVER renamed retroactively.
- **Document taxonomy seen:** Commercial Invoice · Packing List · Certificate of
  Origin · CoA (Certificate of Analysis) · Fumigation · Halal Certificate ·
  Export & Commodity Clearance · Export Declaration · Authority to Load ·
  Letter of Commitment & Undertaking · Bill of Lading family (MEDUPH# non-nego /
  telex release / signed / draft) · LOI · Record of Weight · Van#/Seal# docs ·
  Payment receipts · Freight bill · e-Tickets · Signed P.O.

## The phases

### Phase 0 — One-time setup (RENZO, ~5 min)
1. Get a Trello API key: https://trello.com/power-ups/admin → your Power-Up /
   API key (or the classic https://trello.com/app-key page).
2. Generate a token from the key page (read scope is enough — the workflow
   never writes to Trello).
3. Create `~/.config/ictc-trello/credentials.env`, mode 600, containing
   TRELLO_API_KEY and TRELLO_TOKEN lines (mirror the Gmail-sync pattern at
   `~/.config/sync-ictc/credentials.env`).
4. Tell Claude the board (name or URL) that holds the export checklist.

> Implementation note for the script author: since 2021 Trello attachment
> downloads REQUIRE an `Authorization: OAuth oauth_consumer_key="<key>",
> oauth_token="<token>"` header — the key/token query params that work for the
> JSON API do NOT work for attachment file downloads. Build this in from day one.

### Phase 1 — Learn the conventions (CLAUDE, read-only)
1. Scan the whole Shipments tree (filenames only; read a few PDFs' names, never
   modify) and produce `NAMING_CONVENTIONS.md` next to the scripts: the
   canonical folder template, the file template, the full doc-type taxonomy
   with spelling/casing per type, per-van subfolder rules, and known aliases
   (e.g. "C.O" = Certificate of Origin, "CoA"/"COA", "FUMEGATION" typo family).
2. Renzo reviews/edits that doc — it becomes the contract the renamer follows.

### Phase 2 — Map the board (CLAUDE, read-only)
1. Small read-only script: list the board's lists → cards → checklists →
   attachments (names, sizes, dates, ids). No downloads yet.
2. Produce a BOARD MAP report: how cards correspond to shipments (one card per
   shipment? per document? per process step?), which checklist items exist,
   what attachment names look like per doc type.
3. Renzo confirms the mapping rules (e.g. "card title carries the shipment
   date+customer", "checklist item name = doc type"). These become config, not
   guesses.

### Phase 3 — The sync script (CLAUDE builds; lives in `scripts/trello-shipments/` in the blackwood repo, versioned)
1. `plan` mode (default): fetch the board state, match each attachment to
   (shipment folder, doc type, canonical filename) using the Phase-1 taxonomy +
   Phase-2 mapping; print a table: Trello card / attachment → target path +
   name, with per-file confidence. Unmatched/ambiguous attachments are listed
   under NEEDS-HUMAN, never guessed silently.
2. Renzo approves (or edits the plan file).
3. `apply` mode: download approved files (OAuth header), write to target
   folders (creating shipment folders per convention only when missing),
   append to the manifest. Collisions → suffixed copy + flag. Nothing is ever
   deleted, moved, or overwritten. End with a run report.
4. Every run is safe to repeat (manifest-idempotent).

### Phase 4 — Progress / missing-docs report (the "see progress" half)
- Same board data, different lens: per shipment card, which docs are present vs.
  MISSING → a compact "shipment readiness" report Renzo can pull any time (and
  later surface in Blackwood if it earns it).
- **The required set is PER-CUSTOMER** (Renzo, 2026-07-22) — a Certificate of
  Origin / Halal cert may be mandatory for one buyer and N/A for another. So the
  report is driven by a small config, e.g. `customer-requirements.json`:
  `{ "KURARAY": ["Certificate of Origin","Commercial Invoice","Packing List",
  "Halal Certificate","Fumigation","BL / Non-Nego","CoA"], "MAEHATA": [ ... ] }`
  (the customer send-out set, NOT every internal/process doc). Customer is
  resolved from the card title via the alias table (MH→MAEHATA, KC→KURARAY).
- **Seeding the config:** draft each customer's required set from their COMPLETED
  shipment folders + known send-out bundles (e.g. KURARAY's set = the 7 docs Renzo
  actually emailed for 260512), then Renzo prunes/corrects — the folder holds MORE
  than the customer set (internal invoices, tickets, van/seal, etc.), so the draft
  is a starting point a human confirms, never auto-authoritative.
- Output per shipment: `260715 (KURARAY) — customer set 2/7 present · MISSING:
  Certificate of Origin, Halal Certificate, Fumigation, BL/Non-Nego, CoA`. Missing
  means "not on the Trello card yet" → tells Renzo (and whoever manages the board)
  exactly what's left before a customer send-out.

### Phase 5 — Make it one command
- Wrap plan/apply/report in a small CLI (`npx tsx scripts/trello-shipments/cli.ts
  plan|apply|report`) and optionally a `/trello-shipments` skill so "sync the
  shipment docs" becomes a one-liner in future sessions.

## Track B — In-app integration (Blackwood digest board) — LATER, after Track A works

Renzo's ask (2026-07-22): surface this in the Blackwood app itself — see the
shipment docs from the digest board and **download all of a shipment's uploaded
documents compiled into a ZIP**, Google-Drive style. Explicitly phased BEHIND
the CLI track: "right now I just need Claude Code to do the downloading for me."
Track A also de-risks Track B — the board mapping, doc taxonomy, and renamer
logic built in Phases 1-3 are exactly the brain Track B reuses server-side.

Shape (design intent, to be planned properly when picked up):
- **Tenant code, not platform code**: a new ICTC module (e.g.
  `app/(app)/shipments/`) + a compact digest band linking to it — same layering
  rules as every other tenant module (navbar `getBreadcrumb()` entry,
  CONTEXT.md, price-gating N/A).
- **Server-side Trello adapter**: server actions / a route handler call the
  Trello REST API with `TRELLO_API_KEY`/`TRELLO_TOKEN` from Vercel env vars
  (never exposed client-side; attachment downloads need the OAuth
  Authorization header — same note as Phase 0). Read-only against Trello.
- **Shipment view**: per shipment card — checklist progress (which export docs
  exist / are missing, reusing Phase 4's report logic) + the attachment list
  with canonical names (reusing the Phase 1/3 renamer).
- **"Download all as ZIP"**: a route handler streams the card's attachments
  from Trello, applies canonical names, and zips them on the fly (e.g.
  `archiver` streaming — no temp storage, works within Vercel limits; if a
  shipment's total size ever exceeds serverless response limits, fall back to
  per-file downloads or chunked zips — measure first).
- The local Shipments folder remains the archive of record; the in-app ZIP is a
  convenience surface, not a replacement for Track A's filing.

## Open questions for Renzo (answered before Phase 2 → 3)

1. Which board (name/URL)? Just one, or several?
2. What does one CARD represent — a shipment, a document, or a process step?
3. Do card titles / checklist items reliably carry the shipment date + customer
   (enough to derive the YYMMDD folder), or does that context live elsewhere?
4. Multi-van shipments: is the per-van subfolder split derivable from Trello
   (separate cards/checklists per van?) or manual?
5. Should the workflow only handle NEW/active shipments going forward, or also
   backfill-check older boards against the existing folders?

## Explicitly out of scope (for now)
- Writing anything to Trello (comments, checklist ticks) — read-only v1.
- Renaming/reorganizing EXISTING files in old shipment folders.
- OCR/content-based classification of scans — filename + card/checklist context
  first; only escalate if that proves insufficient.
