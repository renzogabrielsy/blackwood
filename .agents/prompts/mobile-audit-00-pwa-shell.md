# Mobile Audit 00 — PWA Shell Readiness

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — goal, device matrix, verdict vocabulary, result template. Everything below assumes it.
2. `app/layout.tsx` + `app/(app)/layout.tsx` + `next.config.ts` — the current shell.

**Do the work YOURSELF — no delegation.** This is an AUDIT + PLAN session, not an implementation session.

## Mission
Assess what Blackwood needs to become an **installable PWA** on iPhone and iPad mini (Safari/iOS rules apply — they differ from Chrome), and produce a concrete, ordered build plan. This is the only audit in the series that is app-wide rather than per-feature.

## What to check
1. **Manifest:** does a web app manifest exist? (Almost certainly not.) Plan one: name/short_name ("Blackwood"), `display: standalone`, theme/background colors matching the zinc navbar + dark mode, start_url `/`, scope.
2. **Icons:** what exists in `app/` / `public/` today (favicon?). Plan the icon set: 180×180 apple-touch-icon (iOS ignores manifest icons for the home screen), 192/512 manifest icons, maskable variant.
3. **iOS metas:** `apple-mobile-web-app-capable`, status-bar style, viewport meta (check what Next.js emits; is `viewport-fit=cover` needed for notch safe-areas?). Check whether any fixed/sticky UI (navbar, floating status bar, sync modal) would collide with the iOS home indicator / safe-area insets — grep for `safe-area` usage (likely none).
4. **Service worker:** decide the MINIMAL viable approach. Recommendation to evaluate: no offline data (the app is useless offline anyway — Supabase-driven), just an install-qualifying SW + basic static-asset caching. Note: iOS installability does NOT require a SW, but Chrome/Android does. Evaluate `next-pwa`-style packages vs a ~30-line hand-rolled SW; the project favors minimal dependencies.
5. **Auth in standalone mode:** Google OAuth redirect flows can break in iOS standalone (opens Safari, loses the session). Investigate how `supabase.auth.signInWithOAuth` + `/auth/callback` behaves in a standalone PWA context and what the mitigation is (e.g. it may be acceptable to require login in Safari before installing). This is the highest-risk item — spend real effort here.
6. **Session longevity:** Supabase session refresh in a PWA that's been backgrounded for days — does middleware refresh cover it?

## Constraints
- **No code changes** except appending your result section to `docs/MOBILE_UI_AUDIT.md` (Audit results section) and ticking the P0 checkbox in its feature map.
- Web research is allowed (iOS PWA behavior changes by version — verify against current iOS, don't trust training data).

## Deliverable
Append to `docs/MOBILE_UI_AUDIT.md` using the standard template, PLUS an ordered implementation checklist (each item ≤ 1 line, S/M/L effort each). Then reply to the user with: the 3 biggest risks, the recommended SW approach, and the total effort estimate.
