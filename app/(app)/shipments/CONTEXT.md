# Shipments — Export-Doc Readiness & ZIP Download (Module Context)

## Purpose
The `/shipments` module surfaces ICTC's **export-document readiness** from the
Trello export-checklist board and lets the user **download all of a shipment's
uploaded documents as a single ZIP** (Google-Drive "download all" style, with the
files renamed to the house convention). This is **Track B** of the Trello
shipment-docs workflow (`.agents/prompts/trello-shipment-docs-workflow.md`) — the
in-app counterpart to the CLI in `scripts/trello-shipments/`.

**TENANT/domain code** (ICTC charcoal export shipments) — domain knowledge is
expected here. **No ₱ anywhere in this domain → ZERO price-gating.** Read-only
against Trello (never writes back).

## Files
- `page.tsx` — **Server Component**, the LIST. Calls `listShipments()` (the
  adapter) directly; renders one card per shipment with the readiness chip
  (`✅ Complete` / `N/M` + the missing-doc list), checklist progress bar, and
  attachment count, linking to the detail page. Newest-activity first. Catches
  adapter errors → `<ShipmentsError>`. `dynamic = "force-dynamic"`, `runtime = "nodejs"`.
- `[cardId]/page.tsx` — **Server Component**, the DETAIL. `getShipment(cardId)` →
  the customer send-out present/missing breakdown, the full attachment list under
  **canonical names** (the ported renamer), per-checklist item state, an **"Open in
  Trello"** link, and the prominent **"Download all as ZIP"** button (a plain GET
  `<a>` to the ZIP route). Each attachment row ALSO carries its own **per-file
  download** control — a small download icon-button (`<a href download>` to the
  per-file route below) in a trailing column; link-type attachments (no `bytes`) show
  a `—` instead. THREE download paths coexist (set / all / one file). Not-found →
  tasteful empty state.
  It calls `planSendOutSet()` server-side (same predicate the readiness chips render
  from, so the button's count and the ZIP's contents cannot disagree) to drive:
  **"Download send-out set · N docs"** in the send-out card's header — primary weight,
  matching "Download all as ZIP", because the set is the *more* common action; a
  **`SET` pill** in the Doc-type column of every attachment the set will take, so
  "which 7 of the 14" is answerable without downloading; an amber inline note when the
  set is partial; and a non-interactive "Nothing in the set yet" stand-in when no
  required doc is attached as a file. When `hasRequirementSet` is FALSE the button is
  **not rendered at all** — the no-set panel states the set download is unavailable
  and points at "Download all as ZIP" instead. Never a button that yields an empty ZIP.
- `[cardId]/download/[attachmentId]/route.ts` — **GET route handler**
  (`runtime = "nodejs"`). The PER-FILE counterpart to the ZIP route. Calls
  `getAttachmentForDownload(cardId, attachmentId)` (the adapter picks the attachment
  by id off the same card+attachment fetchers and returns it plus its `classify()`
  canonical name), fetches that ONE file with the **OAuth Authorization header**
  (token stays server-side), and streams it back with `Content-Type` from the
  attachment's `mimeType` and `Content-Disposition: attachment; filename="<canonical
  name>"`. **404** when the card or the attachment id isn't on that card; a link-type
  attachment (no `bytes`) also 404s. Same security posture as the ZIP route.
- `[cardId]/download/route.ts` — **GET route handler** (`runtime = "nodejs"`).
  Fetches the card's attachments with the **OAuth Authorization header** (required
  for Trello file downloads since 2021 — see `attachmentAuthHeader()`), renames each
  to its canonical filename (`classify()`), de-duplicates name collisions
  (` (2)`, ` (3)`), zips them **in-memory with `fflate`** (`level: 0` store — PDFs
  are already compressed), and returns `application/zip` with `Content-Disposition:
  attachment; filename="<card title>.zip"`. Link-type attachments (no `bytes`) are
  skipped. Errors return a plain-text body with the right status (user-initiated
  download, so a clear message is fine).
  **`?set=sendout` narrows the SAME route to the customer send-out set** — the docs
  that go to the buyer, not the internal/process ones. A search param and NOT a second
  route: the OAuth header, canonical renaming, sanitising, collision dedup and zipping
  are subtle and must have exactly one implementation, because two ZIP builders drift.
  Absent param = every attachment, byte-identical to before. An **unrecognized** value
  is a **400**, never a silent fallback to "everything". Set-mode specifics:
  - Filename `<prefix|card title> <CUSTOMER> SEND-OUT SET[ (PARTIAL n of m)].zip` from
    `sendOutZipBaseName()` — names the shipment and the customer so it can never be
    mistaken for the all-attachments ZIP.
  - **A partial set is signalled twice**: in the filename, AND by an
    `_INCOMPLETE - MISSING DOCUMENTS.txt` manifest written INTO the archive (the
    filename can be renamed or lost when the ZIP is forwarded; a file inside travels
    with it). Nothing is added when the set is complete. ASCII-only entry name on
    purpose — a non-ASCII ZIP entry needs the UTF-8 general-purpose flag to survive
    some Windows unzip tools.
  - Response headers `X-Sendout-Set` / `-Present` / `-Total` / `-Complete` (+
    `-Missing` when incomplete) make the partial state machine-detectable too.
  - **409** when the card has no requirement set (`hasRequirementSet: false`) and
    **404** when not one required doc is attached as a file — never an empty ZIP.
    Both messages name the shortfall and redirect the user to "Download all as ZIP".
- `actions.ts` — `"use server"` thin read-only pass-throughs (`listShipments`,
  `getShipment`) to the adapter. No DB, no mutations. Present as a stable server
  entry point; the page/detail server components import the adapter directly.
- `readiness-chip.tsx` — **pure, server-safe** (no `'use client'`) shared
  presentation: `ReadinessChip` (green Complete / amber N/M / muted no-set) +
  `ChecklistBar`. Reused by the list, the detail header, and the digest band.
- `shipments-error.tsx` — `'use client'` inline error banner. Per the project HARD
  RULE, error UI **persists** and exposes a **Copy** button (full error text →
  clipboard). This is the inline-banner variant (the page renders server-side, so a
  toast isn't available at first paint).
- `loading.tsx` — route skeleton matching the list shell (static pulses only, no
  row animation). Required because every `(app)` sibling inherits the digest-shaped
  skeleton otherwise (see `app/(app)/CONTEXT.md`).

## Data
- **Adapter:** `lib/shipments/trello.ts` (server-only) — read-only Trello REST
  client + high-level API: `listShipments()`, `getShipment(cardId)`,
  `getCardForDownload(cardId)` (ZIP route), `getAttachmentForDownload(cardId,
  attachmentId)` (per-file route — returns the raw attachment + its canonical name,
  or null when the card/attachment id is unknown), `attachmentAuthHeader()`,
  `getBoardId()`. Emits the
  contract in `lib/shipments/types.ts` (`ShipmentSummary`, `ShipmentDetail`,
  `ClassifiedAttachment`, `Readiness`, …).
- **Credentials resolution (server-only, never exposed to the client):**
  `process.env.TRELLO_API_KEY` / `TRELLO_TOKEN` / `TRELLO_BOARD_ID`. In DEV
  (`NODE_ENV !== 'production'`), if the env vars are absent it **falls back to
  reading `~/.config/ictc-trello/credentials.env`** (the mode-600 file the CLI uses)
  and defaults the board to `68157fe83b212306ba0ee381`. Missing creds throw
  `TrelloConfigError` (a clear, copyable message). **Vercel prod must set the env
  vars** — the dev-file fallback is gated off in production so a misconfig fails loud.
- **The "brain" (ported faithfully from the Python CLI):**
  - `lib/shipments/classify.ts` — `docType()` (attachment name → readiness label,
    tests the FULL name incl. extension) + `classify()` (name → canonical filename,
    tests the extension-stripped STEM) + `resolveCustomer()` (title → KURARAY/MAEHATA
    via aliases) + `derivePrefix()` (title → YYMMDD or null). The numbers MUST match
    `python3 scripts/trello-shipments/report.py --board <id>`.
  - `lib/shipments/requirements.ts` — the per-customer send-out doc sets (mirrors
    `scripts/trello-shipments/customer-requirements.json`) + `readiness()` returning
    `{ customer, required, present, missing, complete, … }`, plus **`planSendOutSet()`**
    and **`sendOutZipBaseName()`** — the ONE definition of "which attachments are the
    customer set", shared by the detail page and the ZIP route. Pure + client-safe.
- **The send-out selection rule (`planSendOutSet`)** — an attachment is IN when
  `docType(name)` is one of the resolved customer's required labels. Three properties
  worth not re-deciding:
  - **Two files classifying to the SAME doc type are BOTH included.** A revision and
    its original are indistinguishable from the filename alone, so picking one would
    silently withhold the copy the buyer needed. The route's existing ` (2)` dedup
    keeps their names distinct. Real case: the `260212` card carries `Non-Nego BL.pdf`
    and `Original BL.pdf` **duplicated** — all 4 ship.
  - **`absent` is strictly broader than `readiness.missing`.** A required doc attached
    to the card as a Trello LINK counts as present for readiness but has no file to
    ship, so it lands in `absent` and the ZIP is reported PARTIAL. The card's chip and
    the ZIP's count are allowed to differ; that difference IS the signal.
  - **Readiness is scored over ALL attachment names; selection only over files.** So
    the plan's numbers stay comparable with the card's own N/M.
  - **Preserved Python quirk:** `docType()` uses the full name, so van/seal docs
    (`"CAAU 789243 8 FX45493895.pdf"`) return `null` there (the `.pdf` breaks the
    `[A-Z0-9-]+$` anchor) — harmless, van/seal isn't a customer send-out doc — while
    `classify()` DOES canonically name them off the stem. Do not "fix" this.

## Key Behaviors
- **Readiness** is scored **per customer** (KURARAY / MAEHATA), resolved from the
  card title via the alias table; a card with no configured set shows "no doc set"
  and lists attachments without a score.
- **Canonical filenames** are derived from the card-title date prefix (`YYMMDD …`).
  Legacy month-name titles (`OCT 15`) carry no year → prefix `null` → canonical names
  simply omit the date (honest, not synthesized).
- **ZIP filename = the sanitized card title** (`260715 SHIPMENT KURARAY 3X50.zip`).
  The workflow's ideal folder name (`260715 - KC 3x50 5VANS (JULY)`) needs the PO
  ETD month + van count, which aren't reliably on the card — so the truthful card
  title is used and noted. The **send-out** ZIP instead leads with the YYMMDD prefix
  and names the customer (`260804 MAEHATA SEND-OUT SET.zip`); a legacy title with no
  derivable date leads with the card title rather than a synthesized one, the same
  honesty rule the canonical renamer follows.
- **Measured send-out split** (board read 2026-08-13, `260804 MH 4X8 2 VANS`, 14
  attachments → 7 in / 7 out). IN: Packing List, Commercial Invoice, CoA, Fumigation,
  BL/Non-Nego (`MEDUPH667453_C.PDF`), Certificate of Origin, Record of Weight. OUT:
  Letter of Commitment, Export Declaration, Authority To Load, Mate's Receipt, PCA
  clearance, and the 2 van/seal photos — every one an internal/process doc.
  `scripts/verify-sendout-set.ts` pins this split (and the duplicate-BL, partial-set,
  link-only and no-customer cases) to the real filenames.
- **Non-blocking digest:** the home band (`components/digest/shipments-band.tsx`) is
  its OWN async server component wrapped in `<Suspense>` in `app/(app)/page.tsx` — it
  streams in independently so a slow/down Trello never blocks the Supabase-only digest.

## Dependencies
- `lib/shipments/*` — the adapter + ported brain (this module's backend contract).
- `fflate` — in-memory ZIP (added to `package.json` for this feature).
- `server-only` — guards the adapter against client bundling.
- `components/ui/button`, `lucide-react`, `date-fns`, `@/lib/utils` (`cn`).
- Navbar: registered in `getBreadcrumb()` + the ICTC Modules dropdown
  (`components/navbar.tsx`).

## See Also
- `scripts/verify-sendout-set.ts` — framework-free assertions over `planSendOutSet()` +
  `sendOutZipBaseName()`, fixtured on the REAL attachment-name lists pulled from the
  board on 2026-08-13. Run: `npx tsx scripts/verify-sendout-set.ts`. The guard cannot be
  "`docType()` is correct" (it is a deliberate Python port, not to be "fixed"), so it is
  "the split is what we measured" — a classify.ts change that moves a customer doc out
  of the send-out set, or an internal doc into it, fails this script.
- `.agents/prompts/trello-shipment-docs-workflow.md` — the full workflow (Track A CLI
  + Track B design intent, folder-naming convention, doc taxonomy).
- `scripts/trello-shipments/` — the Track A CLI (`report.py`, `sync.py`,
  `customer-requirements.json`) this module ports server-side.
- `components/digest/CONTEXT.md` — the home-digest Shipments band.
- `CLAUDE.md` — Excel Standard, Motion & Glass, Error Toasts HARD RULE.
