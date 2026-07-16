# Mobile Audit 10 — Platform Chrome Sweep (navbar, login, settings, admin, edit-audit)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — goal, device matrix, verdicts, template. This is the LAST audit — the closing sweep of platform-layer chrome every other audit deliberately skipped.
2. `components/NAVBAR.md` — breadcrumb/title system, modules dropdown, right-side controls.
3. `app/(app)/admin/CONTEXT.md` — skim (likely 🖥 verdict).

**Do the work YOURSELF — no delegation.**

## Mission
Sweep the shared shell + small routes. Two of these are mobile-critical (navbar, login — nothing else works without them); the rest are graceful-degradation checks. Keep it fast: this is a checklist audit, not a design session.

## Surfaces & what to check
### Navbar (`components/navbar.tsx`) — CRITICAL
- 375px: breadcrumb (`← Back to X / Title` + description) vs center "Blackwood" vs right controls (role switcher shield, dark toggle, bell, profile) — what collapses, what overflows?
- Modules dropdown by touch; notification bell popover at phone width.
- It's always dark (`bg-zinc-800`) and `ssr:false` — any mobile flash/layout shift?
- The navbar is the natural home for a future mobile nav pattern (hamburger/sheet) — recommend one, informed by every prior audit's needs.
### `/login` — CRITICAL (and the PWA entry point)
- 375px layout; Google button tap target; post-OAuth redirect behavior on a phone browser. Cross-reference Audit 00's standalone-mode auth findings if present.
### `/settings`
- Whatever it renders (check `app/(app)/settings/`) at 375px.
### `/admin`
- Expected 🖥 DESKTOP-ONLY (user management table + invite dialog). Verify it degrades without breaking (no page h-scroll), verdict, move on.
### `/edit/[auditLogId]`
- The standalone audit-log edit page — linked from notifications, so a phone user WILL land here from a notification tap. Editing is desktop-scope, but the page must at least render readably and not trap them. Check with a real auditLogId from a notification.
### `/access-denied`, error boundaries, `loading.tsx` skeletons
- Spot-check at 375px; error states must show the Copy button usably (Error toast HARD RULE).
### Global
- Dark-mode toggle by touch; the floating status bar (if any page mounts it) at phone width; any `position: fixed` element vs iOS safe areas (coordinate with Audit 00 findings).

## Constraints
- **Audit only.** ONE result section (sub-verdict table across the surfaces) to `docs/MOBILE_UI_AUDIT.md`, tick P10.
- Admin: do NOT invite/revoke anyone. Look only.
- Dev server + browser resize; ask Renzo to log in once if needed.

## Deliverable
Standard template section + the navbar mobile-nav recommendation (≤5 lines), reply with the sub-verdict table + effort. Since this closes the series, ALSO add a short "**Series wrap-up**" note at the bottom of the audit doc: total effort by verdict class, and the suggested implementation order.
