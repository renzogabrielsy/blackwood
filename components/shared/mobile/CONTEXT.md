# Shared Mobile Primitives — Archetype C

## Purpose
Platform-layer, tenant-neutral building blocks for the mobile/PWA read layer. These
are the **canonical Archetype C** implementation (dense desktop table → phone card
list) from `docs/MOBILE_UI_AUDIT.md` (Audit 04 + the "Archetype C pattern spec").
Zero domain knowledge lives here — no ₱ logic, no charcoal terms, no column names.

> **Platform code (CLAUDE.md layer rule):** everything in `components/shared/` is
> source-agnostic infrastructure. Tenant/domain shaping (which fields, price gating,
> filter dimensions) is decided by the caller in the domain module, never here.

## Files
| File | Role |
|------|------|
| `mobile-card-list.tsx` | `MobileCardList<T>` — virtualized card list + tap→bottom-Sheet detail + optional "View full table" escape hatch. The Archetype C primitive. |

## `MobileCardList<T>` API
Data-agnostic, generic over the row type `T`.

| Prop | Type | Notes |
|------|------|-------|
| `items` | `T[]` | Already filtered/sorted by the caller (single source of truth — feed it the SAME memo the desktop table uses; never refetch). |
| `getKey` | `(item: T) => string` | Stable unique key; also tracks which row's detail sheet is open. |
| `renderCard` | `(item: T) => ReactNode` | The ≤6-field headline. **Never render prices in the card.** |
| `renderDetail` | `(item: T) => ReactNode` | Full-field detail body for the bottom sheet. Caller owns ALL gating (₱ behind `canViewPrices`). Do NOT render your own `SheetHeader` — the primitive provides it. |
| `getDetailTitle?` | `(item: T) => string` | Detail-sheet title (defaults to "Details"). |
| `getDetailDescription?` | `(item: T) => string` | Detail-sheet description line. |
| `estimateSize?` | `number` | Initial card-height estimate in px (default 68). The virtualizer measures real heights after mount, so variable-height cards (with/without remarks) work. |
| `toolbar?` | `ReactNode` | Chrome pinned above the scrolling list — search, a "Filters" trigger, a segmented control. |
| `emptyState?` | `ReactNode` | Rendered instead of the list when `items` is empty. |
| `fullTableSlot?` | `ReactNode` | The desktop `<table>` (or a read-only wide table) mounted in the "View full table" sheet, in its own `overflow-auto` box. Omit to hide the escape hatch. |
| `fullTableTitle?` / `fullTableDescription?` / `fullTableLabel?` | `string` | Copy for the escape-hatch sheet + trigger. |

## Key Behaviors
- **Virtualized** via `@tanstack/react-virtual` `useVirtualizer` + `measureElement`
  (dynamic heights). Only visible cards mount — safe for thousands of rows.
- **Tap a card → full-width bottom `Sheet`** (`side="bottom"`,
  `max-h-[90dvh] rounded-t-2xl gap-0 overflow-y-auto p-0 pb-[max(1rem,env(safe-area-inset-bottom))]`,
  sticky glass header). Mirrors `components/digest/schedule-preview-mobile.tsx`.
- **Live re-read:** the open detail row is resolved from the live `items` array, so a
  refresh updates it in place (and closes the sheet if the row disappears).
- **"View full table" escape hatch:** appears only when `fullTableSlot` is passed;
  a glass footer button opens a second bottom sheet that horizontally scrolls the
  wide table (no page-level h-scroll).
- **Motion:** no per-row entrance animation (CLAUDE.md — never animate table rows).
  Sheets use the standard shadcn slide-in.

## Reuse notes (for production / cenapro / summaries / review-queue)
- Feed `items` your existing `filteredData` memo — never build a second data path.
- Decide the ≤6 headline fields per table (domain identity + one metric + location +
  status). Everything else → `renderDetail`.
- Price-gate ₱ inside `renderDetail` using the table's existing `canViewPrices`
  boolean; NEVER re-derive it and NEVER put ₱ in `renderCard`.
- Surface the desktop table's column-header filters through a mobile "Filters" Sheet
  passed via `toolbar`, driven by the SAME filter state/URL params the table uses.
- Frozen-pane matrices (RC Movement, Flecon) are **Archetype E, not C** — do not
  force this primitive on them.

## Dependencies
- `@/components/ui/sheet`, `@tanstack/react-virtual`, `@/lib/utils` (`cn`).

## See Also
- `docs/MOBILE_UI_AUDIT.md` — Audit 04 + Archetype C pattern spec (the source of truth).
- `components/digest/schedule-preview-mobile.tsx` — the precedent this generalizes.
- `app/(app)/inventory/rc-in/components/delivery-cards-mobile.tsx` — RC IN reference.
- `app/(app)/inventory/rc-out/components/rc-out-cards-mobile.tsx` — RC OUT reference.
